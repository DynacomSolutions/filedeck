import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { generateKeyPairSync } from "node:crypto";
import { Hono } from "hono";
import { createHub } from "../src/hub.ts";
import { loadConfig } from "../src/config.ts";
import { Vault } from "../src/vault.ts";
import { adminBody } from "../src/audit.ts";
import { isAdmin, registerAdmin } from "../src/auth/admin-routes.ts";
import { Accounts, AuthDb } from "../src/auth/store.ts";
import { Sessions } from "../src/auth/sessions.ts";
import { SourceGrants } from "../src/auth/source-grants.ts";
import { keyFingerprint } from "../src/auth/sshkey.ts";
import { runAs } from "../src/auth/context.ts";
import type { Identity } from "../src/auth/identity.ts";
import type { SystemAuth } from "../src/auth/routes.ts";

/**
 * The admin gate (part 3, Task 4): every /api/admin/ call needs a session whose account is an administrator at that very moment (read
 * from the store and FILEDECK_ADMINS on each call), and every call, GET too, writes one audit line without secrets. The routes here list
 * and end sessions and forget the saved passwords kept from before sign-in was on.
 */

const T = "agent-secret-admin";
const TOKEN = "du-token-" + "z".repeat(30);
const PW = "a-long-password-1";
let tmp = "";
const hubs: { close(): Promise<void> }[] = [];

before(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "filedeck-admin-")));
  fs.writeFileSync(path.join(tmp, "index.html"), "<!doctype html><title>t</title>");
});
after(async () => {
  for (const h of hubs) await h.close().catch(() => {});
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** A system sign-in that accepts `alice` (an administrator through FILEDECK_ADMINS) and `bob` with PW. */
const fakeSystem: SystemAuth = {
  password: async (name, pw) => (name === "alice" || name === "bob") && pw === PW,
  key: async () => false,
};

type Hub = ReturnType<typeof createHub>;
const peer = { incoming: { socket: { remoteAddress: "127.0.0.1", encrypted: false } } };
let n = 0;
function makeHub(env: Record<string, string> = {}, lines: string[] = []): Hub {
  n++;
  const h = createHub(
    loadConfig({
      FILEDECK_MODE: "hub",
      FILEDECK_AUTH: "on",
      FILEDECK_AGENT_TOKEN: T,
      FILEDECK_STATIC: tmp,
      NODES: "a=http://127.0.0.1:9",
      FILEDECK_ADMINS: "alice",
      FILEDECK_AUTH_FILE: path.join(tmp, `auth-${n}.db`),
      FILEDECK_DIFF_DIR: path.join(tmp, `diff-${n}`),
      ...env,
    } as never),
    undefined,
    (l) => lines.push(l),
    { system: fakeSystem, streamCheckMs: 60_000 },
  );
  hubs.push(h);
  // a virtual administrator and a virtual account that is not one, made straight in the store (no machines, so a change asks none)
  h.auth!.accounts.create({ name: "vadmin", password: PW, admin: true, nodes: {} });
  h.auth!.accounts.create({ name: "vuser", password: PW, admin: false, nodes: {} });
  return h;
}

const call = (h: Hub, p: string, cookie?: string, init: RequestInit = {}) =>
  h.request(
    "https://localhost" + p,
    { ...init, headers: { ...(init.body ? { "content-type": "application/json" } : {}), ...(init.headers as Record<string, string>), ...(cookie ? { cookie } : {}) } },
    peer as never,
  );
const send = (h: Hub, method: string, p: string, cookie: string, body?: unknown) => call(h, p, cookie, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

/** Signs in through the real route and gives back the cookie. */
async function signIn(h: Hub, name: string): Promise<string> {
  const r = await call(h, "/api/auth/login", undefined, { method: "POST", body: JSON.stringify({ name, password: PW }) });
  assert.equal(r.status, 200, `sign-in of ${name}: ${await r.clone().text()}`);
  const set = r.headers.get("set-cookie") ?? "";
  return set.split(";")[0]!;
}

function edLine(comment = ""): string {
  const { publicKey } = generateKeyPairSync("ed25519");
  const raw = Buffer.from(publicKey.export({ format: "jwk" }).x as string, "base64url");
  const str = (d: Buffer) => {
    const l = Buffer.alloc(4);
    l.writeUInt32BE(d.length);
    return Buffer.concat([l, d]);
  };
  const blob = Buffer.concat([str(Buffer.from("ssh-ed25519")), str(raw)]);
  return `ssh-ed25519 ${blob.toString("base64")}${comment}`;
}

const auditOf = (lines: string[], method: string, route: string) =>
  lines.map((l) => JSON.parse(l) as Record<string, unknown>).filter((l) => l.audit === true && l.method === method && l.route === route);

test("administrators only: a non-admin, a caller without a session and the du token are refused; both kinds of admin pass", async () => {
  const h = makeHub({ FILEDECK_API_TOKEN: TOKEN, FILEDECK_API_TOKEN_ACCOUNT: "alice" });
  const user = await signIn(h, "vuser");
  const bob = await signIn(h, "bob");
  for (const cookie of [user, bob]) {
    const r = await call(h, "/api/admin/overview", cookie);
    assert.equal(r.status, 403);
    assert.deepEqual(await r.json(), { error: "administrators only" });
  }
  // without a session the sign-in gate answers first, as for every /api/ route: signed out, never the admin data
  const none = await call(h, "/api/admin/overview");
  assert.equal(none.status, 401);
  assert.equal(none.headers.get("x-filedeck-auth"), "signed-out");
  // the du token, even when it acts as a system administrator, is refused (it may only read folder sizes)
  const tok = await call(h, "/api/admin/overview", undefined, { headers: { "x-filedeck-token": TOKEN } });
  assert.equal(tok.status, 403);
  assert.doesNotMatch(await tok.text(), /nodes|systemAdmins/);
  for (const name of ["alice", "vadmin"]) {
    const r = await call(h, "/api/admin/overview", await signIn(h, name));
    assert.equal(r.status, 200, name);
    assert.deepEqual(await r.json(), { nodes: ["a"], sources: [], systemAdmins: ["alice"], unownedPasswords: 0 });
  }
  // an admin path that does not exist: 403 for a non-admin (the gate comes first), 404 JSON for an admin, never the web app
  assert.equal((await call(h, "/api/admin/nope", user)).status, 403);
  const nope = await call(h, "/api/admin/nope", await signIn(h, "alice"));
  assert.equal(nope.status, 404);
  assert.deepEqual(await nope.json(), { error: "not found" });
});

test("administrators only: the gate itself refuses an identity without a session (as the du token would carry)", async () => {
  const db = new AuthDb(":memory:");
  const accounts = new Accounts(db);
  const sessions = new Sessions(db, accounts, { idleMs: 60_000, maxMs: 3_600_000 });
  const cfg = loadConfig({ FILEDECK_MODE: "hub", FILEDECK_STATIC: tmp, NODES: "a=http://127.0.0.1:9", FILEDECK_ADMINS: "alice" } as never);
  const app = new Hono();
  const alice: Identity = { kind: "sys", name: "alice", admin: true, epoch: 0 };
  app.use("*", (_c, next) => runAs(alice, next));
  let changed = 0;
  registerAdmin(app, {
    cfg,
    accounts,
    sessions,
    sourceGrants: new SourceGrants(db),
    vault: new Vault(),
    nodes: ["a"],
    sources: [],
    changed: async () => void changed++,
  });
  for (const [m, p] of [
    ["GET", "/api/admin/overview"],
    ["GET", "/api/admin/sessions"],
    ["POST", "/api/admin/end-sessions"],
    ["DELETE", "/api/admin/vault/unowned"],
  ] as const) {
    const r = await app.request(p, { method: m, headers: { "content-type": "application/json" }, ...(m === "POST" ? { body: JSON.stringify({ kind: "sys", name: "bob" }) } : {}) });
    assert.equal(r.status, 403, `${m} ${p}`);
    assert.deepEqual(await r.json(), { error: "administrators only" });
  }
  assert.equal(changed, 0);
  db.close();
});

test("isAdmin reads FILEDECK_ADMINS and the stored flag, not the identity's own", () => {
  const db = new AuthDb(":memory:");
  const accounts = new Accounts(db);
  const cfg = loadConfig({ FILEDECK_MODE: "hub", FILEDECK_STATIC: tmp, NODES: "a=http://127.0.0.1:9", FILEDECK_ADMINS: "alice" } as never);
  accounts.create({ name: "v", password: PW, admin: false, nodes: {} });
  assert.equal(isAdmin(cfg, accounts, undefined), false);
  assert.equal(isAdmin(cfg, accounts, { kind: "sys", name: "alice", admin: false, epoch: 0 }), true);
  assert.equal(isAdmin(cfg, accounts, { kind: "sys", name: "bob", admin: true, epoch: 0 }), false);
  assert.equal(isAdmin(cfg, accounts, { kind: "virt", name: "v", admin: true, epoch: 0, nodes: {} }), false);
  accounts.update("v", { admin: true });
  assert.equal(isAdmin(cfg, accounts, { kind: "virt", name: "v", admin: false, epoch: 0, nodes: {} }), true);
  // a virtual account named like a system administrator is not one
  assert.equal(isAdmin(cfg, accounts, { kind: "virt", name: "alice", admin: true, epoch: 0, nodes: {} }), false);
  assert.equal(isAdmin(cfg, accounts, { kind: "virt", name: "gone", admin: true, epoch: 0, nodes: {} }), false);
  db.close();
});

test("admin checked on every call: a flag taken away in the store refuses the same cookie at once", async () => {
  const h = makeHub();
  const cookie = await signIn(h, "vadmin");
  assert.equal((await call(h, "/api/admin/overview", cookie)).status, 200);
  // straight in the store, around accountChanged on purpose: the session still holds
  h.auth!.accounts.update("vadmin", { admin: false });
  const r = await call(h, "/api/admin/overview", cookie);
  assert.equal(r.status, 403);
  assert.deepEqual(await r.json(), { error: "administrators only" });
  assert.equal((await call(h, "/api/auth/me", cookie)).status, 200, "the session itself still holds");
  for (const [m, p] of [
    ["GET", "/api/admin/sessions"],
    ["DELETE", "/api/admin/vault/unowned"],
  ] as const)
    assert.equal((await send(h, m, p, cookie)).status, 403, `${m} ${p}`);
  // and given back, it works again with the same cookie
  h.auth!.accounts.update("vadmin", { admin: true });
  assert.equal((await call(h, "/api/admin/overview", cookie)).status, 200);
});

test("auth off: /api/admin/ answers 404", async () => {
  const h = createHub(loadConfig({ FILEDECK_MODE: "hub", FILEDECK_STATIC: tmp, NODES: "a=http://127.0.0.1:9", FILEDECK_ADMINS: "alice" } as never), undefined, () => {});
  hubs.push(h);
  for (const [m, p] of [
    ["GET", "/api/admin/overview"],
    ["GET", "/api/admin/sessions"],
    ["DELETE", "/api/admin/vault/unowned"],
    ["POST", "/api/admin/end-sessions"],
  ] as const) {
    const r = await h.request("http://localhost" + p, { method: m });
    assert.equal(r.status, 404, `${m} ${p}`);
  }
  assert.equal(h.vault.list().length, 0);
});

test("sessions: listed with current on the caller's; ending one leaves the account's other session; an unknown id is 404", async () => {
  const h = makeHub();
  const mine = await signIn(h, "alice");
  const other = await signIn(h, "alice");
  const user = await signIn(h, "vuser");
  const r = await call(h, "/api/admin/sessions", mine);
  assert.equal(r.status, 200);
  const { sessions } = (await r.json()) as { sessions: { id: string; kind: string; name: string; current?: true; address?: string }[] };
  assert.equal(sessions.length, 3);
  const cur = sessions.filter((s) => s.current);
  assert.equal(cur.length, 1, "exactly one is marked as the caller's");
  assert.equal(cur[0]!.name, "alice");
  for (const s of sessions) {
    assert.match(s.id, /^[0-9a-f]{32}$/);
    assert.equal(s.address, "127.0.0.1");
  }
  const raw = (c: string) => c.slice(c.indexOf("=") + 1);
  const otherId = h.auth!.sessions.publicId(h.auth!.sessions.keyOf(raw(other)));
  const userId = h.auth!.sessions.publicId(h.auth!.sessions.keyOf(raw(user)));
  assert.ok(sessions.some((s) => s.id === otherId && !s.current));
  // no response holds a session key or cookie value
  const text = JSON.stringify(sessions);
  for (const c of [mine, other, user]) {
    assert.ok(!text.includes(raw(c)));
    assert.ok(!text.includes(h.auth!.sessions.keyOf(raw(c))));
  }

  const del = await send(h, "DELETE", `/api/admin/sessions/${otherId}`, mine);
  assert.equal(del.status, 200);
  assert.deepEqual(await del.json(), { ok: true });
  assert.equal((await call(h, "/api/auth/me", other)).status, 401, "the ended session is signed out");
  assert.equal((await call(h, "/api/auth/me", mine)).status, 200, "the account's other session still works");
  assert.equal(h.auth!.accounts.epochOf("sys", "alice"), 0, "ending one session raises no epoch");

  // a virtual account's session can be ended too
  assert.equal((await send(h, "DELETE", `/api/admin/sessions/${userId}`, mine)).status, 200);
  assert.equal((await call(h, "/api/auth/me", user)).status, 401);

  const unknown = await send(h, "DELETE", `/api/admin/sessions/${"0".repeat(32)}`, mine);
  assert.equal(unknown.status, 404);
  assert.deepEqual(await unknown.json(), { error: "not found" });
  // the cookie value is not an id
  assert.equal((await send(h, "DELETE", `/api/admin/sessions/${encodeURIComponent(raw(mine))}`, mine)).status, 404);
  assert.equal((await call(h, "/api/auth/me", mine)).status, 200);
});

test("end all: every session of the account ends, and changed is called once with its identity", async () => {
  const h = makeHub();
  const admin = await signIn(h, "alice");
  const one = await signIn(h, "vuser");
  const two = await signIn(h, "vuser");
  const keep = await signIn(h, "bob");
  const seen: Identity[] = [];
  const real = h.accountChanged.bind(h);
  h.accountChanged = async (before) => {
    seen.push(before);
    await real(before);
  };
  const before = h.auth!.accounts.identity("virt", "vuser");
  const r = await send(h, "POST", "/api/admin/end-sessions", admin, { kind: "virt", name: "vuser" });
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true });
  assert.deepEqual(seen, [before]);
  assert.equal((await call(h, "/api/auth/me", one)).status, 401);
  assert.equal((await call(h, "/api/auth/me", two)).status, 401);
  assert.equal((await call(h, "/api/auth/me", keep)).status, 200, "another account's session stays");
  assert.equal((await call(h, "/api/auth/me", admin)).status, 200);

  // a system user goes through the system name check; root and a bad kind are refused, an unknown virtual name is 404
  const sys = await send(h, "POST", "/api/admin/end-sessions", admin, { kind: "sys", name: "bob" });
  assert.equal(sys.status, 200);
  assert.equal(seen.length, 2);
  assert.deepEqual(seen[1], { kind: "sys", name: "bob", admin: false, epoch: 0 });
  assert.equal((await call(h, "/api/auth/me", keep)).status, 401);
  for (const body of [{ kind: "sys", name: "root" }, { kind: "sys", name: "-x" }, { kind: "who", name: "bob" }, { kind: "virt" }, null, [1]]) {
    const bad = await send(h, "POST", "/api/admin/end-sessions", admin, body);
    assert.equal(bad.status, 400, JSON.stringify(body));
    assert.equal(typeof ((await bad.json()) as { error?: unknown }).error, "string");
  }
  const missing = await send(h, "POST", "/api/admin/end-sessions", admin, { kind: "virt", name: "nobody" });
  assert.equal(missing.status, 404);
  assert.deepEqual(await missing.json(), { error: "not found" });
  assert.equal(seen.length, 2, "no refused call reached changed");
});

test("saved passwords from sign-in off: counted in the overview and forgotten without touching owned ones", async () => {
  const h = makeHub();
  h.vault.put("a", "/x.zip", "unowned-secret");
  h.vault.put("a", "/y.zip", "owned-secret", { owner: "virt:a" });
  const admin = await signIn(h, "vadmin");
  const o = (await (await call(h, "/api/admin/overview", admin)).json()) as { unownedPasswords: number };
  assert.equal(o.unownedPasswords, 1);
  const r = await send(h, "DELETE", "/api/admin/vault/unowned", admin);
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { removed: 1 });
  assert.equal(h.vault.countUnowned(), 0);
  assert.equal(h.vault.list("virt:a").length, 1, "the owned entry is still there");
  assert.deepEqual(await (await send(h, "DELETE", "/api/admin/vault/unowned", admin)).json(), { removed: 0 });
});

test("vault: countUnowned and forgetUnowned look at entries without an owner only", () => {
  const v = new Vault();
  v.put("a", "/1", "p1");
  v.put("a", "/2", "p2", { remember: true });
  v.put("a", "/3", "p3", { owner: "sys:alice" });
  v.put("a", "/4", "p4", { owner: "virt:a" });
  assert.equal(v.countUnowned(), 2);
  assert.equal(v.forgetUnowned(), 2);
  assert.equal(v.countUnowned(), 0);
  assert.equal(v.list().length, 2);
  assert.equal(v.forgetUnowned(), 0);
  v.close();
});

test("start: with auth on, saved passwords from before sign-in are counted in one log line; none, or auth off, logs nothing", async () => {
  const file = path.join(tmp, "vault-start.sqlite");
  const key = "k".repeat(32);
  const v = new Vault({ file, secret: key });
  v.put("a", "/1", "secret-one");
  v.put("a", "/2", "secret-two", { remember: true });
  v.put("a", "/3", "secret-three", { owner: "virt:a" });
  v.close();
  const logged: string[] = [];
  const orig = console.log;
  const origErr = console.error;
  console.log = (...a: unknown[]) => void logged.push(a.join(" "));
  console.error = (...a: unknown[]) => void logged.push(a.join(" "));
  try {
    const env = { FILEDECK_VAULT_FILE: file, FILEDECK_VAULT_KEY: key };
    hubs.push(createHub(loadConfig({ FILEDECK_MODE: "hub", FILEDECK_STATIC: tmp, NODES: "a=http://127.0.0.1:9", ...env } as never), undefined, () => {}));
    assert.deepEqual(logged.filter((l) => l.startsWith("vault:")), [], "auth off: nothing");
    makeHub(env);
    assert.deepEqual(logged.filter((l) => l.startsWith("vault:")), ["vault: 2 saved passwords from before sign-in was on are kept but not used; an administrator can forget them in Accounts"]);
    logged.length = 0;
    makeHub();
    assert.deepEqual(logged.filter((l) => l.startsWith("vault:")), [], "none: nothing");
  } finally {
    console.log = orig;
    console.error = origErr;
  }
});

test("audit: every admin call writes a line with its user; a body's password and key text never appear, the key's fingerprint does", async () => {
  const lines: string[] = [];
  const h = makeHub({}, lines);
  const admin = await signIn(h, "vadmin");
  const user = await signIn(h, "vuser");
  lines.length = 0;
  assert.equal((await call(h, "/api/admin/sessions", admin)).status, 200);
  const get = auditOf(lines, "GET", "/api/admin/sessions");
  assert.equal(get.length, 1, "a GET writes one line");
  assert.equal(get[0]!.user, "virt:vadmin");
  assert.equal(get[0]!.status, 200);
  // a refused call is written too, with the caller and its status
  assert.equal((await call(h, "/api/admin/overview", user)).status, 403);
  const refused = auditOf(lines, "GET", "/api/admin/overview");
  assert.equal(refused.length, 1);
  assert.equal(refused[0]!.user, "virt:vuser");
  assert.equal(refused[0]!.status, 403);

  const key = edLine(" laptop");
  const b64 = key.split(" ")[1]!;
  const secret = "the-password-that-must-not-show";
  const body = {
    kind: "virt",
    name: "vuser",
    admin: true,
    password: secret,
    passwordHash: "scrypt$abc$def",
    publicKey: key,
    nodes: { a: { runAs: "guest", grants: [{ path: "/srv/share", write: false, extra: secret }], secret } },
    sources: { s1: { write: true } },
    other: secret,
  };
  const r = await send(h, "POST", "/api/admin/end-sessions", admin, body);
  assert.equal(r.status, 200);
  const post = auditOf(lines, "POST", "/api/admin/end-sessions");
  assert.equal(post.length, 1);
  const raw = lines.find((l) => l.includes('"/api/admin/end-sessions"'))!;
  assert.ok(!raw.includes(secret), "no password");
  assert.ok(!raw.includes("scrypt$"), "no password hash");
  assert.ok(!raw.includes(b64), "no key text");
  assert.ok(!raw.includes(b64.slice(20, 60)), "no part of the key text");
  assert.deepEqual(post[0]!.body, {
    name: "vuser",
    kind: "virt",
    admin: true,
    nodes: { a: { runAs: "guest", grants: [{ path: "/srv/share", write: false }] } },
    sources: { s1: { write: true } },
    fingerprint: keyFingerprint(key),
  });
  assert.equal(post[0]!.user, "virt:vadmin");
  // the response holds no secret either
  assert.ok(!JSON.stringify(await (await call(h, "/api/admin/overview", admin)).json()).includes(secret));
});

test("adminBody keeps only the named fields, of the right types, and never a key it cannot read", () => {
  assert.equal(adminBody(null), undefined);
  assert.equal(adminBody([{ name: "x" }]), undefined);
  assert.equal(adminBody("password"), undefined);
  assert.deepEqual(adminBody({ password: "x", publicKey: "not a key", passwordHash: "scrypt$" }), {});
  assert.deepEqual(adminBody({ name: 5, kind: {}, admin: "yes", nodes: [], sources: "s" }), {});
  // a null password (removing it) is not written either
  assert.deepEqual(adminBody({ name: "a", password: null }), { name: "a" });
  const many = Array.from({ length: 100 }, (_, i) => ({ path: `/p${i}`, write: i % 2 === 0 }));
  const out = adminBody({ nodes: { a: { runAs: "u", grants: many } } }) as { nodes: { a: { grants: unknown[] } } };
  assert.ok(out.nodes.a.grants.length <= 65, "a long list is bounded");
  const long = adminBody({ name: "n".repeat(5000) }) as { name: string };
  assert.ok(long.name.length < 600, "a long string is clipped");
});
