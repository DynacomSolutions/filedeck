import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import type { AddressInfo } from "node:net";
import { createHub } from "../src/hub.ts";
import { loadConfig } from "../src/config.ts";
import { checkPassword, hashPassword, hashPasswordAsync } from "../src/auth/store.ts";
import { SourceGrants } from "../src/auth/source-grants.ts";
import { keyFingerprint, loginMessage } from "../src/auth/sshkey.ts";
import { lockOut } from "../src/auth/admin-routes.ts";
import { COOKIE } from "../src/auth/routes.ts";
import type { SourceBackend } from "../src/sources/types.ts";
import { USER_HEADER, verifyClaim, type Identity, type UserClaim } from "../src/auth/identity.ts";

/**
 * Administrators create, change and delete virtual accounts and their keys (part 3, Task 5). Each change goes through `accountChanged`
 * after the store has committed it; a change that would leave no administrator who can sign in (FILEDECK_ADMINS empty) is refused, and
 * the check and the write run in one store transaction, so two at once cannot both pass. Names are checked against the system users the
 * machines know. No response holds a password hash; no response or audit line holds a key's text.
 */

const T = "agent-secret-admin-accounts";
const PW = "a-long-password-1";
const PW2 = "another-password-2";
let tmp = "";
const servers: http.Server[] = [];
const hubs: { close(): Promise<void> }[] = [];

before(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "filedeck-admin-accounts-")));
  fs.writeFileSync(path.join(tmp, "index.html"), "<!doctype html><title>t</title>");
  fs.writeFileSync(path.join(tmp, "bootstrap.json"), JSON.stringify({ name: "vadmin", passwordHash: hashPassword(PW) }));
});
after(async () => {
  for (const h of hubs) await h.close().catch(() => {});
  for (const s of servers) {
    s.close();
    s.closeAllConnections();
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});

/**
 * A fake agent. It answers the account lookup from `users` (a name missing there gets 503: no answer), keeps the highest epoch it has
 * seen per `kind:name` and answers a lower one with 401 `account changed` (as the real agent does), lists no jobs, and records every
 * claim it gets.
 */
interface Fake {
  url: string;
  users: Record<string, boolean>;
  seen: Map<string, number>;
  claims: { path: string; claim: UserClaim }[];
  /** while set, the account lookup waits for it before it answers */
  lookupGate?: Promise<void>;
  /** while set, an archive listing waits for it, then answers that the password it got opened the file */
  archiveGate?: Promise<void>;
  /** called when an archive listing arrives */
  onArchive?: () => void;
  /** called when an account lookup arrives */
  onLookup?: () => void;
}
/** A promise and the function that resolves it. */
function gate(): { wait: Promise<void>; open: () => void } {
  let open = () => {};
  const wait = new Promise<void>((r) => (open = r));
  return { wait, open };
}
/** Waits (at most 5 s) until `ok()` holds. */
async function until(ok: () => boolean): Promise<void> {
  for (const end = Date.now() + 5_000; !ok(); ) {
    assert.ok(Date.now() < end, "timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}
async function fakeAgent(): Promise<Fake> {
  const f: Fake = { url: "", users: {}, seen: new Map(), claims: [] };
  const srv = http.createServer((req, res) => {
    let body = "";
    req.on("data", (d: Buffer) => (body += d.toString()));
    req.on("end", async () => {
      const u = new URL(req.url ?? "/", "http://x");
      res.setHeader("content-type", "application/json");
      if (u.pathname === "/healthz") return void res.end("ok");
      if (u.pathname === "/api/auth/lookup") {
        f.onLookup?.();
        if (f.lookupGate) await f.lookupGate;
        const name = (JSON.parse(body || "{}") as { name?: string }).name ?? "";
        if (!Object.hasOwn(f.users, name)) {
          res.statusCode = 503;
          return void res.end(JSON.stringify({ error: "account lookup failed" }));
        }
        return void res.end(JSON.stringify({ exists: f.users[name] }));
      }
      const v = req.headers[USER_HEADER];
      const claim = typeof v === "string" ? verifyClaim(v, T, Date.now()) : null;
      if (claim) {
        f.claims.push({ path: u.pathname, claim });
        const k = `${claim.kind}:${claim.name}`;
        const seen = f.seen.get(k);
        if (seen !== undefined && claim.epoch < seen) {
          res.statusCode = 401;
          return void res.end(JSON.stringify({ error: "account changed" }));
        }
        f.seen.set(k, claim.epoch);
      }
      if (u.pathname === "/api/jobs") return void res.end(JSON.stringify({ jobs: [] }));
      if (u.pathname === "/api/archive/list") {
        f.onArchive?.();
        if (f.archiveGate) await f.archiveGate;
        res.setHeader("x-filedeck-pw", req.headers["x-filedeck-password"] ? "ok" : "none");
        return void res.end(JSON.stringify({ entries: [] }));
      }
      res.end(JSON.stringify({ entries: [] }));
    });
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  servers.push(srv);
  f.url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  return f;
}

/** A network source that is never used here: only its name and type matter. */
const source = { type: "sftp", ping: async () => {}, close: async () => {} } as unknown as SourceBackend;

type Hub = ReturnType<typeof createHub>;
interface World {
  h: Hub;
  a: Fake;
  b: Fake;
  lines: string[];
  changed: Identity[];
  grants: SourceGrants;
}
let n = 0;
async function world(env: Record<string, string> = {}, shared?: { a: Fake; b: Fake; file: string }): Promise<World> {
  n++;
  const a = shared?.a ?? (await fakeAgent());
  const b = shared?.b ?? (await fakeAgent());
  const lines: string[] = [];
  const h = createHub(
    loadConfig({
      FILEDECK_MODE: "hub",
      FILEDECK_AUTH: "on",
      FILEDECK_AGENT_TOKEN: T,
      FILEDECK_STATIC: tmp,
      NODES: `a=${a.url},b=${b.url}`,
      FILEDECK_ADMINS: "",
      FILEDECK_BOOTSTRAP_ADMIN_FILE: path.join(tmp, "bootstrap.json"),
      FILEDECK_AUTH_FILE: shared?.file ?? path.join(tmp, `auth-${n}.db`),
      FILEDECK_DIFF_DIR: path.join(tmp, `diff-${n}`),
      FILEDECK_VAULT_FILE: path.join(tmp, `vault-${n}.db`),
      ...env,
    } as never),
    { s1: source },
    (l) => lines.push(l),
    { streamCheckMs: 60_000 },
  );
  hubs.push(h);
  // every change is seen here, with the identity from before it (the hub's admin routes read app.accountChanged at each call)
  const changed: Identity[] = [];
  const orig = h.accountChanged;
  h.accountChanged = async (before) => {
    changed.push(structuredClone(before));
    return orig(before);
  };
  return { h, a, b, lines, changed, grants: new SourceGrants(h.auth!.db) };
}

const peer = { incoming: { socket: { remoteAddress: "127.0.0.1", encrypted: false } } };
interface Res {
  status: number;
  text: string;
  json: any; // eslint-disable-line @typescript-eslint/no-explicit-any
}
/** Every answer in this file is checked here: none may hold a password hash or a password. */
async function send(h: Hub, method: string, p: string, cookie?: string, body?: unknown): Promise<Res> {
  const r = await h.request(
    "https://localhost" + p,
    { method, headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...(cookie ? { cookie } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) },
    peer as never,
  );
  const text = await r.text();
  assert.doesNotMatch(text, /scrypt\$/, `${method} ${p}: a password hash in the answer`);
  assert.ok(!text.includes(PW) && !text.includes(PW2), `${method} ${p}: a password in the answer`);
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: r.status, text, json };
}

async function signIn(h: Hub, name: string, pw = PW): Promise<string> {
  const r = await h.request("https://localhost/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name, password: pw }) }, peer as never);
  assert.equal(r.status, 200, `sign-in of ${name}: ${await r.clone().text()}`);
  return (r.headers.get("set-cookie") ?? "").split(";")[0]!;
}
async function signInFails(h: Hub, name: string, pw = PW): Promise<void> {
  const r = await h.request("https://localhost/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name, password: pw }) }, peer as never);
  assert.equal(r.status, 401, `sign-in of ${name} should fail`);
}

interface Key {
  line: string;
  b64: string;
  privateKey: KeyObject;
}
function sshKey(): Key {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const raw = Buffer.from(publicKey.export({ format: "jwk" }).x as string, "base64url");
  const str = (d: Buffer) => {
    const l = Buffer.alloc(4);
    l.writeUInt32BE(d.length);
    return Buffer.concat([l, d]);
  };
  const b64 = Buffer.concat([str(Buffer.from("ssh-ed25519")), str(raw)]).toString("base64");
  return { line: `ssh-ed25519 ${b64}`, b64, privateKey };
}
/** Key sign-in through the real routes: the status of the last step, and the cookie when it passed. */
async function keySignIn(h: Hub, name: string, k: Key): Promise<{ status: number; cookie?: string }> {
  const post = (p: string, body: unknown) => h.request("https://localhost" + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }, peer as never);
  const { challenge, hubId } = (await (await post("/api/auth/challenge", { name })).json()) as { challenge: string; hubId: string };
  const signature = sign(null, loginMessage(hubId, name, Buffer.from(challenge, "base64")), k.privateKey).toString("base64");
  const r = await post("/api/auth/login-key", { name, publicKey: k.line, challenge, signature });
  return { status: r.status, ...(r.status === 200 ? { cookie: (r.headers.get("set-cookie") ?? "").split(";")[0]! } : {}) };
}

const share = { a: { runAs: "guest", grants: [{ path: "/srv/share", write: false }] } };
const NO_ADMIN = { error: "this would leave no administrator who can sign in" };

test("create and list: a new account can sign in and sees only its machines; no answer holds a hash", async () => {
  const w = await world();
  const { h } = w;
  const admin = await signIn(h, "vadmin");
  const r = await send(h, "POST", "/api/admin/accounts", admin, { name: "guest", password: PW2, nodes: share, sources: { s1: { write: false } } });
  assert.equal(r.status, 201, r.text);
  const view = { name: "guest", admin: false, hasPassword: true, keys: [], nodes: share, sources: { s1: { write: false } }, sessions: 0 };
  assert.deepEqual(r.json, view);
  const list = await send(h, "GET", "/api/admin/accounts", admin);
  assert.equal(list.status, 200);
  assert.deepEqual(
    list.json.accounts.map((x: { name: string }) => x.name),
    ["guest", "vadmin"],
  );
  assert.deepEqual(list.json.accounts[0], view);
  assert.equal(list.json.accounts[1].hasPassword, true);
  assert.equal(list.json.accounts[1].sessions, 1);
  assert.deepEqual(list.json.system, []);
  const guest = await signIn(h, "guest", PW2);
  const nodes = await send(h, "GET", "/api/nodes", guest);
  assert.deepEqual(
    nodes.json.nodes.map((x: { name: string }) => x.name),
    ["a"],
  );
  assert.match(h.auth!.accounts.get("guest")!.passwordHash!, /^scrypt\$15\$8\$1\$[A-Za-z0-9+/]{22}==\$[A-Za-z0-9+/]{43}=$/);
  // a second account of the same name: 409; it leaves the live account's saved passwords alone
  h.vault.put("a", "/srv/share/keep.zip", "zip-secret", { owner: "virt:guest" });
  const again = await send(h, "POST", "/api/admin/accounts", admin, { name: "guest", password: PW2 });
  assert.equal(again.status, 409);
  assert.deepEqual(again.json, { error: "exists" });
  // bad input: 400 with the checker's text; nothing is made
  for (const body of [{ name: "Bad Name" }, { name: "root" }, { name: "x1", password: "short" }, { name: "x2", nodes: { zz: share.a } }, { name: "x3", sources: { nope: { write: true } } }, { name: "x4", admin: "yes" }, { name: "x5", keys: ["not a key"] }]) {
    const bad = await send(h, "POST", "/api/admin/accounts", admin, body);
    assert.equal(bad.status, 400, JSON.stringify(body));
    assert.equal(typeof bad.json.error, "string");
  }
  assert.equal(h.auth!.accounts.list().length, 2);
  assert.equal(h.vault.list("virt:guest").length, 1, "a create that lost with exists wiped nothing");
  // the system list: a system user with a source grant shows there
  w.grants.setForAccount("sys", "bob", { s1: { write: true } });
  const sys = await send(h, "GET", "/api/admin/accounts", admin);
  assert.deepEqual(sys.json.system, [{ name: "bob", admin: false, sources: { s1: { write: true } }, sessions: 0 }]);
  assert.equal(w.changed.length, 0, "a new account changes nobody");
});

test("two creates at once: the one that loses with exists, after the early check, forgets none of the winner's saved passwords", async () => {
  const w = await world();
  const { h } = w;
  const admin = await signIn(h, "vadmin");
  w.a.users = { visitor: false, guest: true };
  w.b.users = { visitor: false, guest: true };
  let asked = 0;
  const lookups = (k: number) => until(() => asked >= k);
  w.a.onLookup = () => asked++;
  // the first create waits at machine a's lookup (gate 1), after the early "exists" check
  const g1 = gate();
  w.a.lookupGate = g1.wait;
  const first = send(h, "POST", "/api/admin/accounts", admin, { name: "visitor", nodes: share });
  await lookups(1);
  // the second also passes the early check (nothing is made yet) and waits at both machines (gate 2)
  const g2 = gate();
  w.a.lookupGate = g2.wait;
  w.b.lookupGate = g2.wait;
  const second = send(h, "POST", "/api/admin/accounts", admin, { name: "visitor", nodes: share });
  await lookups(2);
  g1.open();
  assert.equal((await first).status, 201);
  // the new account saves a password; then the second create loses inside its transaction
  h.vault.put("a", "/srv/share/keep.zip", "zip-secret", { owner: "virt:visitor" });
  g2.open();
  const lost = await second;
  assert.equal(lost.status, 409, lost.text);
  assert.deepEqual(lost.json, { error: "exists" });
  assert.equal(h.vault.list("virt:visitor").length, 1, "the create that lost wiped the winner's saved passwords");
  w.a.lookupGate = undefined;
  w.b.lookupGate = undefined;
});

test("name checks: a name a machine knows as a system user is refused; no answer does not block; a missing run-as user is refused", async () => {
  const w = await world();
  const { h } = w;
  const admin = await signIn(h, "vadmin");
  w.a.users = { alice: false, guest: true };
  w.b.users = { alice: true, guest: true };
  const clash = await send(h, "POST", "/api/admin/accounts", admin, { name: "alice", password: PW2 });
  assert.equal(clash.status, 409);
  assert.deepEqual(clash.json, { error: "a system user has this name on b" });
  assert.equal(h.auth!.accounts.get("alice"), undefined);
  // carol: neither machine answers about her (503), so nothing blocks the name
  const carol = await send(h, "POST", "/api/admin/accounts", admin, { name: "carol", password: PW2, nodes: share });
  assert.equal(carol.status, 201, carol.text);
  // a run-as user that machine a says does not exist
  w.a.users = { dave: false, nobody2: false };
  w.b.users = { dave: false };
  const runAs = await send(h, "POST", "/api/admin/accounts", admin, { name: "dave", password: PW2, nodes: { a: { runAs: "nobody2", grants: [{ path: "/srv", write: true }] } } });
  assert.equal(runAs.status, 400);
  assert.deepEqual(runAs.json, { error: "run-as user nobody2 does not exist on a" });
  assert.equal(h.auth!.accounts.get("dave"), undefined);
  // the same rule when a change sets machines
  const patch = await send(h, "PATCH", "/api/admin/accounts/carol", admin, { nodes: { a: { runAs: "nobody2", grants: [{ path: "/srv", write: true }] } } });
  assert.equal(patch.status, 400);
  assert.deepEqual(h.auth!.accounts.get("carol")!.nodes, share);
});

test("edit ends sessions and jobs: changed gets the identity from before; the old cookie is refused; the new grants reach the machine", async () => {
  const w = await world();
  const { h } = w;
  const admin = await signIn(h, "vadmin");
  assert.equal((await send(h, "POST", "/api/admin/accounts", admin, { name: "guest", password: PW2, nodes: share })).status, 201);
  const guest = await signIn(h, "guest", PW2);
  assert.equal((await send(h, "GET", "/api/nodes/a/api/fs/lsdir?path=/srv/share", guest)).status, 200);
  const before = h.auth!.accounts.identity("virt", "guest")!;
  const nodes = { a: { runAs: "guest", grants: [{ path: "/srv/other", write: true }, { path: "/srv/share", write: false }] }, b: { runAs: "guest", grants: [{ path: "/data", write: false }] } };
  const r = await send(h, "PATCH", "/api/admin/accounts/guest", admin, { nodes });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.json.nodes, nodes);
  assert.equal(w.changed.length, 1);
  assert.deepEqual(w.changed[0], before);
  // the account's jobs were asked for on a (the machine it had), at the new epoch
  const jobs = w.a.claims.filter((c) => c.path === "/api/jobs" && c.claim.name === "guest");
  assert.ok(jobs.length >= 1);
  assert.ok(jobs.every((c) => c.claim.epoch > before.epoch));
  assert.equal((await send(h, "GET", "/api/auth/me", guest)).status, 401, "the old cookie");
  const again = await signIn(h, "guest", PW2);
  assert.equal((await send(h, "GET", "/api/nodes/a/api/fs/lsdir?path=/srv/other", again)).status, 200);
  const last = w.a.claims.at(-1)!.claim;
  assert.equal(last.name, "guest");
  assert.deepEqual(last.grants, nodes.a.grants);
  // a new password (hashed before the store transaction) signs in, the old one no longer; the old session ends
  const set = await send(h, "PATCH", "/api/admin/accounts/guest", admin, { password: PW });
  assert.equal(set.status, 200);
  assert.equal(w.changed.length, 2);
  assert.equal((await send(h, "GET", "/api/auth/me", again)).status, 401);
  await signInFails(h, "guest", PW2);
  const third = await signIn(h, "guest", PW);
  assert.match(h.auth!.accounts.get("guest")!.passwordHash!, /^scrypt\$15\$8\$1\$[A-Za-z0-9+/]{22}==\$[A-Za-z0-9+/]{43}=$/);
  // a removal ends sessions too; the change shows as hasPassword
  const pw = await send(h, "PATCH", "/api/admin/accounts/guest", admin, { password: null });
  assert.equal(pw.status, 200);
  assert.equal(pw.json.hasPassword, false);
  assert.equal(w.changed.length, 3);
  assert.equal((await send(h, "GET", "/api/auth/me", third)).status, 401);
  await signInFails(h, "guest", PW);
  // unknown name: 404; nothing to change: 400
  assert.equal((await send(h, "PATCH", "/api/admin/accounts/nobody", admin, { admin: true })).status, 404);
  assert.equal((await send(h, "PATCH", "/api/admin/accounts/guest", admin, {})).status, 400);
  assert.equal(w.changed.length, 3);
});

test("keys: an added key signs in, a removed one no longer; no answer or audit line holds the key's text", async () => {
  const w = await world();
  const { h } = w;
  const admin = await signIn(h, "vadmin");
  assert.equal((await send(h, "POST", "/api/admin/accounts", admin, { name: "guest", nodes: share })).status, 201);
  assert.equal((await keySignIn(h, "guest", sshKey())).status, 401);
  const k = sshKey();
  const fp = keyFingerprint(k.line)!;
  const add = await send(h, "POST", "/api/admin/accounts/guest/keys", admin, { publicKey: k.line + " guest@laptop" });
  assert.equal(add.status, 200, add.text);
  assert.deepEqual(add.json.keys, [{ fingerprint: fp, type: "ssh-ed25519", comment: "guest@laptop" }]);
  assert.equal(w.changed.length, 1);
  const s = await keySignIn(h, "guest", k);
  assert.equal(s.status, 200);
  // the same key again, with another comment: refused
  const dup = await send(h, "POST", "/api/admin/accounts/guest/keys", admin, { publicKey: k.line + " other" });
  assert.equal(dup.status, 409);
  assert.deepEqual(dup.json, { error: "key already added" });
  assert.equal(w.changed.length, 1);
  // no such key: 404
  assert.equal((await send(h, "DELETE", `/api/admin/accounts/guest/keys/${encodeURIComponent(keyFingerprint(sshKey().line)!)}`, admin)).status, 404);
  const del = await send(h, "DELETE", `/api/admin/accounts/guest/keys/${encodeURIComponent(fp)}`, admin);
  assert.equal(del.status, 200, del.text);
  assert.deepEqual(del.json.keys, []);
  assert.equal(w.changed.length, 2);
  assert.equal((await send(h, "GET", "/api/auth/me", s.cookie)).status, 401, "the key's session ended");
  assert.equal((await keySignIn(h, "guest", k)).status, 401);
  // keys given when the account is made
  const k2 = sshKey();
  const made = await send(h, "POST", "/api/admin/accounts", admin, { name: "kuser", keys: [k2.line] });
  assert.equal(made.status, 201);
  assert.equal(made.json.hasPassword, false);
  assert.deepEqual(made.json.keys, [{ fingerprint: keyFingerprint(k2.line), type: "ssh-ed25519" }]);
  assert.equal((await keySignIn(h, "kuser", k2)).status, 200);
  for (const b64 of [k.b64, k2.b64]) {
    for (const l of w.lines) assert.ok(!l.includes(b64) && !l.includes(b64.slice(20, 50)), "a key's text in an audit line");
  }
  // the audit lines name the key by its fingerprint
  assert.ok(w.lines.some((l) => l.includes(fp) && l.includes("/api/admin/accounts/guest/keys")));
});

test("keys: at most 32 per account", async () => {
  const w = await world();
  const { h } = w;
  const admin = await signIn(h, "vadmin");
  assert.equal((await send(h, "POST", "/api/admin/accounts", admin, { name: "guest" })).status, 201);
  for (let i = 0; i < 32; i++) h.auth!.accounts.addKey("guest", sshKey().line);
  const r = await send(h, "POST", "/api/admin/accounts/guest/keys", admin, { publicKey: sshKey().line });
  assert.equal(r.status, 409);
  assert.equal(h.auth!.accounts.keys("guest").length, 32);
  assert.equal(w.changed.length, 0);
});

test("delete forgets: saved passwords, source grants and sessions of the account go", async () => {
  const w = await world();
  const { h } = w;
  const admin = await signIn(h, "vadmin");
  assert.equal((await send(h, "POST", "/api/admin/accounts", admin, { name: "guest", password: PW2, nodes: share, sources: { s1: { write: true } } })).status, 201);
  const guest = await signIn(h, "guest", PW2);
  h.vault.put("a", "/srv/share/f.zip", "zip-secret", { owner: "virt:guest" });
  h.vault.put("a", "/srv/share/g.zip", "zip-secret", { owner: "virt:other" });
  assert.equal(h.vault.list("virt:guest").length, 1);
  const before = h.auth!.accounts.identity("virt", "guest")!;
  const r = await send(h, "DELETE", "/api/admin/accounts/guest", admin);
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.json, { ok: true });
  assert.equal(h.auth!.accounts.get("guest"), undefined);
  assert.equal(h.vault.list("virt:guest").length, 0);
  assert.equal(h.vault.list("virt:other").length, 1, "only the account's own");
  assert.deepEqual(w.grants.forAccount("virt", "guest"), {});
  assert.equal((await send(h, "GET", "/api/auth/me", guest)).status, 401);
  assert.deepEqual(w.changed, [before]);
  assert.equal((await send(h, "DELETE", "/api/admin/accounts/guest", admin)).status, 404);
});

test("re-created name starts clean: no keys, grants or saved passwords, and an epoch above the old one on every machine", async () => {
  const w = await world();
  const { h } = w;
  const admin = await signIn(h, "vadmin");
  const body = { name: "guest", password: PW2, nodes: share, sources: { s1: { write: true } }, keys: [sshKey().line] };
  assert.equal((await send(h, "POST", "/api/admin/accounts", admin, body)).status, 201);
  const old = await signIn(h, "guest", PW2);
  assert.equal((await send(h, "GET", "/api/nodes/a/api/fs/lsdir?path=/srv/share", old)).status, 200);
  h.vault.put("a", "/srv/share/f.zip", "zip-secret", { owner: "virt:guest" });
  // a few changes first, so the old epoch is above 0
  assert.equal((await send(h, "PATCH", "/api/admin/accounts/guest", admin, { admin: false })).status, 200);
  const oldEpoch = h.auth!.accounts.epochOf("virt", "guest");
  assert.ok(oldEpoch >= 1);
  const seenBefore = w.a.seen.get("virt:guest")!;
  assert.equal((await send(h, "DELETE", "/api/admin/accounts/guest", admin)).status, 200);
  // the retired epoch is above the live one before the delete (`remove` keeps it one above; the delete's own raise adds one more)
  const retired = h.auth!.accounts.epochOf("virt", "guest");
  assert.ok(retired > oldEpoch, `retired at ${retired}, ${oldEpoch} before the delete`);
  assert.ok(retired > seenBefore, "the retired epoch is above every epoch the machine saw before the delete");
  const made = await send(h, "POST", "/api/admin/accounts", admin, { name: "guest", password: PW2, nodes: share });
  assert.equal(made.status, 201);
  assert.ok(h.auth!.accounts.epochOf("virt", "guest") > retired, "a name made again starts above the retired epoch");
  assert.deepEqual(made.json, { name: "guest", admin: false, hasPassword: true, keys: [], nodes: share, sources: {}, sessions: 0 });
  assert.deepEqual(h.auth!.accounts.keys("guest"), []);
  assert.deepEqual(w.grants.forAccount("virt", "guest"), {});
  assert.equal(h.vault.list("virt:guest").length, 0);
  assert.ok(h.auth!.accounts.epochOf("virt", "guest") > w.a.seen.get("virt:guest")!, "above every epoch the machine has seen");
  const fresh = await signIn(h, "guest", PW2);
  const r = await send(h, "GET", "/api/nodes/a/api/fs/lsdir?path=/srv/share", fresh);
  assert.equal(r.status, 200, r.text);
  assert.ok(oldEpoch < w.a.seen.get("virt:guest")!);
});

test("last admin: the only one cannot lose its flag, its password (no key) or its account; with two, one may go", async () => {
  const w = await world();
  const { h } = w;
  const admin = await signIn(h, "vadmin");
  for (const [m, body] of [
    ["PATCH", { admin: false }],
    ["PATCH", { password: null }],
    ["DELETE", undefined],
  ] as const) {
    const r = await send(h, m, "/api/admin/accounts/vadmin", admin, body);
    assert.equal(r.status, 409, `${m} ${JSON.stringify(body)}`);
    assert.deepEqual(r.json, NO_ADMIN);
  }
  const a = h.auth!.accounts.get("vadmin")!;
  assert.equal(a.admin, true);
  assert.notEqual(a.passwordHash, null);
  assert.equal(w.changed.length, 0);
  assert.equal((await send(h, "GET", "/api/auth/me", admin)).status, 200, "nothing changed, the session holds");
  // with a key, the password may go; then the last key may not
  const k = sshKey();
  const added = await send(h, "POST", "/api/admin/accounts/vadmin/keys", admin, { publicKey: k.line });
  assert.equal(added.status, 200);
  const viaKey = (await keySignIn(h, "vadmin", k)).cookie!;
  assert.equal((await send(h, "PATCH", "/api/admin/accounts/vadmin", viaKey, { password: null })).status, 200);
  const viaKey2 = (await keySignIn(h, "vadmin", k)).cookie!;
  const lastKey = await send(h, "DELETE", `/api/admin/accounts/vadmin/keys/${encodeURIComponent(keyFingerprint(k.line)!)}`, viaKey2);
  assert.equal(lastKey.status, 409);
  assert.deepEqual(lastKey.json, NO_ADMIN);
  assert.equal(h.auth!.accounts.keys("vadmin").length, 1);
  // a second administrator who can sign in: the first delete passes, the second is refused
  assert.equal((await send(h, "POST", "/api/admin/accounts", viaKey2, { name: "vadmin2", password: PW2, admin: true })).status, 201);
  assert.equal((await send(h, "DELETE", "/api/admin/accounts/vadmin2", viaKey2)).status, 200);
  const second = await send(h, "DELETE", "/api/admin/accounts/vadmin", viaKey2);
  assert.equal(second.status, 409);
  assert.deepEqual(second.json, NO_ADMIN);
  // an administrator who cannot sign in does not count
  assert.equal((await send(h, "POST", "/api/admin/accounts", viaKey2, { name: "nocreds", admin: true })).status, 201);
  assert.equal((await send(h, "DELETE", "/api/admin/accounts/vadmin", viaKey2)).status, 409);
});

/** A session made straight in the store, for an administrator who has no password and no key (so it does not count as one who can sign in). */
function keeper(h: Hub, name = "keeper"): string {
  if (!h.auth!.accounts.get(name)) h.auth!.accounts.create({ name, admin: true, nodes: {} });
  return `${COOKIE}=${h.auth!.sessions.create("virt", name)}`;
}

test("last admin, at once: two deletes of the last two administrators sent together; exactly one passes", async () => {
  const w = await world();
  const { h } = w;
  h.auth!.accounts.create({ name: "vadmin2", password: PW2, admin: true, nodes: {} });
  const cookie = keeper(h);
  const [r1, r2] = await Promise.all([send(h, "DELETE", "/api/admin/accounts/vadmin", cookie), send(h, "DELETE", "/api/admin/accounts/vadmin2", cookie)]);
  assert.deepEqual([r1.status, r2.status].sort(), [200, 409]);
  const left = h.auth!.accounts.list().filter((a) => a.admin && a.passwordHash !== null);
  assert.equal(left.length, 1);
  assert.equal(w.changed.length, 1);
});

// Both hubs run in this one process, so this shows that no `await` comes between the check and the write, each on its own connection
// to the shared file. It cannot tell BEGIN from BEGIN IMMEDIATE: the lock between two processes is the BEGIN IMMEDIATE in auth/tx.ts.
test("last admin, at once: two hubs on one store (a rollout), each deleting one of the last two", async () => {
  const first = await world();
  const file = path.join(tmp, `auth-shared-${n}.db`);
  const w1 = await world({}, { a: first.a, b: first.b, file });
  const w2 = await world({}, { a: first.a, b: first.b, file });
  w1.h.auth!.accounts.create({ name: "vadmin2", password: PW2, admin: true, nodes: {} });
  const cookie = keeper(w1.h);
  const [r1, r2] = await Promise.all([send(w1.h, "DELETE", "/api/admin/accounts/vadmin", cookie), send(w2.h, "DELETE", "/api/admin/accounts/vadmin2", cookie)]);
  assert.deepEqual([r1.status, r2.status].sort(), [200, 409]);
  assert.equal(w2.h.auth!.accounts.list().filter((a) => a.admin && a.passwordHash !== null).length, 1);
});

test("system admins exist: with FILEDECK_ADMINS set, the only virtual administrator may be deleted", async () => {
  const w = await world({ FILEDECK_ADMINS: "alice" });
  const { h } = w;
  const admin = await signIn(h, "vadmin");
  // a virtual account may not take a system administrator's name
  assert.equal((await send(h, "POST", "/api/admin/accounts", admin, { name: "alice", password: PW2 })).status, 400);
  const sys = await send(h, "GET", "/api/admin/accounts", admin);
  assert.deepEqual(sys.json.system, [{ name: "alice", admin: true, sources: {}, sessions: 0 }]);
  assert.equal((await send(h, "PATCH", "/api/admin/accounts/vadmin", admin, { password: null })).status, 200);
  const r = await send(h, "DELETE", "/api/admin/accounts/vadmin", keeper(h));
  assert.equal(r.status, 200, r.text);
  assert.equal(h.auth!.accounts.get("vadmin"), undefined);
});

test("lockOut on its own", async () => {
  const w = await world();
  const { h } = w;
  const cfg = loadConfig({ FILEDECK_MODE: "hub", FILEDECK_STATIC: tmp, NODES: "a=http://127.0.0.1:9", FILEDECK_ADMINS: "" } as never);
  const acc = h.auth!.accounts;
  assert.equal(lockOut(cfg, acc, { name: "vadmin", admin: false }), true);
  assert.equal(lockOut(cfg, acc, { name: "vadmin", password: null }), true);
  assert.equal(lockOut(cfg, acc, { name: "vadmin", deleted: true }), true);
  assert.equal(lockOut(cfg, acc, { name: "vadmin", admin: true }), false);
  assert.equal(lockOut(cfg, acc, { name: "vadmin", keysLeft: 0 }), false, "it still has its password");
  acc.addKey("vadmin", sshKey().line);
  assert.equal(lockOut(cfg, acc, { name: "vadmin", password: null }), false, "it still has a key");
  assert.equal(lockOut(cfg, acc, { name: "vadmin", password: null, keysLeft: 0 }), true);
  const withSys = loadConfig({ FILEDECK_MODE: "hub", FILEDECK_STATIC: tmp, NODES: "a=http://127.0.0.1:9", FILEDECK_ADMINS: "alice" } as never);
  assert.equal(lockOut(withSys, acc, { name: "vadmin", deleted: true }), false);
});

/** An archive listing through the hub with a typed password the hub is asked to save. */
function listArchive(h: Hub, cookie: string, file: string) {
  return h.request(
    `https://localhost/api/nodes/a/api/archive/list?path=${encodeURIComponent(file)}`,
    { headers: { cookie, "x-filedeck-password": Buffer.from("zip-secret-1").toString("base64"), "x-filedeck-save": "forever" } },
    peer as never,
  );
}

test("re-created name starts clean: a password typed just before a delete, or a change, is not saved when the agent answers late", async () => {
  const w = await world();
  const { h } = w;
  const admin = await signIn(h, "vadmin");
  assert.equal((await send(h, "POST", "/api/admin/accounts", admin, { name: "guest", password: PW2, nodes: share })).status, 201);
  const guest = await signIn(h, "guest", PW2);
  // without a race the typed password is saved for the account
  assert.equal((await listArchive(h, guest, "/srv/share/plain.zip")).status, 200);
  assert.equal(h.vault.list("virt:guest").length, 1);
  // the agent holds its answer while the account is deleted and made again
  const g = gate();
  w.a.archiveGate = g.wait;
  const arrived = new Promise<void>((r) => (w.a.onArchive = r));
  const late = listArchive(h, guest, "/srv/share/late.zip");
  await arrived;
  assert.equal((await send(h, "DELETE", "/api/admin/accounts/guest", admin)).status, 200);
  assert.equal((await send(h, "POST", "/api/admin/accounts", admin, { name: "guest", password: PW2, nodes: share })).status, 201);
  g.open();
  await (await late).text();
  assert.deepEqual(h.vault.list("virt:guest"), [], "the old account's password went to the new one");
  // the same when the account is only changed meanwhile: the request belongs to the old epoch
  const fresh = await signIn(h, "guest", PW2);
  const g2 = gate();
  w.a.archiveGate = g2.wait;
  const arrived2 = new Promise<void>((r) => (w.a.onArchive = r));
  const late2 = listArchive(h, fresh, "/srv/share/late2.zip");
  await arrived2;
  assert.equal((await send(h, "PATCH", "/api/admin/accounts/guest", admin, { admin: false })).status, 200);
  g2.open();
  await (await late2).text();
  assert.deepEqual(h.vault.list("virt:guest"), []);
});

test("re-created name starts clean: create forgets saved passwords left under the name", async () => {
  const w = await world();
  const { h } = w;
  const admin = await signIn(h, "vadmin");
  h.vault.put("a", "/srv/share/f.zip", "zip-secret", { owner: "virt:ghost" });
  assert.equal((await send(h, "POST", "/api/admin/accounts", admin, { name: "ghost", password: PW2 })).status, 201);
  assert.deepEqual(h.vault.list("virt:ghost"), []);
});

test("an administrator demoted or signed out while the machines are asked gets 403, and nothing is written", async () => {
  const w = await world();
  const { h } = w;
  h.auth!.accounts.create({ name: "vadmin2", password: PW2, admin: true, nodes: {} });
  h.auth!.accounts.create({ name: "carol", password: PW2, admin: false, nodes: {} });
  for (const f of [w.a, w.b]) f.users = { guest: true, newbie: false };
  /** Sends one change while the lookups wait, runs `meanwhile`, then lets the lookups answer. */
  const held = async (cookie: string, method: string, p: string, body: unknown, meanwhile: () => Promise<void> | void) => {
    const g = gate();
    w.a.lookupGate = g.wait;
    const asked = new Promise<void>((r) => (w.a.onLookup = r));
    const r = send(h, method, p, cookie, body);
    await asked;
    await meanwhile();
    g.open();
    const out = await r;
    w.a.lookupGate = undefined;
    return out;
  };
  // demoted in the store while a create waits on the machines
  let cookie = await signIn(h, "vadmin2", PW2);
  const post = await held(cookie, "POST", "/api/admin/accounts", { name: "newbie", password: PW2, nodes: share }, () => h.auth!.accounts.update("vadmin2", { admin: false }));
  assert.equal(post.status, 403, post.text);
  assert.deepEqual(post.json, { error: "administrators only" });
  assert.equal(h.auth!.accounts.get("newbie"), undefined);
  // the same for a change of machines
  h.auth!.accounts.update("vadmin2", { admin: true });
  const patch = await held(cookie, "PATCH", "/api/admin/accounts/carol", { nodes: share }, () => h.auth!.accounts.update("vadmin2", { admin: false }));
  assert.equal(patch.status, 403, patch.text);
  assert.deepEqual(h.auth!.accounts.get("carol")!.nodes, {});
  // signed out meanwhile: the session no longer holds
  h.auth!.accounts.update("vadmin2", { admin: true });
  cookie = await signIn(h, "vadmin2", PW2);
  const out = await held(cookie, "POST", "/api/admin/accounts", { name: "newbie", password: PW2, nodes: share }, async () => {
    assert.equal((await send(h, "POST", "/api/auth/logout", cookie)).status, 200);
  });
  assert.equal(out.status, 403, out.text);
  assert.equal(h.auth!.accounts.get("newbie"), undefined);
  assert.equal(w.changed.length, 0);
});

test("the epoch rises in the store transaction itself: old sessions end even when accountChanged never runs", async () => {
  const w = await world();
  const { h } = w;
  const admin = await signIn(h, "vadmin");
  assert.equal((await send(h, "POST", "/api/admin/accounts", admin, { name: "guest", password: PW2, nodes: share })).status, 201);
  // a hub that stops right after the commit: accountChanged never runs
  h.accountChanged = async () => {};
  const k = sshKey();
  for (const [method, p, body] of [
    ["PATCH", "/api/admin/accounts/guest", { admin: false }],
    ["POST", "/api/admin/accounts/guest/keys", { publicKey: k.line }],
    ["DELETE", `/api/admin/accounts/guest/keys/${encodeURIComponent(keyFingerprint(k.line)!)}`, undefined],
  ] as const) {
    const guest = await signIn(h, "guest", PW2);
    const e = h.auth!.accounts.epochOf("virt", "guest");
    assert.equal((await send(h, method, p, admin, body)).status, 200, `${method} ${p}`);
    assert.equal(h.auth!.accounts.epochOf("virt", "guest"), e + 1);
    assert.equal((await send(h, "GET", "/api/auth/me", guest)).status, 401, `${method} ${p}: the old session`);
  }
  // and the new epoch is one the machine takes (above every one it has seen)
  const guest = await signIn(h, "guest", PW2);
  assert.equal((await send(h, "GET", "/api/nodes/a/api/fs/lsdir?path=/srv/share", guest)).status, 200);
});

test("delete: saved passwords that cannot be forgotten are logged, and the account's work still ends", async () => {
  const w = await world();
  const { h } = w;
  const admin = await signIn(h, "vadmin");
  assert.equal((await send(h, "POST", "/api/admin/accounts", admin, { name: "guest", password: PW2, nodes: share })).status, 201);
  const forget = h.vault.forgetAll;
  h.vault.forgetAll = () => {
    throw new Error("disk full");
  };
  const logged: string[] = [];
  const err = console.error;
  console.error = (...a: unknown[]) => void logged.push(a.join(" "));
  try {
    const r = await send(h, "DELETE", "/api/admin/accounts/guest", admin);
    assert.equal(r.status, 200, r.text);
  } finally {
    console.error = err;
    h.vault.forgetAll = forget;
  }
  assert.equal(h.auth!.accounts.get("guest"), undefined, "the store change stands");
  assert.equal(w.changed.length, 1, "accountChanged still ran");
  assert.ok(logged.some((l) => l.includes("virt:guest") && l.includes("disk full")), logged.join("\n"));
});

test("hashPasswordAsync: the stored format of hashPassword, and it checks", async () => {
  const h = await hashPasswordAsync(PW);
  assert.match(h, /^scrypt\$15\$8\$1\$[A-Za-z0-9+/]{22}==\$[A-Za-z0-9+/]{43}=$/);
  assert.equal(hashPassword(PW).split("$").slice(0, 4).join("$"), h.split("$").slice(0, 4).join("$"));
  assert.equal(checkPassword(PW, h), true);
  assert.equal(checkPassword(PW2, h), false);
  assert.notEqual(await hashPasswordAsync(PW), h, "a new salt each time");
});
