import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import { createHub } from "../src/hub.ts";
import { loadConfig } from "../src/config.ts";
import { ADDR, closeRigs, fakeSystem, NODE_NAME, rig, type Mode } from "./tailnet-env.ts";

/**
 * Task 3 of the Tailscale sign-in plan: `GET /api/auth/tailnet`, `POST /api/auth/login-tailscale`, the session bound to the tailnet
 * identity (checked again on every request through the 10-second cache), the system user check, root refused, act as root, and the
 * tailnet headers stripped before any route or agent sees them.
 */
after(closeRigs);

const MODES: Mode[] = ["headers", "socket"];
const guest = (h: Awaited<ReturnType<typeof rig>>["h"], admin = false) => h.auth!.accounts.create({ name: "guest", password: "pw-guest", admin, nodes: {} });
const link = (h: Awaited<ReturnType<typeof rig>>["h"], kind: "sys" | "virt", name: string, ...subjects: string[]) =>
  h.auth!.links.setForAccount(
    kind,
    name,
    subjects.map((s) => ({ subject: s, kind: s.startsWith("tag:") ? ("tag" as const) : ("login" as const) })),
  );

async function timed<T>(fn: () => Promise<T>): Promise<[T, number]> {
  const t0 = performance.now();
  const v = await fn();
  return [v, performance.now() - t0];
}

test("button data: the identity of a listed peer's request, {} otherwise, 503 when the socket is down", async () => {
  for (const mode of MODES) {
    const r = await rig(mode);
    r.devices.set(ADDR, { login: "Alice@GitHub" });
    const a = await r.req("/api/auth/tailnet");
    assert.equal(a.status, 200);
    const body = (await a.json()) as Record<string, unknown>;
    assert.equal(body.login, "alice@github", mode);
    assert.equal(body.tags, undefined, "no tags key for a device without tags");
    if (mode === "socket") assert.deepEqual(body.node, { name: NODE_NAME });
    else assert.equal(body.node, undefined);
    assert.equal(body.address, undefined, "the address is not given out");
    const other = await r.req("/api/auth/tailnet", { peer: "192.0.2.9" });
    assert.deepEqual(await other.json(), {}, `${mode}: another peer`);
  }
  const s = await rig("socket");
  s.devices.set(ADDR, { tags: ["tag:ci", "tag:web"] });
  const t = (await (await s.req("/api/auth/tailnet")).json()) as Record<string, unknown>;
  assert.deepEqual(t.tags, ["tag:ci", "tag:web"]);
  assert.equal(t.login, undefined);
  s.pastCache();
  s.api!.state.down = true;
  const down = await s.req("/api/auth/tailnet");
  assert.equal(down.status, 503);
  assert.deepEqual(await down.json(), { error: "tailnet identity unavailable" });
  const none = await rig(null);
  const n = await none.req("/api/auth/tailnet", { headers: { "tailscale-user-login": "alice@github" } });
  assert.equal(n.status, 200);
  assert.deepEqual(await n.json(), {});
});

test("virtual account by login: the cookie, and me gives the method and the subject", async () => {
  for (const mode of MODES) {
    const r = await rig(mode);
    guest(r.h);
    link(r.h, "virt", "guest", "alice@github");
    r.devices.set(ADDR, { login: "alice@github" });
    const res = await r.req("/api/auth/login-tailscale", { method: "POST" });
    assert.equal(res.status, 200, mode);
    assert.deepEqual(await res.clone().json(), { auth: true, kind: "virt", name: "guest", admin: false });
    const sc = res.headers.get("set-cookie") ?? "";
    assert.match(sc, /^__Host-filedeck=[A-Za-z0-9_-]{43}; .*HttpOnly.*Secure.*SameSite=Lax/);
    const me = await r.req("/api/auth/me", { cookie: sc.split(";")[0] });
    assert.deepEqual(await me.json(), { auth: true, kind: "virt", name: "guest", admin: false, method: "tailscale", tailnet: "alice@github" });
    const info = r.h.auth!.sessions.list();
    assert.equal(info.length, 1);
    assert.equal(info[0]?.method, "tailscale");
    assert.equal(info[0]?.tailnet, "alice@github");
  }
});

test("password sessions say so in me", async () => {
  const r = await rig("headers");
  guest(r.h);
  const res = await r.req("/api/auth/login", { method: "POST", body: { name: "guest", password: "pw-guest" } });
  assert.equal(res.status, 200);
  const me = await r.req("/api/auth/me", { cookie: (res.headers.get("set-cookie") ?? "").split(";")[0] });
  assert.deepEqual(await me.json(), { auth: true, kind: "virt", name: "guest", admin: false, method: "password" });
});

test("by tag: a tagged device, an unlinked login with a linked tag, and a linked login that wins over the tag", async () => {
  const r = await rig("socket");
  guest(r.h);
  r.h.auth!.accounts.create({ name: "ci", admin: false, nodes: {} });
  link(r.h, "virt", "ci", "tag:ci");
  link(r.h, "virt", "guest", "alice@github");
  const cases: [string, { login?: string; tags: string[] }, string, string][] = [
    ["100.64.0.1", { tags: ["tag:ci"] }, "ci", "tag:ci"],
    ["100.64.0.2", { login: "bob@github", tags: ["tag:ci"] }, "ci", "tag:ci"],
    ["100.64.0.3", { login: "alice@github", tags: ["tag:ci"] }, "guest", "alice@github"],
  ];
  for (const [addr, dev, name, subject] of cases) {
    r.devices.set(addr, dev);
    const c = await r.signIn(addr);
    const me = (await (await r.req("/api/auth/me", { cookie: c, addr })).json()) as Record<string, unknown>;
    assert.equal(me.name, name, addr);
    assert.equal(me.kind, "virt");
    assert.equal(me.tailnet, subject);
  }
  const lines = r.audits("/api/auth/login-tailscale");
  assert.deepEqual(lines[0]?.tailnet, { tags: ["tag:ci"], subject: "tag:ci", source: "socket", node: NODE_NAME, address: "100.64.0.1" });
});

test("tag conflict: tags of two accounts refuse, and the audit line names both", async () => {
  const r = await rig("socket");
  r.h.auth!.accounts.create({ name: "ci", admin: false, nodes: {} });
  link(r.h, "virt", "ci", "tag:ci");
  link(r.h, "sys", "c", "tag:db");
  r.devices.set(ADDR, { tags: ["tag:db", "tag:ci"] });
  const [res, ms] = await timed(() => r.req("/api/auth/login-tailscale", { method: "POST" }));
  assert.equal(res.status, 401);
  assert.deepEqual(await res.json(), { error: "sign-in failed" });
  assert.ok(ms >= 490, `${ms} ms`);
  const l = r.audits("/api/auth/login-tailscale")[0];
  assert.equal(l?.status, 401);
  assert.deepEqual(l?.tailnet, { tags: ["tag:ci", "tag:db"], source: "socket", node: NODE_NAME, address: ADDR, reason: "tag-conflict", accounts: ["sys:c", "virt:ci"] });
});

test("tags and headers: a tagged device behind Serve has no identity, so tag links make no difference", async () => {
  const r = await rig("headers");
  r.h.auth!.accounts.create({ name: "ci", admin: false, nodes: {} });
  link(r.h, "virt", "ci", "tag:ci");
  const res = await r.req("/api/auth/login-tailscale", { method: "POST" });
  assert.equal(res.status, 401);
  assert.deepEqual(await res.json(), { error: "sign-in failed" });
  assert.deepEqual(r.audits("/api/auth/login-tailscale")[0]?.tailnet, { source: "headers", reason: "unlinked" });
});

test("unlinked: the same failure after the floor, the reason in the audit line, and the limiter keyed on tailnet:<login>", async () => {
  for (const mode of MODES) {
    const r = await rig(mode);
    guest(r.h);
    link(r.h, "virt", "guest", "alice@github");
    r.devices.set(ADDR, { login: "bob@github" });
    const [res, ms] = await timed(() => r.req("/api/auth/login-tailscale", { method: "POST" }));
    assert.equal(res.status, 401, mode);
    assert.deepEqual(await res.json(), { error: "sign-in failed" });
    assert.equal(res.headers.get("set-cookie"), null);
    assert.ok(ms >= 490, `${mode}: ${ms} ms`);
    const [none, ms2] = await timed(() => r.req("/api/auth/login-tailscale", { method: "POST", peer: "192.0.2.9", headers: { "tailscale-user-login": "alice@github" } }));
    assert.equal(none.status, 401);
    assert.deepEqual(await none.json(), { error: "sign-in failed" });
    assert.ok(ms2 >= 490, `${mode}: ${ms2} ms`);
    const [a, b] = r.audits("/api/auth/login-tailscale");
    assert.equal(a?.tailnet?.login, "bob@github");
    assert.equal(a?.tailnet?.reason, "unlinked");
    assert.equal(a?.tailnet?.source, mode);
    assert.deepEqual(b?.tailnet, { source: mode, reason: "unlinked" });
    // four more failures for bob, each from another address (so only the name key can block): the sixth is 429
    const addrs = ["100.64.1.1", "100.64.1.2", "100.64.1.3", "100.64.1.4", "100.64.1.5"];
    for (const x of addrs) r.devices.set(x, { login: "bob@github" });
    const four = await Promise.all(addrs.slice(0, 4).map((addr) => r.req("/api/auth/login-tailscale", { method: "POST", addr })));
    assert.deepEqual(
      four.map((x) => x.status),
      [401, 401, 401, 401],
    );
    const sixth = await r.req("/api/auth/login-tailscale", { method: "POST", addr: "100.64.1.5" });
    assert.equal(sixth.status, 429, mode);
    assert.equal(r.h.auth!.limiter.check("bob@github", "203.0.113.7", "tailnet").ok, false, "the key is the login, in the tailnet family");
    assert.equal(r.h.auth!.limiter.check("bob@github", "203.0.113.7").ok, true, "a password sign-in name is another key");
    assert.equal(r.h.auth!.limiter.check("tailnet:bob@github", "203.0.113.7").ok, true, "and so is a name that spells the tailnet key");
  }
});

test("system user: vouched signs in and starts the presence refresh; not vouched and refused fail; root never asks", async () => {
  let answer: "yes" | "no" | "refused" = "yes";
  const fake = fakeSystem(() => answer);
  const r = await rig("socket", { system: fake.system });
  link(r.h, "sys", "alice", "alice@github");
  r.devices.set(ADDR, { login: "alice@github" });
  const refreshed: string[] = [];
  r.h.presence!.refresh = async (name: string) => {
    refreshed.push(name);
  };
  const c = await r.signIn();
  assert.deepEqual(fake.vouched, ["alice"]);
  assert.deepEqual(refreshed, ["alice"]);
  const me = (await (await r.req("/api/auth/me", { cookie: c })).json()) as Record<string, unknown>;
  assert.equal(me.kind, "sys");
  assert.equal(me.name, "alice");
  for (const [a, reason] of [
    ["no", "not-vouched"],
    ["refused", "refused"],
  ] as const) {
    answer = a;
    const res = await r.req("/api/auth/login-tailscale", { method: "POST" });
    assert.equal(res.status, 401, a);
    assert.deepEqual(await res.json(), { error: "sign-in failed" });
    assert.equal(r.audits("/api/auth/login-tailscale").at(-1)?.tailnet?.reason, reason);
  }
  // a link row for root written by hand (the admin routes refuse it): refused before any machine is asked
  answer = "yes";
  r.h.auth!.db.db.prepare("INSERT INTO tailnet_links (subject, kind, account_kind, name, created) VALUES (?, 'login', 'sys', 'root', 0)").run("boss@github");
  r.devices.set("100.64.0.9", { login: "boss@github" });
  fake.vouched.length = 0;
  const root = await r.req("/api/auth/login-tailscale", { method: "POST", addr: "100.64.0.9" });
  assert.equal(root.status, 401);
  assert.deepEqual(await root.json(), { error: "sign-in failed" });
  assert.deepEqual(fake.vouched, [], "no machine asked for root");
  assert.equal(r.audits("/api/auth/login-tailscale").at(-1)?.tailnet?.reason, "refused");
});

test("a virtual account deleted meanwhile: no-account", async () => {
  const r = await rig("headers");
  link(r.h, "virt", "gone", "alice@github");
  r.devices.set(ADDR, { login: "alice@github" });
  const res = await r.req("/api/auth/login-tailscale", { method: "POST" });
  assert.equal(res.status, 401);
  assert.equal(r.audits("/api/auth/login-tailscale")[0]?.tailnet?.reason, "no-account");
});

test("needs HTTPS: no X-Forwarded-Proto is 403", async () => {
  const r = await rig("headers");
  guest(r.h);
  link(r.h, "virt", "guest", "alice@github");
  r.devices.set(ADDR, { login: "alice@github" });
  const res = await r.req("/api/auth/login-tailscale", { method: "POST", https: false });
  assert.equal(res.status, 403);
  assert.deepEqual(await res.json(), { error: "sign-in needs HTTPS" });
});

test("socket down at sign-in: 503, not counted as a failure", async () => {
  const r = await rig("socket");
  r.api!.state.down = true;
  for (let i = 0; i < 7; i++) {
    const res = await r.req("/api/auth/login-tailscale", { method: "POST" });
    assert.equal(res.status, 503);
    assert.deepEqual(await res.json(), { error: "tailnet identity unavailable" });
  }
  assert.equal(r.h.auth!.limiter.check("", ADDR, "tailnet").ok, true);
});

test("binding: the same login is admitted; another login ends the session; no identity keeps it; unavailable keeps it", async () => {
  for (const mode of MODES) {
    const r = await rig(mode);
    guest(r.h);
    link(r.h, "virt", "guest", "alice@github");
    r.devices.set(ADDR, { login: "alice@github" });
    let c = await r.signIn();
    assert.equal((await r.req("/api/auth/me", { cookie: c })).status, 200, mode);
    // no identity (another peer, the same cookie): signed out, but the session stays for the way back over the tailnet
    const other = await r.req("/api/nodes", { cookie: c, peer: "192.0.2.9" });
    assert.equal(other.status, 401);
    assert.equal(other.headers.get("x-filedeck-auth"), "signed-out");
    assert.equal(r.h.auth!.sessions.list().length, 1);
    assert.equal((await r.req("/api/nodes", { cookie: c })).status, 200, `${mode}: back over the tailnet`);
    // another login on the device: the session ends
    r.devices.set(ADDR, { login: "bob@github" });
    r.pastCache();
    const bob = await r.req("/api/nodes", { cookie: c });
    assert.equal(bob.status, 401);
    assert.equal(bob.headers.get("x-filedeck-auth"), "signed-out");
    assert.equal(r.h.auth!.sessions.list().length, 0, `${mode}: the session is gone`);
    r.devices.set(ADDR, { login: "alice@github" });
    r.pastCache();
    assert.equal((await r.req("/api/nodes", { cookie: c })).status, 401, "it does not come back");
    if (mode !== "socket") continue;
    // socket: the same address answering for another device ends it
    c = await r.signIn();
    r.devices.set(ADDR, { login: "alice@github", stable: "nOther" });
    r.pastCache();
    assert.equal((await r.req("/api/nodes", { cookie: c })).status, 401);
    assert.equal(r.h.auth!.sessions.list().length, 0);
    // socket unavailable: 503 on every request, and the session stays
    c = await r.signIn();
    r.pastCache();
    r.api!.state.down = true;
    for (let i = 0; i < 3; i++) {
      const down = await r.req("/api/nodes", { cookie: c });
      assert.equal(down.status, 503);
      assert.deepEqual(await down.json(), { error: "tailnet identity unavailable" });
    }
    const me = await r.req("/api/auth/me", { cookie: c });
    assert.equal(me.status, 503, "me says unavailable too, so the page does not sign the person out");
    assert.equal(r.h.auth!.sessions.list().length, 1);
    r.api!.state.down = false;
    assert.equal((await r.req("/api/nodes", { cookie: c })).status, 200);
  }
});

test("tag set changes: a tag taken off ends the session within 10 s; a conflicting tag ends it; an unlinked tag does not", async () => {
  const r = await rig("socket");
  r.h.auth!.accounts.create({ name: "ci", admin: false, nodes: {} });
  link(r.h, "virt", "ci", "tag:ci");
  link(r.h, "sys", "c", "tag:db");
  r.devices.set(ADDR, { tags: ["tag:ci"] });
  let c = await r.signIn();
  r.devices.set(ADDR, { tags: ["tag:web"] });
  assert.equal((await r.req("/api/nodes", { cookie: c })).status, 200, "within the cache the old answer holds");
  r.pastCache();
  assert.equal((await r.req("/api/nodes", { cookie: c })).status, 401);
  assert.equal(r.h.auth!.sessions.list().length, 0);
  // the device's last tag taken off: whois knows the device but gives no identity; it is the session's device, so the session ends,
  // and the tag put back does not bring the old cookie back
  r.devices.set(ADDR, { tags: ["tag:ci"] });
  r.pastCache();
  c = await r.signIn();
  r.devices.set(ADDR, { tags: [] });
  r.pastCache();
  const last = await r.req("/api/auth/as-root", { method: "DELETE", cookie: c });
  assert.equal(last.status, 401);
  assert.equal(r.h.auth!.sessions.list().length, 0, "the session is gone");
  assert.deepEqual(r.audits("/api/auth/as-root").at(-1)?.tailnet, { subject: "tag:ci", source: "socket", reason: "unlinked" });
  r.devices.set(ADDR, { tags: ["tag:ci"] });
  r.pastCache();
  assert.equal((await r.req("/api/nodes", { cookie: c })).status, 401, "the old cookie stays out");
  // the device gone from the tailnet (404): 401, but the session is kept, as for a request that came another way
  c = await r.signIn();
  r.devices.delete(ADDR);
  r.pastCache();
  assert.equal((await r.req("/api/nodes", { cookie: c })).status, 401);
  assert.equal(r.h.auth!.sessions.list().length, 1);
  r.devices.set(ADDR, { tags: ["tag:ci"] });
  r.pastCache();
  assert.equal((await r.req("/api/nodes", { cookie: c })).status, 200);
  r.h.auth!.sessions.endAll("virt", "ci");
  // a linked tag of another account added to the device
  r.devices.set(ADDR, { tags: ["tag:ci"] });
  r.pastCache();
  c = await r.signIn();
  r.devices.set(ADDR, { tags: ["tag:ci", "tag:db"] });
  r.pastCache();
  const ended = await r.req("/api/auth/as-root", { method: "DELETE", cookie: c });
  assert.equal(ended.status, 401);
  assert.equal(r.h.auth!.sessions.list().length, 0);
  assert.deepEqual(r.audits("/api/auth/as-root").at(-1)?.tailnet, { subject: "tag:ci", source: "socket", reason: "tag-conflict" });
  // an unlinked tag added: nothing changes
  r.devices.set(ADDR, { tags: ["tag:ci"] });
  r.pastCache();
  c = await r.signIn();
  r.devices.set(ADDR, { tags: ["tag:ci", "tag:x"] });
  r.pastCache();
  assert.equal((await r.req("/api/nodes", { cookie: c })).status, 200);
  // a tag session whose device now shows another (unlinked) user: another login ends it
  r.devices.set(ADDR, { login: "bob@github", tags: ["tag:ci"] });
  r.pastCache();
  c = await r.signIn();
  r.devices.set(ADDR, { login: "carol@github", tags: ["tag:ci"] });
  r.pastCache();
  const changed = await r.req("/api/auth/as-root", { method: "DELETE", cookie: c });
  assert.equal(changed.status, 401);
  assert.deepEqual(r.audits("/api/auth/as-root").at(-1)?.tailnet, { subject: "tag:ci", source: "socket", reason: "changed" });
});

test("audit: a Tailscale session's requests carry the subject and the source; a password session's carry nothing", async () => {
  const r = await rig("socket");
  guest(r.h);
  link(r.h, "virt", "guest", "alice@github");
  r.devices.set(ADDR, { login: "alice@github" });
  const c = await r.signIn();
  assert.deepEqual(r.audits("/api/auth/login-tailscale")[0]?.tailnet, { login: "alice@github", subject: "alice@github", source: "socket", node: NODE_NAME, address: ADDR });
  assert.equal((await r.req("/api/auth/as-root", { method: "DELETE", cookie: c })).status, 200);
  assert.deepEqual(r.audits("/api/auth/as-root").at(-1)?.tailnet, { subject: "alice@github", source: "socket" });
  const pw = await r.req("/api/auth/login", { method: "POST", body: { name: "guest", password: "pw-guest" }, addr: "100.64.3.3" });
  const pc = (pw.headers.get("set-cookie") ?? "").split(";")[0];
  assert.equal((await r.req("/api/auth/as-root", { method: "DELETE", cookie: pc, addr: "100.64.3.3" })).status, 200);
  assert.equal(r.audits("/api/auth/as-root").at(-1)?.tailnet, undefined);
  assert.equal(r.audits("/api/auth/login").at(-1)?.tailnet, undefined);
  // a 503 of the binding is written with the session's subject
  r.pastCache();
  r.api!.state.down = true;
  assert.equal((await r.req("/api/auth/as-root", { method: "DELETE", cookie: c })).status, 503);
  assert.deepEqual(r.audits("/api/auth/as-root").at(-1)?.tailnet, { subject: "alice@github", source: "socket" }, "the session is kept, so no reason");
  assert.ok(!r.lines.join("\n").includes(r.api!.socket), "no line holds the socket path");
  assert.ok(!r.lines.join("\n").includes("nStable1"), "nor a part of the whois answer that is not logged");
});

test("spoof through the gate: a password session ignores tailnet headers; a peer that is not listed gets no identity; no route sees the headers", async () => {
  const r = await rig("headers");
  guest(r.h);
  link(r.h, "virt", "guest", "alice@github");
  const seen: Record<string, string>[] = [];
  r.h.post("/api/test-echo", async (c) => {
    seen.push(Object.fromEntries(Object.entries(c.req.header()).filter(([k]) => k.startsWith("tailscale-"))));
    await c.req.json().catch(() => null);
    return c.json({ ok: true });
  });
  const pw = await r.req("/api/auth/login", { method: "POST", body: { name: "guest", password: "pw-guest" } });
  const pc = (pw.headers.get("set-cookie") ?? "").split(";")[0];
  const forged = {
    "tailscale-user-login": "bob@github",
    "tailscale-user-name": "Bob",
    "tailscale-user-profile-pic": "https://x",
    "tailscale-app-capabilities": "{}",
    "tailscale-headers-info": "x",
    "tailscale-funnel-request": "?1",
  };
  for (const peer of ["127.0.0.1", "192.0.2.9"]) {
    const me = await r.req("/api/auth/me", { cookie: pc, peer, headers: forged });
    assert.equal(me.status, 200);
    assert.equal(((await me.json()) as Record<string, unknown>).method, "password");
    assert.equal((await r.req("/api/test-echo", { method: "POST", cookie: pc, peer, headers: forged })).status, 200);
  }
  assert.deepEqual(seen, [{}, {}], "no route handler sees a tailscale-* header");
  const spoof = await r.req("/api/auth/login-tailscale", { method: "POST", peer: "192.0.2.9", headers: { "tailscale-user-login": "alice@github" } });
  assert.equal(spoof.status, 401);
  assert.deepEqual(await spoof.json(), { error: "sign-in failed" });
  // FILEDECK_TRUSTED_PROXIES 1 and a forged X-Forwarded-For naming the listed proxy change nothing
  const spoof2 = await r.req("/api/auth/login-tailscale", { method: "POST", peer: "192.0.2.9", addr: "127.0.0.1", headers: { "tailscale-user-login": "alice@github" } });
  assert.equal(spoof2.status, 401);
});

test("spoof over a real server: forged tailnet headers reach neither a later handler nor a proxied agent request, with or without a body", async () => {
  // a fake agent that answers with the tailscale-* headers it got
  const got: Record<string, string>[] = [];
  const agent = http.createServer((req, res) => {
    // (the hub's own presence lookups carry nothing of the client's request; only the proxied requests count here)
    if (!(req.url ?? "").startsWith("/api/auth/")) got.push(Object.fromEntries(Object.entries(req.headers).filter(([k]) => k.startsWith("tailscale-")) as [string, string][]));
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
  });
  await new Promise<void>((res) => agent.listen(0, "127.0.0.1", res));
  const agentPort = (agent.address() as AddressInfo).port;
  // 127.0.0.1 is not a listed proxy here
  const r = await rig("headers", { env: { NODES: `t=http://127.0.0.1:${agentPort}`, FILEDECK_TAILSCALE_PROXIES: "192.0.2.1/32", FILEDECK_TRUSTED_PROXIES: "0" } });
  const seen: Record<string, string>[] = [];
  r.h.post("/api/test-echo", async (c) => {
    await c.req.json().catch(() => null);
    seen.push(Object.fromEntries(Object.entries(c.req.header()).filter(([k]) => k.startsWith("tailscale-"))));
    const incoming = (c.env as { incoming: http.IncomingMessage }).incoming;
    seen.push(Object.fromEntries(Object.entries(incoming.headers).filter(([k]) => k.startsWith("tailscale-")) as [string, string][]));
    return c.json({ ok: true });
  });
  const server = await new Promise<ReturnType<typeof serve>>((res) => {
    const s = serve({ fetch: r.h.fetch, port: 0, hostname: "127.0.0.1" }, () => res(s));
  });
  const port = (server.address() as AddressInfo).port;
  const send = (p: string, method: string, cookie: string, body?: string) =>
    new Promise<number>((resolve, reject) => {
      const req = http.request(
        {
          host: "127.0.0.1",
          port,
          path: p,
          method,
          agent: false,
          headers: {
            cookie,
            "tailscale-user-login": "alice@github",
            "Tailscale-User-Name": "Alice",
            "tailscale-app-capabilities": '{"x":[{}]}',
            "tailscale-headers-info": "https://tailscale.com/s/serve-headers",
            "tailscale-funnel-request": "?1",
            ...(body !== undefined ? { "content-type": "application/json", "content-length": String(Buffer.byteLength(body)) } : {}),
          },
        },
        (res) => {
          res.resume();
          res.on("end", () => resolve(res.statusCode ?? 0));
        },
      );
      req.on("error", reject);
      req.end(body);
    });
  try {
    // a system user (its machines are not hidden: the fake agent's lookup gives no answer)
    const login = await r.req("/api/auth/login", { method: "POST", body: { name: "alice", password: "right-pw" } });
    assert.equal(login.status, 200);
    const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0]!;
    assert.equal(await send("/api/test-echo", "POST", cookie, '{"a":1}'), 200);
    assert.deepEqual(seen, [{}, {}], "neither the request nor the node request keeps them");
    assert.equal(await send("/api/nodes/t/api/fs/list?path=/", "GET", cookie), 200);
    assert.equal(await send("/api/nodes/t/api/fs/mkdir", "POST", cookie, '{"path":"/x"}'), 200);
    assert.deepEqual(got, [{}, {}], "the agent sees none of them");
    const ts = await send("/api/auth/login-tailscale", "POST", "", "{}");
    assert.equal(ts, 401, "a peer that is not listed has no identity");
  } finally {
    server.close();
    (server as unknown as { closeAllConnections?(): void }).closeAllConnections?.();
    agent.closeAllConnections();
    agent.close();
  }
});

test("link change ends sessions: the link removed, the next request is 401", async () => {
  const r = await rig("headers");
  guest(r.h);
  link(r.h, "virt", "guest", "alice@github");
  r.devices.set(ADDR, { login: "alice@github" });
  const c = await r.signIn();
  assert.equal((await r.req("/api/nodes", { cookie: c })).status, 200);
  const before = r.h.auth!.accounts.identity("virt", "guest")!;
  link(r.h, "virt", "guest");
  r.h.auth!.accounts.bumpEpoch("virt", "guest");
  await r.h.accountChanged(before);
  assert.equal((await r.req("/api/nodes", { cookie: c })).status, 401);
  // the link alone, without the epoch: the binding ends it too
  link(r.h, "virt", "guest", "alice@github");
  const c2 = await r.signIn();
  link(r.h, "virt", "guest");
  assert.equal((await r.req("/api/nodes", { cookie: c2 })).status, 401);
  assert.equal(r.h.auth!.sessions.list().length, 0);
});

test("as root: a Tailscale session is no proof; the password still is", async () => {
  const r = await rig("headers", { env: { FILEDECK_ADMINS: "alice" } });
  link(r.h, "sys", "alice", "alice@github");
  r.devices.set(ADDR, { login: "alice@github" });
  const c = await r.signIn();
  const none = await r.req("/api/auth/as-root", { method: "POST", cookie: c, body: {} });
  assert.equal(none.status, 401);
  assert.deepEqual(await none.json(), { error: "sign-in failed" });
  const wrong = await r.req("/api/auth/as-root", { method: "POST", cookie: c, body: { password: "wrong" } });
  assert.equal(wrong.status, 401);
  const ok = await r.req("/api/auth/as-root", { method: "POST", cookie: c, body: { password: "right-pw" } });
  assert.equal(ok.status, 200);
  assert.ok(typeof ((await ok.json()) as { asRootUntil?: number }).asRootUntil === "number");
});

test("auth off: no tailnet routes, me says auth false, and the header reaches a route unchanged", async () => {
  const h = createHub(
    loadConfig({
      FILEDECK_MODE: "hub",
      NODES: "t=http://127.0.0.1:9",
      FILEDECK_TAILSCALE_HEADERS: "on",
      FILEDECK_TAILSCALE_PROXIES: "127.0.0.1/32",
      FILEDECK_TRUSTED_PROXIES: "1",
    } as never),
    undefined,
    () => {},
  );
  try {
    const seen: (string | null)[] = [];
    h.post("/api/test-echo", (c) => {
      seen.push(c.req.header("tailscale-user-login") ?? null);
      return c.json({ ok: true });
    });
    const peer = { incoming: { socket: { remoteAddress: "127.0.0.1", encrypted: false } } } as never;
    const hd = { "tailscale-user-login": "alice@github", "x-forwarded-proto": "https", "content-type": "application/json" };
    assert.deepEqual(await (await h.request("http://localhost/api/auth/me", { headers: hd }, peer)).json(), { auth: false });
    assert.equal((await h.request("http://localhost/api/auth/login-tailscale", { method: "POST", headers: hd, body: "{}" }, peer)).status, 404);
    const t = await h.request("http://localhost/api/auth/tailnet", { headers: hd }, peer);
    assert.ok(!(await t.text()).includes("alice@github"), "no tailnet route answers");
    assert.equal((await h.request("http://localhost/api/test-echo", { method: "POST", headers: hd, body: "{}" }, peer)).status, 200);
    assert.deepEqual(seen, ["alice@github"]);
  } finally {
    await h.close();
  }
});

test("limiter families: password attempts with the name tailnet:<login> do not block that login's Tailscale sign-in", async () => {
  const r = await rig("headers");
  guest(r.h);
  link(r.h, "virt", "guest", "alice@github");
  r.devices.set(ADDR, { login: "alice@github" });
  const tries = await Promise.all(
    [1, 2, 3, 4, 5, 6].map((i) => r.req("/api/auth/login", { method: "POST", addr: `100.64.9.${i}`, body: { name: "tailnet:alice@github", password: "x" } })),
  );
  assert.ok(tries.some((t) => t.status === 429) || tries.every((t) => t.status === 401));
  assert.equal(r.h.auth!.limiter.check("tailnet:alice@github", "203.0.113.7").ok, false, "that password name is blocked now");
  const res = await r.req("/api/auth/login-tailscale", { method: "POST" });
  assert.equal(res.status, 200, "alice's Tailscale sign-in is not");
});

test("event streams of a Tailscale session go back through the gate at least once a minute; a password session's stay", async () => {
  // a fake agent with a change feed that stays open
  const open = new Set<http.ServerResponse>();
  const agent = http.createServer((req, res) => {
    if ((req.url ?? "").startsWith("/api/events")) {
      open.add(res);
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
      res.write(": open\n\n");
      res.on("close", () => open.delete(res));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  });
  await new Promise<void>((res) => agent.listen(0, "127.0.0.1", res));
  try {
    const port = (agent.address() as AddressInfo).port;
    const r = await rig("socket", { env: { NODES: `t=http://127.0.0.1:${port}` }, streamCheckMs: 50 });
    r.h.auth!.accounts.create({ name: "ci", admin: false, nodes: { t: { runAs: "nobody", grants: [{ path: "/", write: false }] } } });
    r.h.auth!.accounts.create({ name: "guest", password: "pw-guest", admin: false, nodes: { t: { runAs: "nobody", grants: [{ path: "/", write: false }] } } });
    link(r.h, "virt", "ci", "tag:ci");
    r.devices.set(ADDR, { tags: ["tag:ci"] });
    const c = await r.signIn();
    const pw = await r.req("/api/auth/login", { method: "POST", addr: "100.64.5.5", body: { name: "guest", password: "pw-guest" } });
    const pc = (pw.headers.get("set-cookie") ?? "").split(";")[0];
    const ts = await r.req("/api/nodes/t/api/events?path=/", { cookie: c, headers: { accept: "text/event-stream" } });
    const ps = await r.req("/api/nodes/t/api/events?path=/", { cookie: pc, addr: "100.64.5.5", headers: { accept: "text/event-stream" } });
    assert.equal(ts.status, 200);
    assert.equal(ps.status, 200);
    assert.equal(r.h.streams!.size(), 2);
    // the tag is taken off: no request comes, but the stream ends once its minute is up
    r.devices.set(ADDR, { tags: ["tag:web"] });
    r.clock.t += 30_000;
    await new Promise((res) => setTimeout(res, 200));
    assert.equal(r.h.streams!.size(), 2, "within the minute it stays");
    r.clock.t += 31_000;
    const end = Date.now() + 5_000;
    while (r.h.streams!.size() !== 1 && Date.now() < end) await new Promise((res) => setTimeout(res, 20));
    assert.equal(r.h.streams!.size(), 1, "the Tailscale stream ended; the password one stays");
    // reconnecting goes through the gate, which ends the session
    const again = await r.req("/api/nodes/t/api/events?path=/", { cookie: c, headers: { accept: "text/event-stream" } });
    assert.equal(again.status, 401);
    await ts.body?.cancel().catch(() => undefined);
    await ps.body?.cancel().catch(() => undefined);
  } finally {
    for (const o of open) o.destroy();
    agent.closeAllConnections();
    agent.close();
  }
});

test("a cookie used only from outside the tailnet does not stay alive: it ends at the idle limit", async () => {
  const r = await rig("headers", { env: { FILEDECK_SESSION_IDLE_SECONDS: "600" } });
  guest(r.h);
  link(r.h, "virt", "guest", "alice@github");
  r.devices.set(ADDR, { login: "alice@github" });
  const c = await r.signIn();
  for (let i = 0; i < 4; i++) {
    r.clock.t += 200_000;
    assert.equal((await r.req("/api/nodes", { cookie: c, peer: "192.0.2.9" })).status, 401);
  }
  // 800 s since the last admitted request: past the 600 s idle limit
  assert.equal((await r.req("/api/nodes", { cookie: c })).status, 401);
  assert.equal(r.h.auth!.sessions.list().length, 0);
  // an admitted request does keep it alive
  const c2 = await r.signIn();
  for (let i = 0; i < 4; i++) {
    r.clock.t += 200_000;
    assert.equal((await r.req("/api/nodes", { cookie: c2 })).status, 200);
  }
});

test("mount order: readTailnet right after trustProxies, stripTailnetHeaders right after it, both before webHeaders, requestGuard and audit", async () => {
  const r = await rig("headers");
  const names = r.h.routes.filter((x) => x.path === "/*" && x.method === "ALL").map((x) => x.handler.name);
  const at = (n: string) => {
    const i = names.indexOf(n);
    assert.ok(i >= 0, `${n} is mounted (${names.join(", ")})`);
    return i;
  };
  assert.equal(at("readTailnet"), at("trustProxies") + 1);
  assert.equal(at("stripTailnetHeaders"), at("readTailnet") + 1);
  for (const later of ["webHeaders", "requestGuard", "audit"]) assert.ok(at(later) > at("stripTailnetHeaders"), later);
});
