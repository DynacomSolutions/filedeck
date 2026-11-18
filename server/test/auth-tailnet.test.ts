import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { trustProxies } from "../src/audit.ts";
import { cleanLogin, cleanTag, ProxyList, stripTailnetHeaders, TailnetSource, type TailnetAnswer } from "../src/auth/tailnet.ts";

const LISTED = "127.0.0.1";
const proxies = () => new ProxyList(["127.0.0.1/32", "::1/128"]);
const peer = (remoteAddress: string) => ({ incoming: { socket: { remoteAddress, encrypted: false } } });

/** A small app that answers with what the source sees for the request. */
function appFor(src: TailnetSource, hops = 0) {
  const app = new Hono();
  app.use("*", trustProxies(hops));
  app.get("/who", async (c) => c.json(await src.identify(c)));
  return app;
}

async function ask(app: Hono, from: string, headers: HeadersInit = {}): Promise<TailnetAnswer> {
  const r = await app.request("http://localhost/who", { headers }, peer(from) as never);
  assert.equal(r.status, 200);
  return (await r.json()) as TailnetAnswer;
}

/** A fake tailscaled LocalAPI on a unix socket in the private TMPDIR. `answer` decides each reply; every request is recorded. */
async function fakeLocalApi(answer: (addr: string) => { status: number; body?: unknown } | "hang") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fd-ts-"));
  const socket = path.join(dir, "ts.sock");
  const calls: { url: string; host: string | undefined; addr: string }[] = [];
  const server = http.createServer((req, res) => {
    const addr = new URL(req.url ?? "/", "http://x").searchParams.get("addr") ?? "";
    calls.push({ url: req.url ?? "", host: req.headers.host, addr });
    const a = answer(addr);
    if (a === "hang") return; // never answers
    res.writeHead(a.status, { "content-type": "application/json" });
    res.end(a.body === undefined ? "" : typeof a.body === "string" ? a.body : JSON.stringify(a.body));
  });
  await new Promise<void>((res) => server.listen(socket, res));
  return {
    socket,
    calls,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((res) => server.close(() => res()));
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

const whois = (login: string, tags?: string[], extra: Record<string, unknown> = {}) => ({
  status: 200,
  body: {
    Node: { ID: 7, StableID: "nStable7CNTRL", Name: "laptop.example-tailnet.ts.net.", Addresses: ["100.101.102.103/32"], ...(tags ? { Tags: tags } : {}), ...extra },
    UserProfile: { ID: 9, LoginName: login, DisplayName: "Alice Example" },
  },
});

test("clean: logins and tags are trimmed, lowercased and checked", () => {
  assert.equal(cleanLogin(" Alice@GitHub "), "alice@github");
  assert.equal(cleanLogin("alice@example.com"), "alice@example.com");
  assert.equal(cleanLogin("bob@passkey"), "bob@passkey");
  for (const bad of ["tagged-devices", "alice", "@github", "alice@", "alice@exa mple", "a".repeat(64) + "@" + "b".repeat(186) + ".com", "ali\nce@github", "alice@github\nx"]) {
    assert.equal(cleanLogin(bad), null, JSON.stringify(bad));
  }
  assert.equal(("a".repeat(64) + "@" + "b".repeat(186) + ".com").length, 255);
  assert.equal(cleanLogin("a".repeat(64) + "@" + "b".repeat(185) + ".com"), "a".repeat(64) + "@" + "b".repeat(185) + ".com"); // 254 passes
  assert.equal(cleanTag(" Tag:Server "), "tag:server");
  assert.equal(cleanTag("tag:web-1"), "tag:web-1");
  for (const bad of ["tag:", "tag:a_b", "tag:a.b", "server", "tag:" + "a".repeat(64), "tag:a\nb"]) assert.equal(cleanTag(bad), null, JSON.stringify(bad));
  assert.equal(cleanTag("tag:" + "a".repeat(63)), "tag:" + "a".repeat(63));
});

test("proxy list: addresses and ranges, IPv4-mapped IPv6 and zone ids", () => {
  const l = new ProxyList(["127.0.0.1/32", "::1/128"]);
  assert.ok(l.has("127.0.0.1"));
  assert.ok(l.has("::1"));
  assert.ok(l.has("::ffff:127.0.0.1"));
  assert.ok(!l.has("10.0.0.1"));
  assert.ok(!l.has("127.0.0.2"));
  assert.ok(!l.has("not an address"));
  const r = new ProxyList(["10.1.0.0/16", "fd00::5", "192.0.2.7"]);
  assert.ok(r.has("10.1.2.3"));
  assert.ok(!r.has("10.2.0.1"));
  assert.ok(r.has("fd00::5%eth0"));
  assert.ok(r.has("192.0.2.7"));
  assert.ok(!new ProxyList([]).has("127.0.0.1"));
  for (const bad of ["localhost", "10.0.0.0/33", "::1/129", "10.0.0.0/", "/8", "10.0.0.0/8/8", "10.0.0.0/x"]) {
    assert.throws(() => new ProxyList([bad]), { message: `FILEDECK_TAILSCALE_PROXIES: "${bad}" is not an IP address or range` }, bad);
  }
});

test("headers: a listed peer's login and RFC 2047 name; a repeated header gives none", async () => {
  const src = new TailnetSource({ headers: true, proxies: proxies() });
  assert.equal(src.mode, "headers");
  const app = appFor(src);
  assert.deepEqual(await ask(app, LISTED, { "Tailscale-User-Login": "Alice@GitHub", "Tailscale-User-Name": "=?utf-8?q?Al=C3=AFce?=" }), {
    login: "alice@github",
    displayName: "Alïce",
    tags: [],
    source: "headers",
  });
  assert.deepEqual(await ask(app, "::ffff:127.0.0.1", { "Tailscale-User-Login": "bob@passkey", "Tailscale-User-Name": "=?utf-8?b?Qm9iIEV4YW1wbGU=?=" }), {
    login: "bob@passkey",
    displayName: "Bob Example",
    tags: [],
    source: "headers",
  });
  // control and format characters are dropped, and the name is at most 128 characters
  const named = (await ask(app, LISTED, { "Tailscale-User-Login": "bob@passkey", "Tailscale-User-Name": "=?utf-8?q?B=0Ao=E2=80=AEb?= " + "x".repeat(300) })) as { displayName: string };
  assert.ok(named.displayName.startsWith("Bob "), named.displayName);
  assert.equal([...named.displayName].length, 128);
  // no name header: no display name
  assert.deepEqual(await ask(app, LISTED, { "Tailscale-User-Login": "bob@passkey" }), { login: "bob@passkey", tags: [], source: "headers" });
  // the login twice: none
  assert.deepEqual(
    await ask(app, LISTED, [
      ["Tailscale-User-Login", "alice@github"],
      ["Tailscale-User-Login", "alice@github"],
    ]),
    { none: true },
  );
  // a login that fails the rules, or none at all: none
  assert.deepEqual(await ask(app, LISTED, { "Tailscale-User-Login": "tagged-devices" }), { none: true });
  assert.deepEqual(await ask(app, LISTED, {}), { none: true });
});

test("spoofed headers: a peer that is not listed has no identity, whatever it forwards", async () => {
  const src = new TailnetSource({ headers: true, proxies: proxies() });
  for (const hops of [0, 1]) {
    const app = appFor(src, hops);
    assert.deepEqual(await ask(app, "192.0.2.9", { "Tailscale-User-Login": "alice@github" }), { none: true });
    assert.deepEqual(await ask(app, "192.0.2.9", { "Tailscale-User-Login": "alice@github", "X-Forwarded-For": "127.0.0.1" }), { none: true });
  }
  // no socket at all (not served over one): none
  const app = appFor(src);
  const r = await app.request("http://localhost/who", { headers: { "Tailscale-User-Login": "alice@github" } });
  assert.deepEqual(await r.json(), { none: true });
});

test("socket: the last forwarded address is asked once per 10 seconds", async () => {
  const api = await fakeLocalApi(() => whois("Alice@Example.com"));
  let t = 1_000_000;
  try {
    const src = new TailnetSource({ socket: api.socket, headers: false, proxies: proxies(), now: () => t });
    assert.equal(src.mode, "socket");
    const app = appFor(src);
    const xff = { "X-Forwarded-For": "198.51.100.4, 100.101.102.103" };
    const want = {
      login: "alice@example.com",
      displayName: "Alice Example",
      tags: [],
      node: { name: "laptop.example-tailnet.ts.net.", stableId: "nStable7CNTRL" },
      address: "100.101.102.103",
      source: "socket",
    };
    assert.deepEqual(await ask(app, LISTED, xff), want);
    assert.equal(api.calls.length, 1);
    assert.equal(api.calls[0]!.addr, "100.101.102.103");
    assert.ok(api.calls[0]!.url.startsWith("/localapi/v0/whois?"), api.calls[0]!.url);
    assert.equal(api.calls[0]!.host, "local-tailscaled.sock");
    t += 9_000;
    assert.deepEqual(await ask(app, LISTED, xff), want);
    assert.equal(api.calls.length, 1, "within 10 s: no call");
    t += 1_500;
    assert.deepEqual(await ask(app, LISTED, xff), want);
    assert.equal(api.calls.length, 2, "after 10 s: asked again");
    // the address in its forwarded forms (port, brackets) and a tailnet IPv6 address
    assert.deepEqual(await ask(app, LISTED, { "X-Forwarded-For": "[fd7a:115c:a1e0::1234]:41641" }), { ...want, address: "fd7a:115c:a1e0::1234" });
    assert.equal(api.calls.at(-1)!.addr, "fd7a:115c:a1e0::1234");
    // the headers are never read by the socket source
    const before = api.calls.length;
    assert.deepEqual(await ask(app, LISTED, { "Tailscale-User-Login": "bob@github", "X-Forwarded-For": "100.101.102.103" }), want);
    assert.equal(api.calls.length, before);
  } finally {
    await api.close();
  }
});

test("socket tags: a tagged device has tags and no login; tag changes show after 10 seconds", async () => {
  let tags = ["tag:web", "tag:ci", "tag:Bad_Name"];
  let user = "tagged-devices";
  const api = await fakeLocalApi(() => whois(user, tags));
  let t = 5_000_000;
  try {
    const src = new TailnetSource({ socket: api.socket, headers: false, proxies: proxies(), now: () => t });
    const app = appFor(src);
    const xff = { "X-Forwarded-For": "100.100.1.2" };
    const a = (await ask(app, LISTED, xff)) as Record<string, unknown>;
    assert.equal(a.login, undefined);
    assert.deepEqual(a.tags, ["tag:ci", "tag:web"]);
    assert.equal(a.source, "socket");
    tags = ["tag:web", "tag:db"];
    t += 5_000;
    assert.deepEqual(((await ask(app, LISTED, xff)) as { tags: string[] }).tags, ["tag:ci", "tag:web"], "cached");
    t += 5_001;
    assert.deepEqual(((await ask(app, LISTED, xff)) as { tags: string[] }).tags, ["tag:db", "tag:web"], "fresh after 10 s");
    // a user and tags: both
    user = "alice@github";
    t += 10_001;
    const both = (await ask(app, LISTED, xff)) as Record<string, unknown>;
    assert.equal(both.login, "alice@github");
    assert.deepEqual(both.tags, ["tag:db", "tag:web"]);
  } finally {
    await api.close();
  }
});

test("socket refusals: outside the tailnet ranges, 404, nothing valid, a peer not listed", async () => {
  let reply: { status: number; body?: unknown } = { status: 404, body: "no match for IP" };
  const api = await fakeLocalApi(() => reply);
  try {
    const src = new TailnetSource({ socket: api.socket, headers: false, proxies: proxies() });
    const app = appFor(src);
    for (const outside of ["198.51.100.4", "100.128.0.1", "100.63.255.255", "fd7a:115c:a1e1::1", "10.0.0.1", "not-an-address"]) {
      assert.deepEqual(await ask(app, LISTED, { "X-Forwarded-For": outside }), { none: true }, outside);
    }
    assert.deepEqual(await ask(app, LISTED, {}), { none: true }, "no forwarded address");
    assert.equal(api.calls.length, 0, "no call for an address outside the tailnet");
    assert.deepEqual(await ask(app, LISTED, { "X-Forwarded-For": "100.64.0.1" }), { none: true }, "404");
    assert.equal(api.calls.length, 1);
    reply = whois("not a login", ["tag:Bad_Name", "server"]);
    assert.deepEqual(await ask(app, LISTED, { "X-Forwarded-For": "100.127.255.254" }), { none: true }, "no valid login and no valid tag");
    assert.equal(api.calls.length, 2);
    reply = whois("alice@github");
    assert.deepEqual(await ask(app, "192.0.2.9", { "X-Forwarded-For": "100.101.102.103" }), { none: true }, "peer not listed");
    assert.equal(api.calls.length, 2, "no call for a peer that is not listed");
  } finally {
    await api.close();
  }
});

test("socket failures: a bad status or a body that does not parse is unavailable", async () => {
  let reply: { status: number; body?: unknown } = { status: 500, body: "boom" };
  const api = await fakeLocalApi(() => reply);
  try {
    const src = new TailnetSource({ socket: api.socket, headers: false, proxies: proxies(), log: () => {} });
    const app = appFor(src);
    assert.deepEqual(await ask(app, LISTED, { "X-Forwarded-For": "100.101.102.103" }), { unavailable: true });
    reply = { status: 200, body: "{not json" };
    assert.deepEqual(await ask(app, LISTED, { "X-Forwarded-For": "100.101.102.103" }), { unavailable: true });
    reply = { status: 200, body: "[1,2]" };
    assert.deepEqual(await ask(app, LISTED, { "X-Forwarded-For": "100.101.102.103" }), { unavailable: true });
    assert.equal(api.calls.length, 3, "an unavailable answer is not cached");
  } finally {
    await api.close();
  }
});

test("no fallback: a socket that is down with the headers on gives unavailable, logged once a minute without the path", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fd-ts-"));
  const socket = path.join(dir, "missing.sock");
  const lines: string[] = [];
  let t = 1_000;
  try {
    const src = new TailnetSource({ socket, headers: true, proxies: proxies(), now: () => t, log: (l) => lines.push(l) });
    assert.equal(src.mode, "socket");
    const app = appFor(src);
    const h = { "Tailscale-User-Login": "alice@github", "X-Forwarded-For": "100.101.102.103" };
    assert.deepEqual(await ask(app, LISTED, h), { unavailable: true });
    t += 30_000;
    assert.deepEqual(await ask(app, LISTED, h), { unavailable: true });
    assert.equal(lines.length, 1, lines.join("\n"));
    assert.match(lines[0]!, /^tailnet: the tailscaled socket did not answer \(.+\)$/);
    assert.ok(!lines[0]!.includes(dir) && !lines[0]!.includes("missing.sock"), lines[0]);
    t += 31_000;
    assert.deepEqual(await ask(app, LISTED, h), { unavailable: true });
    assert.equal(lines.length, 2, "again after a minute");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("timeout: a LocalAPI that never answers gives unavailable within 2.5 s", async () => {
  const api = await fakeLocalApi(() => "hang");
  try {
    const src = new TailnetSource({ socket: api.socket, headers: false, proxies: proxies(), log: () => {} });
    const app = appFor(src);
    const t0 = Date.now();
    assert.deepEqual(await ask(app, LISTED, { "X-Forwarded-For": "100.101.102.103" }), { unavailable: true });
    assert.ok(Date.now() - t0 < 2_500, `${Date.now() - t0} ms`);
  } finally {
    await api.close();
  }
});

test("at most 8 whois calls at once; the cache keeps at most maxCache addresses, the oldest out first", async () => {
  let open = 0;
  let most = 0;
  const pending: (() => void)[] = [];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fd-ts-"));
  const socket = path.join(dir, "ts.sock");
  let calls = 0;
  const server = http.createServer((_req, res) => {
    calls++;
    open++;
    most = Math.max(most, open);
    pending.push(() => {
      open--;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(whois("alice@github").body));
    });
  });
  await new Promise<void>((res) => server.listen(socket, res));
  try {
    const src = new TailnetSource({ socket, headers: false, proxies: proxies(), maxCache: 3 });
    const app = appFor(src);
    const all = Array.from({ length: 12 }, (_, i) => ask(app, LISTED, { "X-Forwarded-For": `100.64.0.${i + 1}` }));
    while (calls < 8) await new Promise((r) => setTimeout(r, 5));
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(open, 8);
    while (pending.length || calls < 12) {
      pending.shift()?.();
      await new Promise((r) => setTimeout(r, 5));
    }
    for (const a of await Promise.all(all)) assert.equal((a as { login: string }).login, "alice@github");
    assert.equal(most, 8);
    // the last three addresses are cached; the first is not
    const before = calls;
    const again = ask(app, LISTED, { "X-Forwarded-For": "100.64.0.12" });
    assert.equal(((await again) as { login: string }).login, "alice@github");
    assert.equal(calls, before);
    const first = ask(app, LISTED, { "X-Forwarded-For": "100.64.0.1" });
    while (calls === before) await new Promise((r) => setTimeout(r, 5));
    pending.shift()?.();
    await first;
    assert.equal(calls, before + 1);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((res) => server.close(() => res()));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("no source configured: mode null and every request has no identity", async () => {
  const src = new TailnetSource({ headers: false, proxies: proxies() });
  assert.equal(src.mode, null);
  assert.deepEqual(await ask(appFor(src), LISTED, { "Tailscale-User-Login": "alice@github" }), { none: true });
});

test("strip: no later route sees a tailscale-user-* header", async () => {
  const app = new Hono();
  app.use("*", stripTailnetHeaders());
  app.get("/h", (c) =>
    c.json({
      login: c.req.header("tailscale-user-login") ?? null,
      name: c.req.header("Tailscale-User-Name") ?? null,
      pic: c.req.header("tailscale-user-profile-pic") ?? null,
      other: c.req.header("x-other") ?? null,
      all: Object.keys(c.req.header()).filter((k) => k.startsWith("tailscale-user-")),
    }),
  );
  const r = await app.request(
    "http://localhost/h",
    { headers: { "Tailscale-User-Login": "alice@github", "Tailscale-User-Name": "Alice", "Tailscale-User-Profile-Pic": "https://x", "X-Other": "kept" } },
    peer("192.0.2.9") as never,
  );
  assert.deepEqual(await r.json(), { login: null, name: null, pic: null, other: "kept", all: [] });
});

test("over a real node server: a repeated login header gives none, and the strip holds for the request and the node request", async () => {
  const { serve } = await import("@hono/node-server");
  const src = new TailnetSource({ headers: true, proxies: proxies() });
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("identity" as never, (await src.identify(c)) as never);
    await next();
  });
  app.use("*", stripTailnetHeaders());
  app.get("/who", (c) => {
    const incoming = (c.env as { incoming: http.IncomingMessage }).incoming;
    return c.json({ identity: c.get("identity" as never), seen: c.req.header("tailscale-user-login") ?? null, node: incoming.headers["tailscale-user-login"] ?? null });
  });
  const server = await new Promise<ReturnType<typeof serve>>((res) => {
    const s = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, () => res(s));
  });
  const port = (server.address() as { port: number }).port;
  const get = (raw: string[]) =>
    new Promise<{ identity: unknown; seen: unknown; node: unknown }>((resolve, reject) => {
      const req = http.request({ host: "127.0.0.1", port, path: "/who", headers: ["Host", `127.0.0.1:${port}`, ...raw] as never, agent: false }, (res) => {
        let b = "";
        res.on("data", (d) => (b += d));
        res.on("end", () => {
          try {
            resolve(JSON.parse(b));
          } catch {
            reject(new Error(`status ${res.statusCode}: ${b}`));
          }
        });
      });
      req.on("error", reject);
      req.end();
    });
  try {
    const one = await get(["Tailscale-User-Login", "alice@github"]);
    assert.deepEqual(one, { identity: { login: "alice@github", tags: [], source: "headers" }, seen: null, node: null });
    const two = await get(["Tailscale-User-Login", "alice@github", "tailscale-user-login", "alice@github"]);
    assert.deepEqual(two, { identity: { none: true }, seen: null, node: null });
  } finally {
    server.close();
    (server as unknown as { closeAllConnections?(): void }).closeAllConnections?.();
  }
});
