import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import zlib from "node:zlib";
import { createHash } from "node:crypto";
import { serve } from "@hono/node-server";
import type { AddressInfo } from "node:net";
import { createAgent } from "../src/agent.ts";
import { createHub } from "../src/hub.ts";
import { loadConfig } from "../src/config.ts";

const INDEX = `<!doctype html><html><head><title>%%TITLE%%</title><link rel="icon" href="%%ICON%%" /><script>%%BOOT%%</script></head><body><div id="root"></div><script type="module" src="/assets/index-AbCd1234.js"></script></body></html>`;
let tmp: string, stat: string, agentSrv: ReturnType<typeof serve>, hubSrv: ReturnType<typeof serve>, guarded: ReturnType<typeof serve>, hub: string, hubPort: number, guardedPort: number;

const open = (app: { fetch: never }) =>
  new Promise<ReturnType<typeof serve>>((res) => {
    const s: ReturnType<typeof serve> = serve({ fetch: app.fetch, port: 0 }, () => res(s));
  });

before(async () => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "filedeck-hubweb-")));
  const root = path.join(tmp, "root");
  stat = path.join(tmp, "web");
  fs.mkdirSync(root);
  fs.mkdirSync(path.join(stat, "assets"), { recursive: true });
  fs.writeFileSync(path.join(stat, "index.html"), INDEX);
  fs.writeFileSync(path.join(stat, "assets/index-AbCd1234.js"), "console.log('x');\n".repeat(500));
  fs.writeFileSync(path.join(stat, "assets/theme.css"), "body{margin:0}\n".repeat(200));
  for (let i = 0; i < 80; i++) fs.writeFileSync(path.join(root, `a-rather-long-file-name-number-${i}.txt`), "x");
  fs.writeFileSync(path.join(root, "big.txt"), "line of text\n".repeat(2000));
  agentSrv = await open(createAgent(loadConfig({ FILEDECK_ROOT: root, FILEDECK_NODE: "t" } as never)) as never);
  const nodes = `t=http://127.0.0.1:${(agentSrv.address() as AddressInfo).port}`;
  hubSrv = await open(createHub(loadConfig({ FILEDECK_MODE: "hub", NODES: nodes, FILEDECK_STATIC: stat } as never)) as never);
  hubPort = (hubSrv.address() as AddressInfo).port;
  hub = `http://127.0.0.1:${hubPort}`;
  guarded = await open(createHub(loadConfig({ FILEDECK_MODE: "hub", NODES: nodes, FILEDECK_STATIC: stat, FILEDECK_ALLOWED_HOSTS: "files.example.test, Other.Example.Test:8443" } as never)) as never);
  guardedPort = (guarded.address() as AddressInfo).port;
});
after(() => {
  agentSrv.close();
  hubSrv.close();
  guarded.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

interface Got {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}
function get(port: number, p: string, headers: Record<string, string> = {}): Promise<Got> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: p, headers, agent: false }, (res) => {
      const parts: Buffer[] = [];
      res.on("data", (d: Buffer) => parts.push(d));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(parts) }));
    });
    req.on("error", reject);
    req.end();
  });
}

test("the SPA shell carries a CSP with a frame ban and the hash of its inline script, and no unsafe script source", async () => {
  const r = await get(hubPort, "/");
  assert.equal(r.status, 200);
  const csp = String(r.headers["content-security-policy"]);
  const html = r.body.toString();
  const inline = /<script>([\s\S]*?)<\/script>/.exec(html)![1]!;
  assert.ok(csp.includes(`'sha256-${createHash("sha256").update(inline).digest("base64")}'`), csp);
  const scriptSrc = csp.split("; ").find((d) => d.startsWith("script-src "))!;
  assert.ok(!scriptSrc.includes("unsafe"), scriptSrc);
  for (const d of ["frame-ancestors 'none'", "object-src 'none'", "base-uri 'self'", "worker-src 'self' blob:", "img-src 'self' data: blob:"]) assert.ok(csp.includes(d), d);
  assert.equal(r.headers["x-frame-options"], "DENY");
  assert.equal(r.headers["x-content-type-options"], "nosniff");
  assert.equal(r.headers["referrer-policy"], "no-referrer");
  // any other route is the shell too
  assert.equal((await get(hubPort, "/some/view", { "accept-encoding": "identity" })).headers["content-security-policy"], csp);
});

test("API replies are not cached, file replies keep the agent's own sandbox policy and exact bytes", async () => {
  const n = await get(hubPort, "/api/nodes");
  assert.equal(n.headers["cache-control"], "no-store");
  assert.equal(n.headers["x-content-type-options"], "nosniff");
  assert.equal(n.headers["x-frame-options"], "SAMEORIGIN");
  const f = await get(hubPort, "/api/nodes/t/api/fs/read?path=/big.txt", { "accept-encoding": "gzip" });
  assert.match(String(f.headers["content-security-policy"]), /^sandbox;/);
  assert.equal(f.headers["cache-control"], "no-store");
  assert.equal(f.headers["content-encoding"], undefined, "file reads are range-readable and stay as they are");
  assert.equal(f.body.length, 13 * 2000);
  const part = await get(hubPort, "/api/nodes/t/api/fs/read?path=/big.txt", { range: "bytes=0-9", "accept-encoding": "gzip" });
  assert.equal(part.status, 206);
  assert.equal(part.body.toString(), "line of te");
});

test("text and JSON are gzipped, streamed lists and file reads are not", async () => {
  const list = await get(hubPort, "/api/nodes/t/api/fs/list?path=/", { "accept-encoding": "gzip" });
  assert.equal(list.headers["content-encoding"], "gzip");
  assert.match(String(list.headers.vary), /accept-encoding/i);
  const entries = (JSON.parse(zlib.gunzipSync(list.body).toString()) as { entries: unknown[] }).entries;
  assert.equal(entries.length, 81);
  const plain = await get(hubPort, "/api/nodes/t/api/fs/list?path=/", { "accept-encoding": "identity" });
  assert.equal(plain.headers["content-encoding"], undefined);
  assert.ok(list.body.length < plain.body.length / 2);
  const js = await get(hubPort, "/assets/index-AbCd1234.js", { "accept-encoding": "gzip" });
  assert.equal(js.headers["content-encoding"], "gzip");
  assert.equal(zlib.gunzipSync(js.body).toString(), "console.log('x');\n".repeat(500));
  const nd = await get(hubPort, "/api/nodes/t/api/fs/list?path=/&stream=1", { "accept-encoding": "gzip" });
  assert.equal(nd.headers["content-encoding"], undefined);
  assert.match(String(nd.headers["content-type"]), /ndjson/);
});

test("hashed build files are immutable, the rest is not, and a missing build file is a 404", async () => {
  const hashed = await get(hubPort, "/assets/index-AbCd1234.js", { "accept-encoding": "identity" });
  assert.equal(hashed.headers["cache-control"], "public, max-age=31536000, immutable");
  const theme = await get(hubPort, "/assets/theme.css", { "accept-encoding": "identity" });
  assert.equal(theme.status, 200);
  assert.notEqual(theme.headers["cache-control"], "public, max-age=31536000, immutable");
  const gone = await get(hubPort, "/assets/index-Zzzzzzzz.js", { "accept-encoding": "identity" });
  assert.equal(gone.status, 404);
  assert.ok(!gone.body.toString().includes("<!doctype"));
  assert.equal((await get(hubPort, "/assets/deep/missing.css")).status, 404);
});

test("with an allowlist the hub answers only to listed hosts (healthz stays open)", async () => {
  const ask = (host: string, p = "/api/nodes") => get(guardedPort, p, { host });
  assert.equal((await ask("files.example.test")).status, 200);
  assert.equal((await ask("FILES.example.test:8443")).status, 200, "port is ignored when only the name is listed; case is ignored");
  assert.equal((await ask("other.example.test:8443")).status, 200);
  assert.equal((await ask("attacker.example")).status, 421);
  assert.equal((await ask("other.example.test:9999")).status, 421, "a listed host:port is exact");
  assert.equal((await ask("attacker.example", "/")).status, 421);
  assert.equal((await ask("10.0.0.5:8080", "/healthz")).status, 200);
  // off when unset
  assert.equal((await get(hubPort, "/api/nodes", { host: "anything.example" })).status, 200);
});

test("the hub proxy takes the rest of the path as sent, whatever form the node name has", async () => {
  const r = await get(hubPort, "/api/nodes/%74/api/fs/list?path=/", { "accept-encoding": "identity" });
  assert.equal(r.status, 200);
  assert.equal((JSON.parse(r.body.toString()) as { entries: unknown[] }).entries.length, 81);
});

test("a listed host is also accepted as the Origin of a state change on that hub", async () => {
  const post = (origin: string) =>
    new Promise<number>((resolve, reject) => {
      const body = JSON.stringify({ paths: ["/nothing"] });
      const req = http.request({ method: "POST", host: "127.0.0.1", port: guardedPort, path: "/api/nodes/t/api/fs/delete", agent: false, headers: { host: "files.example.test", origin, "content-type": "application/json", "content-length": String(body.length) } }, (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode ?? 0));
      });
      req.on("error", reject);
      req.end(body);
    });
  assert.equal(await post("https://files.example.test"), 404, "passes the guard; the agent has no such file");
  assert.equal(await post("https://evil.example"), 403);
});
