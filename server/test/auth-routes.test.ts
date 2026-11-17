import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { generateKeyPairSync, sign } from "node:crypto";
import net from "node:net";
import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import { createHub } from "../src/hub.ts";
import type { SystemAuth } from "../src/auth/routes.ts";
import { loadConfig } from "../src/config.ts";
import { loginMessage } from "../src/auth/sshkey.ts";

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "filedeck-authroutes-")));
fs.writeFileSync(path.join(tmp, "index.html"), "<!doctype html><title>t</title>");
fs.writeFileSync(path.join(tmp, "favicon.svg"), "<svg xmlns='http://www.w3.org/2000/svg'/>");
const hubs: { close(): Promise<void> }[] = [];
after(async () => {
  for (const h of hubs) await h.close().catch(() => {});
  fs.rmSync(tmp, { recursive: true, force: true });
});

type Hub = ReturnType<typeof createHub>;
type Clock = { t: number };

function makeHub(env: Record<string, string> = {}, sink?: (l: string) => void, system?: SystemAuth): { h: Hub; clock: Clock } {
  const clock: Clock = { t: Date.now() };
  const h = createHub(
    loadConfig({ FILEDECK_MODE: "hub", FILEDECK_AUTH: "on", FILEDECK_AGENT_TOKEN: "agent-secret", FILEDECK_STATIC: tmp, NODES: "t=http://127.0.0.1:9", ...env } as never),
    undefined,
    sink ?? (() => {}),
    { now: () => clock.t, ...(system ? { system } : {}) },
  );
  hubs.push(h);
  return { h, clock };
}

const peer = (addr: string, encrypted = false) => ({ incoming: { socket: { remoteAddress: addr, encrypted } } });
const LOCAL = "http://localhost";

async function post(h: Hub, p: string, body: unknown, o: { addr?: string; base?: string; tls?: boolean; headers?: Record<string, string> } = {}): Promise<Response> {
  return h.request(
    (o.base ?? LOCAL) + p,
    { method: "POST", headers: { "content-type": "application/json", ...o.headers }, body: JSON.stringify(body) },
    peer(o.addr ?? "127.0.0.1", o.tls) as never,
  );
}

const get = (h: Hub, p: string, cookie?: string) => h.request(LOCAL + p, { headers: cookie ? { cookie } : {} }, peer("127.0.0.1") as never);

/** The `name=value` part of a Set-Cookie header. */
const cookieOf = (r: Response) => (r.headers.get("set-cookie") ?? "").split(";")[0] ?? "";

async function timed<T>(fn: () => Promise<T>): Promise<[T, number]> {
  const t0 = performance.now();
  const v = await fn();
  return [v, performance.now() - t0];
}

test("auth off: /api/auth/me says so and nothing is gated", async () => {
  const h = createHub(loadConfig({ FILEDECK_MODE: "hub", FILEDECK_STATIC: tmp, NODES: "t=http://127.0.0.1:9" } as never));
  hubs.push(h);
  const me = await h.request("/api/auth/me");
  assert.equal(me.status, 200);
  assert.deepEqual(await me.json(), { auth: false });
  assert.equal((await h.request("/api/nodes")).status, 200);
  assert.equal((await h.request("/api/auth/login", { method: "POST" })).status, 404, "no sign-in routes while auth is off");
});

test("gate: signed-out requests get 401 with the header; open paths stay open", async () => {
  const { h } = makeHub();
  const r = await get(h, "/api/nodes");
  assert.equal(r.status, 401);
  assert.equal(r.headers.get("x-filedeck-auth"), "signed-out");
  assert.deepEqual(await r.json(), { error: "signed out" });
  const p = await h.request("/api/transfer", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  assert.equal(p.status, 401);
  assert.equal((await get(h, "/healthz")).status, 200);
  assert.equal((await get(h, "/")).status, 200);
  assert.equal((await get(h, "/some/deep/link")).status, 200, "the app shell for a deep link");
  assert.equal((await get(h, "/assets/missing.js")).status, 404, "assets are not gated");
  const me = await get(h, "/api/auth/me");
  assert.equal(me.status, 401);
  assert.equal(me.headers.get("x-filedeck-auth"), "signed-out");
  assert.equal((await get(h, "/api/auth/me", "__Host-filedeck=" + "A".repeat(43))).status, 401, "an unknown cookie");
});

test("password sign-in sets the cookie, and /api/auth/me knows the name", async () => {
  const { h } = makeHub();
  h.auth!.accounts.create({ name: "guest1", password: "pw-guest-1", admin: false, nodes: {} });
  const r = await post(h, "/api/auth/login", { name: "guest1", password: "pw-guest-1" });
  assert.equal(r.status, 200);
  const sc = r.headers.get("set-cookie") ?? "";
  assert.match(sc, /^__Host-filedeck=[A-Za-z0-9_-]{43}; .*HttpOnly.*Secure.*SameSite=Lax/);
  assert.match(sc, /Path=\//);
  const me = await get(h, "/api/auth/me", cookieOf(r));
  assert.equal(me.status, 200);
  assert.deepEqual(await me.json(), { auth: true, kind: "virt", name: "guest1", admin: false });
  assert.equal((await get(h, "/api/nodes", cookieOf(r))).status, 200);
});

test("a TLS socket needs no loopback peer; an https URL on a plain socket is not HTTPS", async () => {
  const { h } = makeHub();
  h.auth!.accounts.create({ name: "boss", password: "pw-boss", admin: true, nodes: {} });
  const r = await post(h, "/api/auth/login", { name: "boss", password: "pw-boss" }, { base: "https://files.example", addr: "10.0.0.5", tls: true });
  assert.equal(r.status, 200);
  const me = await h.request("https://files.example/api/auth/me", { headers: { cookie: cookieOf(r) } }, peer("10.0.0.5", true) as never);
  assert.deepEqual(await me.json(), { auth: true, kind: "virt", name: "boss", admin: true });
  const plain = await post(h, "/api/auth/login", { name: "boss", password: "pw-boss" }, { base: "https://files.example", addr: "10.0.0.5", tls: false });
  assert.equal(plain.status, 403);
  assert.deepEqual(await plain.json(), { error: "sign-in needs HTTPS" });
});

test("uniform failure: wrong password, unknown name and system name look the same", async () => {
  const { h } = makeHub({ FILEDECK_ADMINS: "alice" });
  h.auth!.accounts.create({ name: "guest1", password: "pw-guest-1", admin: false, nodes: {} });
  const cases = [
    { name: "guest1", password: "wrong" },
    { name: "nobody", password: "whatever" },
    { name: "alice", password: "whatever" },
    { name: "root", password: "whatever" },
    { name: 7, password: null },
  ];
  for (const [i, b] of cases.entries()) {
    const [r, ms] = await timed(() => post(h, "/api/auth/login", b, { addr: `127.0.0.${i + 2}` }));
    assert.equal(r.status, 401, JSON.stringify(b));
    assert.deepEqual(await r.json(), { error: "sign-in failed" });
    assert.equal(r.headers.get("set-cookie"), null);
    assert.ok(ms >= 495, `${JSON.stringify(b)} answered after ${ms} ms`);
  }
});

test("https required: plain HTTP from a remote peer is refused, a trusted proxy's https is accepted", async () => {
  const a = makeHub().h;
  a.auth!.accounts.create({ name: "guest1", password: "pw-guest-1", admin: false, nodes: {} });
  const r = await post(a, "/api/auth/login", { name: "guest1", password: "pw-guest-1" }, { base: "http://files.example", addr: "10.0.0.5" });
  assert.equal(r.status, 403);
  assert.deepEqual(await r.json(), { error: "sign-in needs HTTPS" });
  // a client's own X-Forwarded-Proto is not believed without a trusted proxy
  const spoof = await post(a, "/api/auth/login", { name: "guest1", password: "pw-guest-1" }, { base: "http://files.example", addr: "10.0.0.5", headers: { "x-forwarded-proto": "https" } });
  assert.equal(spoof.status, 403);
  const k = await post(a, "/api/auth/login-key", { name: "guest1", publicKey: "x", challenge: "x", signature: "x" }, { base: "http://files.example", addr: "10.0.0.5" });
  assert.equal(k.status, 403);

  const b = makeHub({ FILEDECK_TRUSTED_PROXIES: "1" }).h;
  b.auth!.accounts.create({ name: "guest1", password: "pw-guest-1", admin: false, nodes: {} });
  const ok = await post(b, "/api/auth/login", { name: "guest1", password: "pw-guest-1" }, { base: "http://files.example", addr: "10.0.0.5", headers: { "x-forwarded-proto": "http, https", "x-forwarded-for": "203.0.113.9" } });
  assert.equal(ok.status, 200);
  const no = await post(b, "/api/auth/login", { name: "guest1", password: "pw-guest-1" }, { base: "http://files.example", addr: "10.0.0.5", headers: { "x-forwarded-proto": "https, http" } });
  assert.equal(no.status, 403, "only the last X-Forwarded-Proto value counts");
  // with a proxy configured, a loopback peer is the proxy: plain HTTP from it is not enough
  const lo = await post(b, "/api/auth/login", { name: "guest1", password: "pw-guest-1" }, { base: "http://localhost", addr: "127.0.0.1" });
  assert.equal(lo.status, 403);
  assert.deepEqual(await lo.json(), { error: "sign-in needs HTTPS" });
});

test("limiter: five failures block, the block ends, success resets the name", async () => {
  const { h, clock } = makeHub();
  h.auth!.accounts.create({ name: "guest1", password: "pw-guest-1", admin: false, nodes: {} });
  for (let i = 0; i < 5; i++) assert.equal((await post(h, "/api/auth/login", { name: "guest1", password: "bad" })).status, 401);
  const [blocked, ms] = await timed(() => post(h, "/api/auth/login", { name: "guest1", password: "pw-guest-1" }));
  assert.equal(blocked.status, 429);
  assert.ok(Number(blocked.headers.get("retry-after")) >= 1);
  assert.equal(blocked.headers.get("set-cookie"), null);
  assert.ok(ms >= 495, "a refused attempt also waits");
  // the name is blocked from any address
  assert.equal((await post(h, "/api/auth/login", { name: "guest1", password: "pw-guest-1" }, { addr: "127.0.0.9" })).status, 429);
  // 429 answers are not counted as failures: two seconds later the block of 2^0 s is over
  clock.t += 2000;
  assert.equal((await post(h, "/api/auth/login", { name: "guest1", password: "pw-guest-1" }, { addr: "127.0.0.9" })).status, 200);
  // success cleared the name: four more failures (from another address) do not block it
  for (let i = 0; i < 4; i++) assert.equal((await post(h, "/api/auth/login", { name: "guest1", password: "bad" }, { addr: "127.0.0.8" })).status, 401);
  assert.equal((await post(h, "/api/auth/login", { name: "guest1", password: "pw-guest-1" }, { addr: "127.0.0.8" })).status, 200);
});

test("limiter: one address is limited across names", async () => {
  const { h } = makeHub();
  h.auth!.accounts.create({ name: "guest1", password: "pw-guest-1", admin: false, nodes: {} });
  for (let i = 0; i < 5; i++) assert.equal((await post(h, "/api/auth/login", { name: `n${i}`, password: "bad" }, { addr: "127.0.0.7" })).status, 401);
  assert.equal((await post(h, "/api/auth/login", { name: "guest1", password: "pw-guest-1" }, { addr: "127.0.0.7" })).status, 429);
  assert.equal((await post(h, "/api/auth/login", { name: "guest1", password: "pw-guest-1" }, { addr: "127.0.0.6" })).status, 200);
});

function sshKey() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const raw = Buffer.from(publicKey.export({ format: "jwk" }).x as string, "base64url");
  const f = (b: Buffer) => {
    const l = Buffer.alloc(4);
    l.writeUInt32BE(b.length);
    return Buffer.concat([l, b]);
  };
  const line = `ssh-ed25519 ${Buffer.concat([f(Buffer.from("ssh-ed25519")), f(raw)]).toString("base64")}`;
  return { line, privateKey };
}

test("key sign-in: challenge, signature, cookie; a challenge works once", async () => {
  const { h } = makeHub();
  h.auth!.accounts.create({ name: "guest1", admin: false, nodes: {} });
  const k = sshKey();
  h.auth!.accounts.addKey("guest1", k.line + " guest@laptop");
  const ch = await post(h, "/api/auth/challenge", { name: "guest1" });
  assert.equal(ch.status, 200);
  const { challenge, hubId } = (await ch.json()) as { challenge: string; hubId: string };
  assert.equal(hubId, h.auth!.db.hubId);
  assert.equal(Buffer.from(challenge, "base64").length, 32);
  const sig = sign(null, loginMessage(hubId, "guest1", Buffer.from(challenge, "base64")), k.privateKey).toString("base64");
  const body = { name: "guest1", publicKey: k.line + " other comment", challenge, signature: sig };
  const r = await post(h, "/api/auth/login-key", body);
  assert.equal(r.status, 200);
  assert.match(r.headers.get("set-cookie") ?? "", /^__Host-filedeck=[A-Za-z0-9_-]{43}; .*HttpOnly.*Secure.*SameSite=Lax/);
  assert.deepEqual(await (await get(h, "/api/auth/me", cookieOf(r))).json(), { auth: true, kind: "virt", name: "guest1", admin: false });
  const [again, ms] = await timed(() => post(h, "/api/auth/login-key", body));
  assert.equal(again.status, 401);
  assert.deepEqual(await again.json(), { error: "sign-in failed" });
  assert.ok(ms >= 495);
  // a key that is not on the account fails, even with a good signature over a fresh challenge
  const other = sshKey();
  const c2 = ((await (await post(h, "/api/auth/challenge", { name: "guest1" })).json()) as { challenge: string }).challenge;
  const s2 = sign(null, loginMessage(hubId, "guest1", Buffer.from(c2, "base64")), other.privateKey).toString("base64");
  assert.equal((await post(h, "/api/auth/login-key", { name: "guest1", publicKey: other.line, challenge: c2, signature: s2 })).status, 401);
});

test("challenge: always 200, also for an unknown name; limited per address", async () => {
  const { h } = makeHub();
  const r = await post(h, "/api/auth/challenge", { name: "nobody" });
  assert.equal(r.status, 200);
  for (let i = 1; i < 20; i++) assert.equal((await post(h, "/api/auth/challenge", { name: `n${i}` }, { addr: "127.0.0.1" })).status, 200);
  const over = await post(h, "/api/auth/challenge", { name: "x" }, { addr: "127.0.0.1" });
  assert.equal(over.status, 429);
  assert.ok(Number(over.headers.get("retry-after")) >= 1);
  assert.equal((await post(h, "/api/auth/challenge", { name: "x" }, { addr: "127.0.0.2" })).status, 200, "another address is not affected");
});

test("logout ends the session and clears the cookie", async () => {
  const { h } = makeHub();
  h.auth!.accounts.create({ name: "guest1", password: "pw-guest-1", admin: false, nodes: {} });
  const r = await post(h, "/api/auth/login", { name: "guest1", password: "pw-guest-1" });
  const cookie = cookieOf(r);
  assert.equal((await get(h, "/api/nodes", cookie)).status, 200);
  const out = await h.request(LOCAL + "/api/auth/logout", { method: "POST", headers: { cookie } }, peer("127.0.0.1") as never);
  assert.equal(out.status, 200);
  assert.match(out.headers.get("set-cookie") ?? "", /^__Host-filedeck=; Max-Age=0; .*HttpOnly.*Secure.*SameSite=Lax/);
  assert.equal((await get(h, "/api/nodes", cookie)).status, 401);
});

test("a system user from FILEDECK_ADMINS is an admin (session made directly)", async () => {
  const { h } = makeHub({ FILEDECK_ADMINS: "alice" });
  const raw = h.auth!.sessions.create("sys", "alice");
  assert.deepEqual(await (await get(h, "/api/auth/me", `__Host-filedeck=${raw}`)).json(), { auth: true, kind: "sys", name: "alice", admin: true });
  const raw2 = h.auth!.sessions.create("sys", "bob");
  assert.deepEqual(await (await get(h, "/api/auth/me", `__Host-filedeck=${raw2}`)).json(), { auth: true, kind: "sys", name: "bob", admin: false });
});

test("du token needs an account when auth is on", async () => {
  const TOKEN = "du-token-" + "y".repeat(30);
  const a = makeHub({ FILEDECK_API_TOKEN: TOKEN }).h;
  const r = await a.request("/api/nodes/t/api/du?path=/", { headers: { "x-filedeck-token": TOKEN } });
  assert.equal(r.status, 403);
  assert.deepEqual(await r.json(), { error: "FILEDECK_API_TOKEN_ACCOUNT is not set" });
  // with an account the token passes the gate (the node itself is not reachable here)
  const b = makeHub({ FILEDECK_API_TOKEN: TOKEN, FILEDECK_API_TOKEN_ACCOUNT: "sizes" }).h;
  const ok = await b.request("/api/nodes/t/api/du?path=/", { headers: { "x-filedeck-token": TOKEN } });
  // it reached the node proxy, which cannot reach the agent here
  assert.equal(ok.status, 502);
  assert.deepEqual(await ok.json(), { error: "agent unreachable" });
  const c = makeHub({ FILEDECK_API_TOKEN: TOKEN, FILEDECK_API_TOKEN_ACCOUNT: "root" }).h;
  const root = await c.request("/api/nodes/t/api/du?path=/", { headers: { "x-filedeck-token": TOKEN } });
  assert.equal(root.status, 403);
  assert.deepEqual(await root.json(), { error: "FILEDECK_API_TOKEN_ACCOUNT may not be root" });
});

test("gate: favicon, HEAD on an open path, and /api without a slash", async () => {
  const { h } = makeHub();
  assert.equal((await get(h, "/favicon.svg")).status, 200);
  const head = await h.request(LOCAL + "/", { method: "HEAD" }, peer("127.0.0.1") as never);
  assert.equal(head.status, 200);
  const api = await get(h, "/api");
  assert.equal(api.status, 401);
  assert.equal(api.headers.get("x-filedeck-auth"), "signed-out");
});

test("an https URL on a plain socket is refused, also through a real socket (absolute-form request line)", async () => {
  const { h } = makeHub({ FILEDECK_TRUSTED_PROXIES: "1" });
  h.auth!.accounts.create({ name: "guest1", password: "pw-guest-1", admin: false, nodes: {} });
  const fake = await post(h, "/api/auth/login", { name: "guest1", password: "pw-guest-1" }, { base: "https://files.example", addr: "10.0.0.5" });
  assert.equal(fake.status, 403);
  assert.deepEqual(await fake.json(), { error: "sign-in needs HTTPS" });
  // the same over a real socket: plain HTTP with an absolute https:// target
  const srv = await new Promise<ReturnType<typeof serve>>((res) => {
    const s: ReturnType<typeof serve> = serve({ fetch: h.fetch as never, port: 0, hostname: "127.0.0.1" }, () => res(s));
  });
  try {
    const port = (srv.address() as AddressInfo).port;
    const body = JSON.stringify({ name: "guest1", password: "pw-guest-1" });
    const raw = await new Promise<string>((res, rej) => {
      const sock = net.connect(port, "127.0.0.1");
      let out = "";
      sock.on("data", (d) => (out += d.toString("latin1")));
      sock.on("end", () => res(out));
      sock.on("error", rej);
      sock.write(`POST https://files.example/api/auth/login HTTP/1.1\r\nHost: files.example\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`);
    });
    assert.match(raw, /^HTTP\/1\.1 403 /);
    assert.ok(!/set-cookie/i.test(raw));
    assert.ok(raw.includes("sign-in needs HTTPS"));
  } finally {
    srv.close();
  }
});

test("root never signs in and never reaches the system check", async () => {
  const seen: string[] = [];
  const system: SystemAuth = { password: async (n) => (seen.push(n), true), key: async (n) => (seen.push(n), true) };
  const { h } = makeHub({}, undefined, system);
  const r = await post(h, "/api/auth/login", { name: "root", password: "anything" });
  assert.equal(r.status, 401);
  assert.deepEqual(await r.json(), { error: "sign-in failed" });
  assert.equal(r.headers.get("set-cookie"), null);
  assert.deepEqual(seen, []);
  // the same fake lets another system name in, so the refusal is the name, not the fake
  assert.equal((await post(h, "/api/auth/login", { name: "alice", password: "anything" })).status, 200);
});

test("limiter reserves attempts: of 10 parallel guesses for one name at most 5 reach the system check", async () => {
  let calls = 0;
  const system: SystemAuth = {
    password: async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 200));
      return false;
    },
    key: async () => false,
  };
  const { h } = makeHub({}, undefined, system);
  const rs = await Promise.all(Array.from({ length: 10 }, (_, i) => post(h, "/api/auth/login", { name: "alice", password: "guess" + i }, { addr: `127.0.1.${i + 1}` })));
  assert.ok(calls <= 5, `${calls} attempts reached the system check`);
  const statuses = rs.map((r) => r.status).sort();
  assert.equal(statuses.filter((s) => s === 401).length, calls);
  assert.equal(statuses.filter((s) => s === 429).length, 10 - calls);
});

test("no secrets in audit lines", async () => {
  const lines: string[] = [];
  const { h } = makeHub({}, (l) => lines.push(l));
  h.auth!.accounts.create({ name: "guest1", password: "pw-guest-1-secret", admin: false, nodes: {} });
  await post(h, "/api/auth/login", { name: "guest1", password: "wrong-secret-pw" });
  const r = await post(h, "/api/auth/login", { name: "guest1", password: "pw-guest-1-secret" });
  const value = cookieOf(r).split("=")[1] as string;
  assert.equal(value.length, 43);
  await h.request(LOCAL + "/api/auth/logout", { method: "POST", headers: { cookie: cookieOf(r) } }, peer("127.0.0.1") as never);
  assert.ok(lines.length >= 3);
  for (const l of lines) {
    assert.ok(!l.includes("wrong-secret-pw"), l);
    assert.ok(!l.includes("pw-guest-1-secret"), l);
    assert.ok(!l.includes(value), l);
  }
});
