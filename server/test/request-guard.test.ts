import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import type { AddressInfo } from "node:net";
import { createAgent } from "../src/agent.ts";
import { createHub } from "../src/hub.ts";
import { loadConfig } from "../src/config.ts";
import { readOnlyGuard } from "../src/readonly.ts";
import { audit } from "../src/audit.ts";
import { MAX_JSON_BODY, MAX_SMALL_JSON, isBulkRoute, matchesHostList, requestGuard } from "../src/request-guard.ts";

const listen = (app: { fetch: never }) =>
  new Promise<ReturnType<typeof serve>>((res) => {
    const s: ReturnType<typeof serve> = serve({ fetch: app.fetch, port: 0 }, () => res(s));
  });
const J = { "content-type": "application/json" };
let tmp: string, agentSrv: ReturnType<typeof serve>, hubSrv: ReturnType<typeof serve>, hub: string, host: string;
let agent: ReturnType<typeof createAgent>;

before(async () => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "filedeck-guard-")));
  const cfg = loadConfig({ FILEDECK_ROOT: tmp, FILEDECK_NODE: "t", FILEDECK_MAX_EDIT: "64" } as never);
  agent = createAgent(cfg);
  const open = (app: { fetch: never }) =>
    new Promise<ReturnType<typeof serve>>((res) => {
      const s: ReturnType<typeof serve> = serve({ fetch: app.fetch, port: 0 }, () => res(s));
    });
  agentSrv = await open(agent as never);
  const aport = (agentSrv.address() as AddressInfo).port;
  hubSrv = await open(createHub(loadConfig({ FILEDECK_MODE: "hub", NODES: `t=http://127.0.0.1:${aport}`, FILEDECK_STATIC: tmp } as never)) as never);
  host = `127.0.0.1:${(hubSrv.address() as AddressInfo).port}`;
  hub = `http://${host}`;
});
after(() => {
  agentSrv.close();
  hubSrv.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** A request with arbitrary headers (fetch refuses to set some of them). */
function raw(method: string, url: string, headers: Record<string, string>, body?: string | Buffer): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request({ method, host: u.hostname, port: u.port, path: u.pathname + u.search, headers, agent: false }, (res) => {
      let t = "";
      res.on("data", (d) => (t += d));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, text: t }));
    });
    req.on("error", reject);
    req.end(body);
  });
}

const del = (file: string, headers: Record<string, string>, base = hub, prefix = "/api/nodes/t") =>
  raw("POST", `${base}${prefix}/api/fs/delete`, { ...headers, "content-length": String(Buffer.byteLength(JSON.stringify({ paths: [file] }))) }, JSON.stringify({ paths: [file] }));

test("cross-site state changes are refused by hub and agent, same-origin and header-less ones pass", async () => {
  const f = path.join(tmp, "keep.txt");
  fs.writeFileSync(f, "x");
  const aport = (agentSrv.address() as AddressInfo).port;
  for (const [base, prefix] of [[hub, "/api/nodes/t"], [`http://127.0.0.1:${aport}`, ""]] as const) {
    for (const h of <Record<string, string>[]>[
      { "sec-fetch-site": "cross-site", "content-type": "text/plain" },
      { "sec-fetch-site": "cross-site", ...J },
      { "sec-fetch-site": "same-site", ...J },
      { origin: "https://other.example", ...J },
      { origin: "null", ...J },
    ]) {
      const r = await del("/keep.txt", h, base, prefix);
      assert.equal(r.status, 403, JSON.stringify(h));
      assert.ok(fs.existsSync(f));
    }
    // the origin of the page itself
    const origin = `http://${new URL(base).host}`;
    assert.equal((await del("/nothing", { origin, "sec-fetch-site": "same-origin", ...J }, base, prefix)).status, 404);
    assert.equal((await del("/nothing", { origin, ...J }, base, prefix)).status, 404);
    assert.equal((await del("/nothing", { "sec-fetch-site": "none", ...J }, base, prefix)).status, 404);
    assert.equal((await del("/nothing", { ...J }, base, prefix)).status, 404, "no browser headers: CLI, curl, the hub itself");
  }
  assert.ok(fs.existsSync(f));
  assert.equal((await fetch(`${hub}/api/nodes/t/api/fs/list?path=/`, { headers: { origin: "https://other.example" } })).status, 200, "reads are not affected");
});

test("a body that is not JSON is refused with 415, a bodyless action and raw routes are not", async () => {
  const f = path.join(tmp, "keep2.txt");
  fs.writeFileSync(f, "x");
  for (const ct of ["text/plain", "application/x-www-form-urlencoded", "multipart/form-data; boundary=x"]) {
    const r = await agent.request("/api/fs/delete", { method: "POST", headers: { "content-type": ct }, body: JSON.stringify({ paths: ["/keep2.txt"] }) });
    assert.equal(r.status, 415, ct);
    const h = await fetch(`${hub}/api/nodes/t/api/fs/delete`, { method: "POST", headers: { "content-type": ct }, body: JSON.stringify({ paths: ["/keep2.txt"] }) });
    assert.equal(h.status, 415, ct);
  }
  assert.ok(fs.existsSync(f));
  assert.equal((await agent.request("/api/fs/mkdir", { method: "POST", headers: { "content-type": "application/json; charset=utf-8" }, body: JSON.stringify({ path: "/d1" }) })).status, 201);
  assert.equal((await agent.request("/api/fs/mkdir", { method: "POST", headers: { "content-type": "application/vnd.x+json" }, body: JSON.stringify({ path: "/d2" }) })).status, 201);
  assert.equal((await agent.request("/api/jobs/nope/cancel", { method: "POST" })).status, 404, "no body, no content type needed");
  // raw bodies keep working whatever their type
  assert.equal((await fetch(`${hub}/api/nodes/t/api/fs/upload?dir=/&name=a.json`, { method: "PUT", headers: J, body: "[1" })).status, 201);
  assert.equal((await fetch(`${hub}/api/nodes/t/api/fs/upload?dir=/&name=b.bin`, { method: "PUT", body: "hello" })).status, 201);
  assert.equal((await fetch(`${hub}/api/nodes/t/api/fs/write?path=/w.txt&create=1`, { method: "PUT", body: "text" })).status, 200);
  assert.equal((await fetch(`${hub}/api/nodes/t/api/upload/chunk?dir=/&name=c.bin&id=0123456789abcdef&offset=0&total=3`, { method: "PATCH", body: "abc" })).status, 201);
});

test("body sizes are capped before buffering", async () => {
  const big = JSON.stringify({ paths: ["/x"], pad: "a".repeat(MAX_JSON_BODY) });
  const aport = (agentSrv.address() as AddressInfo).port;
  const send = (method: string, url: string, body: Buffer | string, headers: Record<string, string> = {}) => raw(method, url, { ...headers, "content-length": String(Buffer.byteLength(body)) }, body);
  assert.equal((await agent.request("/api/fs/delete", { method: "POST", headers: J, body: big })).status, 413);
  assert.equal((await send("POST", `${hub}/api/nodes/t/api/fs/delete`, big, J)).status, 413);
  assert.equal((await send("POST", `${hub}/api/transfer`, big, J)).status, 413);
  // editor save: maxEdit is 64 bytes on the agent
  const w = (n: number) => send("PUT", `http://127.0.0.1:${aport}/api/fs/write?path=/big.txt&create=1`, "a".repeat(n));
  assert.equal((await w(65)).status, 413);
  assert.ok(!fs.existsSync(path.join(tmp, "big.txt")));
  assert.equal((await w(64)).status, 200);
  // through the hub the agent's own limit applies (the hub has none of its own for this route)
  const hw = (n: number) => send("PUT", `${hub}/api/nodes/t/api/fs/write?path=/big2.txt&create=1`, "a".repeat(n));
  assert.equal((await hw(65)).status, 413);
  assert.equal((await hw(64)).status, 200);
  // a raw upload is larger than the JSON cap and goes through
  const up = await send("PUT", `${hub}/api/nodes/t/api/fs/upload?dir=/&name=large.bin`, Buffer.alloc(MAX_JSON_BODY + 10));
  assert.equal(up.status, 201);
  assert.equal(fs.statSync(path.join(tmp, "large.bin")).size, MAX_JSON_BODY + 10);
});

test("the read-only guard reads the body whatever its content type", async () => {
  const app = new Hono();
  app.use("*", readOnlyGuard(tmp, ["/ro"]));
  app.post("/api/fs/delete", (c) => c.json({ ok: true }));
  const body = JSON.stringify({ paths: ["/ro/a.txt"] });
  for (const headers of [{ "content-type": "text/plain" }, { "content-type": "application/x-www-form-urlencoded" }, {}, J]) {
    const r = await app.request("/api/fs/delete", { method: "POST", headers, body });
    assert.equal(r.status, 403, JSON.stringify(headers));
  }
});

test("the audit log records the paths whatever the content type, and never reads an upload", async () => {
  const lines: string[] = [];
  const app = new Hono();
  app.use("*", audit("t", (l) => lines.push(l)));
  app.post("/api/fs/delete", (c) => c.json({ ok: true }));
  app.put("/api/fs/upload", (c) => c.json({ ok: true }));
  const one = JSON.stringify({ paths: ["/gone"] });
  await app.request("/api/fs/delete", { method: "POST", headers: { "content-type": "text/plain", "content-length": String(one.length) }, body: one });
  await app.request("/api/fs/upload?dir=/&name=a", { method: "PUT", headers: J, body: JSON.stringify({ paths: ["/not-a-path"] }) });
  const [d, u] = lines.map((l) => JSON.parse(l));
  assert.deepEqual(d.body, { paths: ["/gone"] });
  assert.equal(u.body, undefined);
});

test("the audit log never parses a body of unknown or large size, whatever the transfer encoding", async () => {
  const lines: string[] = [];
  const app = new Hono();
  app.use("*", audit("t", (l) => lines.push(l)));
  app.post("/api/fs/delete", (c) => c.json({ ok: true }));
  const real = JSON.parse;
  let big = 0;
  JSON.parse = ((t: string, r?: never) => ((big += t.length > 100_000 ? 1 : 0), real(t, r))) as typeof JSON.parse;
  try {
    const pad = '{"paths":["/a"],"pad":"' + "x".repeat(300_000) + '"}';
    await app.request("/api/fs/delete", { method: "POST", headers: { ...J, "transfer-encoding": "chunked" }, body: pad });
    await app.request("/api/fs/delete", { method: "POST", headers: { ...J, "content-length": String(pad.length) }, body: pad });
  } finally {
    JSON.parse = real;
  }
  assert.equal(big, 0);
  assert.ok(lines.every((l) => JSON.parse(l).body === undefined));
});

test("a body is parsed once per process and shared by guard, read-only guard, audit and route", async () => {
  const lines: string[] = [];
  const app = createAgent(loadConfig({ FILEDECK_ROOT: tmp, FILEDECK_NODE: "p", FILEDECK_READONLY: "/ro" } as never), (l) => lines.push(l));
  const real = JSON.parse;
  let big = 0;
  JSON.parse = ((t: string, r?: never) => { if (t.length > 100_000) big++; return real(t, r); }) as typeof JSON.parse;
  let heap = 0;
  try {
    const body = JSON.stringify({ paths: Array.from({ length: 10_000 }, (_, i) => `/nothing/${"d".repeat(60)}/${i}`) });
    assert.ok(body.length > 500_000 && body.length < 1024 * 1024);
    const before = process.memoryUsage().heapUsed;
    const r = await app.request("/api/fs/delete", { method: "POST", headers: J, body });
    heap = process.memoryUsage().heapUsed - before;
    assert.equal(r.status, 404, "the route got the parsed body and looked at the first path");
  } finally {
    JSON.parse = real;
  }
  assert.equal(big, 1, "one parse of the large body");
  assert.deepEqual((JSON.parse(lines[0]!) as { body: { paths: string[] } }).body.paths.length, 21, "audit keeps 20 paths and a count");
  assert.ok(heap < 64 * 1024 * 1024, `heap grew by ${heap}`);
});

test("a chunked 16 MiB body to a small-body route is refused without being parsed", async () => {
  const aport = (agentSrv.address() as AddressInfo).port;
  const real = JSON.parse;
  let big = 0;
  JSON.parse = ((t: string, r?: never) => ((big += t.length > 100_000 ? 1 : 0), real(t, r))) as typeof JSON.parse;
  try {
    assert.equal(await chunked(aport, "/api/fs/mkdir", J, MAX_JSON_BODY, '{"path":"/x","pad":"'), 413);
    assert.equal(await chunked((hubSrv.address() as AddressInfo).port, "/api/nodes/t/api/fs/mkdir", J, MAX_JSON_BODY, '{"path":"/x","pad":"'), 413);
    assert.equal(await chunked((hubSrv.address() as AddressInfo).port, "/api/ops/jobs/x/pause", J, MAX_JSON_BODY, '{"pad":"'), 413);
  } finally {
    JSON.parse = real;
  }
  assert.equal(big, 0);
});

/** A request sent with chunked transfer encoding (no Content-Length), `size` bytes of body in 1 MiB pieces. */
function chunked(port: number, p: string, headers: Record<string, string>, size: number, first = ""): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.request({ method: "POST", host: "127.0.0.1", port, path: p, headers: { ...headers, "transfer-encoding": "chunked" }, agent: false }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode ?? 0));
    });
    req.on("error", reject);
    req.write(first);
    let left = size - first.length;
    while (left > 0) {
      const n = Math.min(left, 1024 * 1024);
      req.write(Buffer.alloc(n, 0x20));
      left -= n;
    }
    req.end();
  });
}

test("a bulk job of 10,000 steps with long paths is accepted through the hub", async () => {
  const seg = "d".repeat(100);
  const steps = Array.from({ length: 10_000 }, (_, i) => ({ kind: "copy", src: { node: "t", path: `/${seg}/${i}` }, dst: { node: "t", dir: `/${seg}/out` } }));
  const body = JSON.stringify({ op: "sync", steps });
  assert.ok(body.length > 2 * 1024 * 1024);
  const r = await fetch(`${hub}/api/ops/jobs`, { method: "POST", headers: J, body });
  assert.equal(r.status, 202);
  const job = (await r.json()) as { id: string };
  await fetch(`${hub}/api/ops/jobs/${job.id}/cancel`, { method: "POST" });
});

test("a chunked JSON body over the cap is refused with 413, one under it is read by the read-only guard", async () => {
  const aport = (agentSrv.address() as AddressInfo).port;
  assert.equal(await chunked(aport, "/api/fs/delete", J, MAX_JSON_BODY + 1, '{"paths":["/x"],"pad":"'), 413);
  assert.equal(await chunked((hubSrv.address() as AddressInfo).port, "/api/nodes/t/api/fs/delete", J, MAX_JSON_BODY + 1, '{"paths":["/x"],"pad":"'), 413);
  // under the cap, with the body spread over several chunks, the paths are still found
  fs.mkdirSync(path.join(tmp, "ro"), { recursive: true });
  fs.writeFileSync(path.join(tmp, "ro/a.txt"), "x");
  const ro = await listen(createAgent(loadConfig({ FILEDECK_ROOT: tmp, FILEDECK_NODE: "r", FILEDECK_READONLY: "/ro" } as never)) as never);
  try {
    const port = (ro.address() as AddressInfo).port;
    const pad = " ".repeat(3 * 1024 * 1024);
    const code = await new Promise<number>((resolve, reject) => {
      const req = http.request({ method: "POST", host: "127.0.0.1", port, path: "/api/fs/delete", headers: { ...J, "transfer-encoding": "chunked" }, agent: false }, (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode ?? 0));
      });
      req.on("error", reject);
      req.write('{"paths":');
      req.write(pad);
      req.write('["/ro/a.txt"]}');
      req.end();
    });
    assert.equal(code, 403);
    assert.ok(fs.existsSync(path.join(tmp, "ro/a.txt")));
  } finally {
    ro.close();
  }
});

test("the read-only guard refuses a body it cannot read on a route that needs it", async () => {
  const app = new Hono();
  app.use("*", readOnlyGuard(tmp, ["/ro"]));
  app.post("/api/fs/delete", (c) => c.json({ ok: true }));
  app.post("/api/fs/mkdir", (c) => c.json({ ok: true }));
  const post = (u: string, body: string, headers: Record<string, string> = J) => app.request(u, { method: "POST", headers, body });
  assert.equal((await post("/api/fs/delete", "{not json")).status, 400);
  assert.equal((await post("/api/fs/delete", "")).status, 400);
  assert.equal((await post("/api/fs/delete", '"a string"')).status, 400);
  assert.equal((await post("/api/fs/delete", "[]")).status, 400);
  assert.equal((await post("/api/fs/mkdir", "{}", { ...J, "content-length": String(MAX_JSON_BODY + 1) })).status, 413);
  assert.equal((await post("/api/fs/delete", '{"paths":["/rw/x"]}')).status, 200, "a readable body outside the prefix passes");
});

test("without Sec-Fetch-Site an Origin is accepted for Host, X-Forwarded-Host or a listed host, nothing else", async () => {
  const app = new Hono();
  app.use("*", requestGuard({ allowedHosts: ["files.example.test", "Other.example.test:8443"] }));
  app.post("/x", (c) => c.json({ ok: true }));
  const post = async (headers: Record<string, string>) => (await app.request("http://internal.local:8080/x", { method: "POST", headers: { ...J, ...headers }, body: "{}" })).status;
  assert.equal(await post({ origin: "http://internal.local:8080" }), 200, "Origin equals Host");
  assert.equal(await post({ origin: "https://files.example.test", host: "internal.local:8080", "x-forwarded-host": "files.example.test" }), 200, "the proxy rewrote Host");
  assert.equal(await post({ origin: "https://files.example.test", host: "internal.local:8080" }), 403, "a listed name without a port: the request's own port is 8080, not 443");
  assert.equal(await post({ origin: "https://files.example.test", host: "internal.local:8080", "x-forwarded-proto": "https" }), 200, "listed name, the proxy says https");
  assert.equal(await post({ origin: "https://files.example.test", host: "internal.local:8080", "x-forwarded-proto": "http" }), 403, "scheme differs from the request's own");
  assert.equal(await post({ origin: "https://files.example.test:9443", host: "files.example.test:9443" }), 200, "Origin equals Host");
  assert.equal(await post({ origin: "https://files.example.test:9443", host: "internal.local:8080", "x-forwarded-proto": "https" }), 403, "a listed name on a port nobody named");
  assert.equal(await post({ origin: "https://other.example.test:8443", host: "internal.local:8080" }), 200, "listed host:port");
  assert.equal(await post({ origin: "https://other.example.test:9", host: "internal.local:8080" }), 403, "a listed host:port is exact");
  assert.equal(await post({ origin: "https://evil.example", host: "internal.local:8080" }), 403);
  assert.equal(await post({ origin: "https://evil.example", host: "internal.local:8080", "x-forwarded-host": "files.example.test" }), 403, "forwarded host names another site");
  assert.equal(await post({ origin: "https://files.example.test", "sec-fetch-site": "cross-site", "x-forwarded-host": "files.example.test" }), 403, "Sec-Fetch-Site decides when present");
});

test("refused requests are audited with their status and claimed origin, without the body", async () => {
  const lines: string[] = [];
  const app = createAgent(loadConfig({ FILEDECK_ROOT: tmp, FILEDECK_NODE: "a" } as never), (l) => lines.push(l));
  const body = JSON.stringify({ paths: ["/SECRET-BODY-PATH"] });
  await app.request("/api/fs/delete", { method: "POST", headers: { ...J, origin: "https://evil.example", "sec-fetch-site": "cross-site" }, body });
  await app.request("/api/fs/delete", { method: "POST", headers: { "content-type": "text/plain" }, body });
  await app.request("/api/fs/delete", { method: "POST", headers: { ...J, "content-length": String(MAX_JSON_BODY + 1) }, body });
  const rows = lines.map((l) => JSON.parse(l));
  assert.deepEqual(rows.map((r) => r.status), [403, 415, 413]);
  assert.ok(rows.every((r) => r.audit === true && r.refused === true && r.method === "POST" && r.route === "/api/fs/delete" && r.who === "agent:a"));
  assert.equal(rows[0].origin, "https://evil.example");
  assert.ok(!lines.join("\n").includes("SECRET-BODY-PATH"));
});

test("an allowed-hosts entry compares names, and ports only when the entry names one", () => {
  assert.equal(matchesHostList("files.example", ["files.example:443"]), true, "no port in Host = default port");
  assert.equal(matchesHostList("files.example", ["files.example:80"]), true);
  assert.equal(matchesHostList("files.example", ["files.example:8443"]), false);
  assert.equal(matchesHostList("files.example:443", ["files.example"]), true, "bare entry: any port");
  assert.equal(matchesHostList("files.example:8080", ["files.example"]), true);
  assert.equal(matchesHostList("files.example:8080", ["files.example:443"]), false);
  assert.equal(matchesHostList("FILES.example:8443", ["files.example:8443"]), true);
  assert.equal(matchesHostList("other.example", ["files.example"]), false);
  assert.equal(matchesHostList("[::1]:8080", ["[::1]"]), true);
});

test("refusal audit lines carry the client address like any other line", async () => {
  const lines: string[] = [];
  const app = createAgent(loadConfig({ FILEDECK_ROOT: tmp, FILEDECK_NODE: "a" } as never), (l) => lines.push(l));
  await app.request("/api/fs/delete", { method: "POST", headers: { ...J, "sec-fetch-site": "cross-site", "x-forwarded-for": "198.51.100.9, 10.1.2.3" }, body: "{}" });
  const r = JSON.parse(lines[0]!) as { ip: string; forwardedFor: string; status: number };
  assert.equal(r.status, 403);
  assert.equal(r.ip, "10.1.2.3");
  assert.equal(r.forwardedFor, "198.51.100.9, 10.1.2.3");
});

test("a JSON body that starts with a byte-order mark is accepted as before", async () => {
  const bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(JSON.stringify({ path: "/bom-dir" }))]);
  const r = await agent.request("/api/fs/mkdir", { method: "POST", headers: J, body: bom });
  assert.equal(r.status, 201);
  assert.ok(fs.existsSync(path.join(tmp, "bom-dir")));
  const h = await fetch(`${hub}/api/nodes/t/api/fs/mkdir`, { method: "POST", headers: J, body: Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(JSON.stringify({ path: "/bom-dir2" }))]) });
  assert.equal(h.status, 201);
});

test("the hub forwards a proxied body it does not need to read: the agent is the one that parses it", async () => {
  const real = JSON.parse;
  let big = 0;
  JSON.parse = ((t: string, r?: never) => ((big += t.length > 100_000 ? 1 : 0), real(t, r))) as typeof JSON.parse;
  try {
    const body = JSON.stringify({ paths: Array.from({ length: 10_000 }, (_, i) => `/nothing/${"d".repeat(120)}/${i}`) });
    assert.ok(body.length > 1_000_000);
    const r = await raw("POST", `${hub}/api/nodes/t/api/fs/delete`, { ...J, "content-length": String(Buffer.byteLength(body)) }, body);
    assert.equal(r.status, 404, "the agent got the whole body and looked at the first path");
    assert.equal(big, 1, "one parse of the large body in this process: the agent's");
    // the hub's own routes still parse theirs (here once, by the hub)
    big = 0;
    const steps = Array.from({ length: 6000 }, (_, i) => ({ kind: "mkdir", node: "t", path: `/${"d".repeat(120)}/${i}` }));
    const j = await fetch(`${hub}/api/ops/jobs`, { method: "POST", headers: J, body: JSON.stringify({ op: "sync", steps }) });
    assert.equal(j.status, 202);
    assert.equal(big, 1);
    await fetch(`${hub}/api/ops/jobs/${((await j.json()) as { id: string }).id}/cancel`, { method: "POST" });
  } finally {
    JSON.parse = real;
  }
});

test("every route the web app posts a list to takes a body at the server's item limit", async () => {
  // Discovered from the client, so a new list route cannot be added there without being sorted here.
  const src = fs.readFileSync(path.join(import.meta.dirname, "../../web/src/api.ts"), "utf8");
  const found = new Set<string>();
  for (const m of src.matchAll(/\bpost\(node, "(\w+)"/g)) found.add(`/api/fs/${m[1]}`);
  for (const m of src.matchAll(/\bpostJob\(node, "(\w+)"/g)) found.add(`/api/jobs/${m[1]}`);
  for (const m of src.matchAll(/\btrashPost<[^>]*>\(node, "(\w+)"/g)) found.add(`/api/trash/${m[1]}`);
  for (const m of src.matchAll(/opReq\("([^"]*)", "POST"/g)) found.add(`/api/ops/jobs${m[1]}`.replace(/\/\$\{[^}]*\}/g, "/:x"));
  for (const m of src.matchAll(/fetch\(`?"?((?:\$\{nodeBase\(node\)\})?\/api\/[^`"?]*)[`"?][^\n]*method: "POST"/g)) found.add(m[1]!.replace("${nodeBase(node)}", "").replace(/\$\{[^}]*\}/g, ":x"));
  const list = new Set(["/api/fs/move", "/api/fs/copy", "/api/fs/trash", "/api/fs/delete", "/api/fs/zip-ticket", "/api/jobs/compress", "/api/jobs/extract", "/api/trash/restore", "/api/trash/delete", "/api/ops/jobs", "/api/diff/jobs", "/api/diff/jobs/:x/focus", "/api/diff/jobs/:x/subtree"]);
  const small = new Set(["/api/fs/mkdir", "/api/fs/symlink", "/api/fs/rename", "/api/fs/perms", "/api/jobs/size", "/api/trash/empty", "/api/ops/jobs/:x/pause", "/api/ops/jobs/:x/resolve", "/api/vault/forget", "/api/transfer", "/api/jobs/:x/cancel", "/api/vault/:x/extend", "/api/diff/jobs/:x/cancel"]);
  found.delete("/api/trash/:x"); // the helper behind trashPost, whose operations are found above
  assert.ok(found.size > 15, [...found].join(" "));
  for (const r of found) assert.ok(list.has(r) || small.has(r) || /\/(?:cancel|extend|pause|resume)$/.test(r), `a POST route the client uses is not classified: ${r}`);
  // the guard agrees with the table, at a body of 10,000 entries of 200 characters (about 2 MiB)
  const app = new Hono();
  app.use("*", requestGuard());
  app.all("/*", (c) => c.json({ ok: true }));
  const body = JSON.stringify({ items: Array.from({ length: 10_000 }, (_, i) => `/${"d".repeat(200)}/${i}`) });
  assert.ok(body.length > MAX_SMALL_JSON && body.length < MAX_JSON_BODY);
  for (const r of list) {
    const url = r.replace(":x", "abc");
    assert.equal(isBulkRoute(url), true, r);
    assert.equal((await app.request(url, { method: "POST", headers: J, body })).status, 200, r);
    assert.equal(isBulkRoute(`/api/nodes/t${url}`), true, `through the hub: ${r}`);
  }
  for (const r of small) assert.equal((await app.request(r.replace(":x", "abc"), { method: "POST", headers: J, body })).status, 413, r);
});

test("zip-ticket takes at most 10,000 names", async () => {
  const names = Array.from({ length: 10_001 }, (_, i) => `n${i}`);
  const r = await agent.request("/api/fs/zip-ticket", { method: "POST", headers: J, body: JSON.stringify({ dir: "/", names }) });
  assert.equal(r.status, 400);
  assert.match(((await r.json()) as { error: string }).error, /at most 10000/);
});
