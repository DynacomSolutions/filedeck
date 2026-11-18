import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { hashPassword } from "../src/auth/store.ts";
import { lockOut } from "../src/auth/admin-routes.ts";
import { loadConfig } from "../src/config.ts";
import type { Identity } from "../src/auth/identity.ts";
import { ADDR, closeRigs, fakeSystem, rig, type Mode } from "./tailnet-env.ts";

/**
 * Administrators link tailnet logins and tags to virtual accounts and system users (docs/superpowers/plans/2026-11-18-tailscale-sign-in.md,
 * Task 4). Each link change is written in the store transaction with the other fields, raises the epoch there and runs `accountChanged`
 * after the commit. A login or tag belongs to one account (409). While a Tailscale source is configured, a link counts for the last
 * administrator check (with the headers source only a login link does).
 */

const PW = "a-long-password-1";
const NO_ADMIN = "this would leave no administrator who can sign in";
const HASH = hashPassword(PW);

const servers: http.Server[] = [];
after(async () => {
  await closeRigs();
  for (const s of servers) {
    s.closeAllConnections();
    s.close();
  }
});

/** A fake agent whose account lookup answers from `users`; a name missing there gets 503 (no answer). */
async function fakeAgent(): Promise<{ url: string; users: Record<string, boolean> }> {
  const f = { url: "", users: {} as Record<string, boolean> };
  const srv = http.createServer((req, res) => {
    let body = "";
    req.on("data", (d: Buffer) => (body += d.toString()));
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      if (req.url === "/api/auth/lookup") {
        const name = (JSON.parse(body || "{}") as { name?: string }).name ?? "";
        if (!Object.hasOwn(f.users, name)) {
          res.statusCode = 503;
          return void res.end(JSON.stringify({ error: "account lookup failed" }));
        }
        return void res.end(JSON.stringify({ exists: f.users[name] }));
      }
      res.end(JSON.stringify({ entries: [], jobs: [] }));
    });
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  servers.push(srv);
  f.url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  return f;
}

/** A hub with sign-in on, the given Tailscale source and the virtual administrator `boss` (password `PW`); every `accountChanged` is recorded. */
async function world(mode: Mode | null, o: { env?: Record<string, string>; boss?: { password?: boolean; links?: string[] } } = {}) {
  const r = await rig(mode, { env: { FILEDECK_ADMINS: "", ...o.env }, system: fakeSystem().system });
  const { h } = r;
  const acc = h.auth!.accounts;
  acc.create({ name: "boss", ...(o.boss?.password === false ? {} : { passwordHash: HASH }), admin: true, nodes: {} });
  const bossLinks = o.boss?.links ?? [];
  h.auth!.links.setForAccount(
    "virt",
    "boss",
    bossLinks.map((s) => ({ subject: s, kind: s.startsWith("tag:") ? ("tag" as const) : ("login" as const) })),
  );
  const changed: Identity[] = [];
  const orig = h.accountChanged;
  h.accountChanged = async (before) => {
    changed.push(structuredClone(before));
    return orig(before);
  };
  const login = async (name: string, password = PW): Promise<string> => {
    const res = await r.req("/api/auth/login", { method: "POST", body: { name, password } });
    assert.equal(res.status, 200, `sign-in of ${name}: ${await res.clone().text()}`);
    return (res.headers.get("set-cookie") ?? "").split(";")[0]!;
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const send = async (method: string, p: string, cookie: string, body?: unknown): Promise<{ status: number; json: any; text: string }> => {
    const res = await r.req(p, { method, cookie, ...(body === undefined ? {} : { body }) });
    const text = await res.text();
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
    return { status: res.status, json, text };
  };
  const rows = (subject: string) => (h.auth!.db.db.prepare("SELECT COUNT(*) AS n FROM tailnet_links WHERE subject = ?").get(subject) as { n: number }).n;
  return { ...r, acc, changed, login, send, rows };
}

const LINKED = [
  { subject: "alice@github", kind: "login" },
  { subject: "tag:server", kind: "tag" },
];

test("link a virtual account: cleaned, sorted, epoch raised, accountChanged once with the identity from before, sessions end", async () => {
  const w = await world("socket");
  const admin = await w.login("boss");
  w.acc.create({ name: "guest", passwordHash: HASH, admin: false, nodes: {} });
  const guest = await w.login("guest");
  assert.equal((await w.send("GET", "/api/nodes", guest)).status, 200);
  const epoch = w.acc.epochOf("virt", "guest");
  const r = await w.send("PATCH", "/api/admin/accounts/guest", admin, { tailnet: ["TAG:Server", " Alice@GitHub "] });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.json.tailnet, LINKED);
  assert.ok(w.acc.epochOf("virt", "guest") > epoch);
  assert.equal(w.changed.length, 1);
  assert.deepEqual([w.changed[0]!.kind, w.changed[0]!.name, w.changed[0]!.epoch], ["virt", "guest", epoch]);
  assert.equal((await w.send("GET", "/api/nodes", guest)).status, 401, "the password session ended");
  // the list shows the links too
  const list = await w.send("GET", "/api/admin/accounts", admin);
  assert.deepEqual(list.json.accounts.find((a: { name: string }) => a.name === "guest").tailnet, LINKED);
  // a session made through a link ends when that link is removed
  w.devices.set(ADDR, { login: "alice@github" });
  const ts = await w.signIn();
  assert.equal((await w.send("GET", "/api/nodes", ts)).status, 200);
  const cut = await w.send("PATCH", "/api/admin/accounts/guest", admin, { tailnet: ["tag:server"] });
  assert.equal(cut.status, 200, cut.text);
  assert.equal(w.changed.length, 2);
  w.pastCache();
  assert.equal((await w.send("GET", "/api/nodes", ts)).status, 401, "the Tailscale session ended with its link");
});

test("create with links: no password, one login link; a re-created name never gets old links", async () => {
  const w = await world("socket");
  const admin = await w.login("boss");
  const r = await w.send("POST", "/api/admin/accounts", admin, { name: "bob", tailnet: ["bob@github"] });
  assert.equal(r.status, 201, r.text);
  assert.equal(r.json.hasPassword, false);
  assert.deepEqual(r.json.tailnet, [{ subject: "bob@github", kind: "login" }]);
  // a stale link left under a name (not by the routes) is replaced when the name is made
  w.h.auth!.links.setForAccount("virt", "ghost", [{ subject: "ghost@github", kind: "login" }]);
  const g = await w.send("POST", "/api/admin/accounts", admin, { name: "ghost" });
  assert.equal(g.status, 201, g.text);
  assert.deepEqual(g.json.tailnet, []);
  assert.equal(w.h.auth!.links.owner("ghost@github"), undefined);
  // a create whose link is taken writes nothing
  const taken = await w.send("POST", "/api/admin/accounts", admin, { name: "carl", tailnet: ["bob@github"] });
  assert.equal(taken.status, 409);
  assert.deepEqual(taken.json, { error: "this tailnet login is linked to virt:bob" });
  assert.equal(w.acc.get("carl"), undefined);
});

test("duplicate: a login or tag linked to another account is 409 with its owner, and nothing of that change is written", async () => {
  const w = await world("socket");
  const admin = await w.login("boss");
  w.acc.create({ name: "guest", admin: false, nodes: {} });
  w.acc.create({ name: "other", admin: false, nodes: {} });
  assert.equal((await w.send("PATCH", "/api/admin/accounts/guest", admin, { tailnet: ["alice@github", "tag:server"] })).status, 200);
  const n = w.changed.length;
  const epoch = w.acc.epochOf("virt", "other");
  const a = await w.send("PATCH", "/api/admin/accounts/other", admin, { admin: true, tailnet: ["Alice@GitHub"] });
  assert.equal(a.status, 409);
  assert.deepEqual(a.json, { error: "this tailnet login is linked to virt:guest" });
  const t = await w.send("PATCH", "/api/admin/accounts/other", admin, { admin: true, tailnet: ["other@github", "tag:server"] });
  assert.equal(t.status, 409);
  assert.deepEqual(t.json, { error: "this tag is linked to virt:guest" });
  assert.equal(w.acc.get("other")!.admin, false, "the admin flag of the same body did not change");
  assert.deepEqual(w.h.auth!.links.forAccount("virt", "other"), []);
  assert.equal(w.acc.epochOf("virt", "other"), epoch);
  assert.equal(w.changed.length, n);
  // a system user's link is refused the same way
  const s = await w.send("PUT", "/api/admin/system/alice/tailnet", admin, { links: ["tag:server"] });
  assert.equal(s.status, 409);
  assert.deepEqual(s.json, { error: "this tag is linked to virt:guest" });
});

test("same link, at once: one of two administrators wins, the other gets 409; the table holds one row", async () => {
  const w = await world("socket");
  const admin = await w.login("boss");
  w.acc.create({ name: "x", admin: false, nodes: {} });
  w.acc.create({ name: "y", admin: false, nodes: {} });
  const res = await Promise.all(["x", "y"].map((n) => w.send("PATCH", `/api/admin/accounts/${n}`, admin, { tailnet: ["tag:ci"] })));
  assert.deepEqual(res.map((r) => r.status).sort(), [200, 409]);
  assert.equal(w.rows("tag:ci"), 1);
});

test("bad links: 400 with a message that names the field and both forms; more than 16 is 400", async () => {
  const w = await world("socket");
  const admin = await w.login("boss");
  w.acc.create({ name: "guest", admin: false, nodes: {} });
  for (const bad of ["tag:a_b", "tag:", "tagged-devices", "alice", 5]) {
    const r = await w.send("PATCH", "/api/admin/accounts/guest", admin, { tailnet: [bad] });
    assert.equal(r.status, 400, String(bad));
    assert.match(r.json.error, /tailnet link/);
    assert.match(r.json.error, /alice@github/);
    assert.match(r.json.error, /tag:server/);
  }
  const many = Array.from({ length: 17 }, (_, i) => `u${i}@github`);
  const r = await w.send("PATCH", "/api/admin/accounts/guest", admin, { tailnet: many });
  assert.equal(r.status, 400);
  assert.deepEqual(r.json, { error: "at most 16 tailnet links per account" });
  assert.equal((await w.send("PATCH", "/api/admin/accounts/guest", admin, { tailnet: "alice@github" })).status, 400);
  assert.equal((await w.send("POST", "/api/admin/accounts", admin, { name: "bad", tailnet: ["alice"] })).status, 400);
  assert.equal((await w.send("PUT", "/api/admin/system/alice/tailnet", admin, { links: ["alice"] })).status, 400);
  assert.equal((await w.send("PUT", "/api/admin/system/alice/tailnet", admin, {})).status, 400);
  assert.deepEqual(w.h.auth!.links.forAccount("virt", "guest"), []);
});

test("system user: links checked against the machines, listed, never root; the user's sessions end", async () => {
  const a = await fakeAgent();
  const b = await fakeAgent();
  const w = await world("socket", { env: { NODES: `a=${a.url},b=${b.url}` } });
  const admin = await w.login("boss");
  a.users = { alice: true };
  const alice = await w.login("alice", "right-pw");
  assert.equal((await w.send("GET", "/api/nodes", alice)).status, 200);
  const epoch = w.acc.epochOf("sys", "alice");
  const r = await w.send("PUT", "/api/admin/system/alice/tailnet", admin, { links: ["alice@github", "TAG:Ops"] });
  assert.equal(r.status, 200, r.text);
  const view = { name: "alice", admin: false, sources: {}, sessions: 0, tailnet: [{ subject: "alice@github", kind: "login" }, { subject: "tag:ops", kind: "tag" }] };
  assert.deepEqual(r.json, view);
  assert.ok(w.acc.epochOf("sys", "alice") > epoch);
  assert.deepEqual(w.changed.at(-1), { kind: "sys", name: "alice", admin: false, epoch });
  assert.equal((await w.send("GET", "/api/nodes", alice)).status, 401, "alice's session ended");
  const list = await w.send("GET", "/api/admin/accounts", admin);
  assert.deepEqual(list.json.system, [view]);
  // one machine says no, the other does not answer: refused, nothing written
  a.users = { carol: false };
  const no = await w.send("PUT", "/api/admin/system/carol/tailnet", admin, { links: ["carol@github"] });
  assert.equal(no.status, 400);
  assert.deepEqual(no.json, { error: "no machine has a system user carol" });
  assert.deepEqual(w.h.auth!.links.forAccount("sys", "carol"), []);
  // no machine answers: nothing blocks it
  a.users = {};
  const none = await w.send("PUT", "/api/admin/system/dave/tailnet", admin, { links: ["dave@github"] });
  assert.equal(none.status, 200, none.text);
  // root never
  const root = await w.send("PUT", "/api/admin/system/root/tailnet", admin, { links: ["root@github"] });
  assert.equal(root.status, 400);
  assert.match(root.json.error, /root/);
  assert.equal(w.h.auth!.links.owner("root@github"), undefined);
  // an empty list asks no machine and removes every link
  a.users = { alice: false, carol: false };
  b.users = { alice: false, carol: false };
  const cleared = await w.send("PUT", "/api/admin/system/alice/tailnet", admin, { links: [] });
  assert.equal(cleared.status, 200, cleared.text);
  assert.deepEqual(cleared.json.tailnet, []);
  // a virtual account and a system user of one name have separate links
  w.acc.create({ name: "dave", admin: false, nodes: {} });
  assert.deepEqual((await w.send("GET", "/api/admin/accounts", admin)).json.accounts.find((x: { name: string }) => x.name === "dave").tailnet, []);
});

test("delete removes links: the login and tag are free again, and a new account of the name has none", async () => {
  const w = await world("socket");
  const admin = await w.login("boss");
  assert.equal((await w.send("POST", "/api/admin/accounts", admin, { name: "guest", tailnet: ["alice@github", "tag:server"] })).status, 201);
  const d = await w.send("DELETE", "/api/admin/accounts/guest", admin);
  assert.equal(d.status, 200, d.text);
  assert.equal(w.h.auth!.links.owner("alice@github"), undefined);
  assert.equal(w.h.auth!.links.owner("tag:server"), undefined);
  const again = await w.send("POST", "/api/admin/accounts", admin, { name: "guest" });
  assert.equal(again.status, 201);
  assert.deepEqual(again.json.tailnet, []);
  const other = await w.send("POST", "/api/admin/accounts", admin, { name: "other", tailnet: ["alice@github", "tag:server"] });
  assert.equal(other.status, 201, other.text);
});

test("lock-out counts links: socket source, any link counts; removing the last one is refused", async () => {
  const w = await world("socket", { boss: { links: ["boss@github"] } });
  const admin = await w.login("boss");
  const r = await w.send("PATCH", "/api/admin/accounts/boss", admin, { password: null });
  assert.equal(r.status, 200, r.text);
  // boss now signs in only with the link
  w.devices.set(ADDR, { login: "boss@github" });
  const ts = await w.signIn();
  const cut = await w.send("PATCH", "/api/admin/accounts/boss", ts, { tailnet: [] });
  assert.equal(cut.status, 409);
  assert.deepEqual(cut.json, { error: NO_ADMIN });
  assert.deepEqual(w.h.auth!.links.forAccount("virt", "boss"), [{ subject: "boss@github", kind: "login" }]);
  // a tag link counts with the socket too
  const tag = await w.send("PATCH", "/api/admin/accounts/boss", ts, { tailnet: ["tag:boss"] });
  assert.equal(tag.status, 200, tag.text);
  // taking the flag away is still refused
  w.devices.set(ADDR, { tags: ["tag:boss"] });
  w.pastCache();
  const ts2 = await w.signIn();
  assert.deepEqual((await w.send("PATCH", "/api/admin/accounts/boss", ts2, { admin: false })).json, { error: NO_ADMIN });
});

test("lock-out counts links: headers source counts only login links", async () => {
  const w = await world("headers", { boss: { links: ["boss@github"] } });
  const r = await w.send("PATCH", "/api/admin/accounts/boss", await w.login("boss"), { password: null });
  assert.equal(r.status, 200, r.text);
  // with no password, a list of only tags would leave nobody who can sign in through headers
  w.devices.set(ADDR, { login: "boss@github" });
  const ts = await w.signIn();
  const tag = await w.send("PATCH", "/api/admin/accounts/boss", ts, { tailnet: ["tag:boss"] });
  assert.equal(tag.status, 409);
  assert.deepEqual(tag.json, { error: NO_ADMIN });

  const t = await world("headers", { boss: { links: ["tag:boss"] } });
  const r2 = await t.send("PATCH", "/api/admin/accounts/boss", await t.login("boss"), { password: null });
  assert.equal(r2.status, 409, "a tag cannot sign in through headers");
  assert.deepEqual(r2.json, { error: NO_ADMIN });
});

test("lock-out counts links: no source, links do not count", async () => {
  const w = await world(null, { boss: { links: ["boss@github"] } });
  const r = await w.send("PATCH", "/api/admin/accounts/boss", await w.login("boss"), { password: null });
  assert.equal(r.status, 409);
  assert.deepEqual(r.json, { error: NO_ADMIN });
});

test("lock-out counts links: an administrator with only a link lets another administrator go (socket), not without a source", async () => {
  const w = await world("socket", { boss: { password: false, links: ["boss@github"] } });
  w.acc.create({ name: "chief", passwordHash: HASH, admin: true, nodes: {} });
  const chief = await w.login("chief");
  const d = await w.send("DELETE", "/api/admin/accounts/chief", chief);
  assert.equal(d.status, 200, d.text);

  const n = await world(null, { boss: { password: false, links: ["boss@github"] } });
  n.acc.create({ name: "chief", passwordHash: HASH, admin: true, nodes: {} });
  const c2 = await n.login("chief");
  const d2 = await n.send("DELETE", "/api/admin/accounts/chief", c2);
  assert.equal(d2.status, 409);
  assert.deepEqual(d2.json, { error: NO_ADMIN });
});

test("lockOut on its own: links count by mode, and the changed account's kept links are used when given", async () => {
  const w = await world(null);
  const cfg = loadConfig({ FILEDECK_MODE: "hub", FILEDECK_STATIC: "/nonexistent", NODES: "a=http://127.0.0.1:9", FILEDECK_ADMINS: "" } as never);
  const links = w.h.auth!.links;
  links.setForAccount("virt", "boss", [{ subject: "tag:boss", kind: "tag" }]);
  assert.equal(lockOut(cfg, w.acc, links, null, { name: "boss", password: null }), true);
  assert.equal(lockOut(cfg, w.acc, links, "socket", { name: "boss", password: null }), false);
  assert.equal(lockOut(cfg, w.acc, links, "headers", { name: "boss", password: null }), true);
  assert.equal(lockOut(cfg, w.acc, links, "headers", { name: "boss", password: null, links: [{ subject: "boss@github", kind: "login" }] }), false);
  assert.equal(lockOut(cfg, w.acc, links, "socket", { name: "boss", password: null, links: [] }), true);
  assert.equal(lockOut(cfg, w.acc, links, "socket", { name: "boss", deleted: true }), true);
});

test("overview: tailscale names the configured source", async () => {
  for (const mode of ["headers", "socket", null] as const) {
    const w = await world(mode);
    const r = await w.send("GET", "/api/admin/overview", await w.login("boss"));
    assert.equal(r.status, 200);
    assert.equal(r.json.tailscale, mode);
  }
});

test("the epoch rises in the store transaction itself: a link change ends old sessions even when accountChanged never runs", async () => {
  const w = await world("socket");
  const admin = await w.login("boss");
  w.acc.create({ name: "guest", passwordHash: HASH, admin: false, nodes: {} });
  // a hub that stops right after the commit: accountChanged never runs
  w.h.accountChanged = async () => {};
  for (const [kind, name, method, p, body] of [
    ["virt", "guest", "PATCH", "/api/admin/accounts/guest", { tailnet: ["guest@github"] }],
    ["virt", "guest", "PATCH", "/api/admin/accounts/guest", { tailnet: [] }],
    ["sys", "alice", "PUT", "/api/admin/system/alice/tailnet", { links: ["alice@github"] }],
    ["sys", "alice", "PUT", "/api/admin/system/alice/tailnet", { links: [] }],
  ] as const) {
    const e = w.acc.epochOf(kind, name);
    const r = await w.send(method, p, admin, body);
    assert.equal(r.status, 200, `${method} ${p}: ${r.text}`);
    assert.equal(w.acc.epochOf(kind, name), e + 1, `${method} ${p}`);
  }
  const guest = await w.login("guest");
  assert.equal((await w.send("PATCH", "/api/admin/accounts/guest", admin, { tailnet: ["tag:guest"] })).status, 200);
  assert.equal((await w.send("GET", "/api/nodes", guest)).status, 401, "the old session");
});
