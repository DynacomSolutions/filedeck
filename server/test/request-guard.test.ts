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
import { MAX_JSON_BODY } from "../src/request-guard.ts";

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
  await app.request("/api/fs/delete", { method: "POST", headers: { "content-type": "text/plain" }, body: JSON.stringify({ paths: ["/gone"] }) });
  await app.request("/api/fs/upload?dir=/&name=a", { method: "PUT", headers: J, body: JSON.stringify({ paths: ["/not-a-path"] }) });
  const [d, u] = lines.map((l) => JSON.parse(l));
  assert.deepEqual(d.body, { paths: ["/gone"] });
  assert.equal(u.body, undefined);
});
