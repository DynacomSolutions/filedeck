import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../src/config.ts";
import { createMcp } from "../src/mcp/index.ts";
import { boot, everything } from "./mcp-support.ts";

const init = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } };
const post = (url: string, headers: Record<string, string>, body: unknown = init) =>
  fetch(url + "/mcp", { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers }, body: JSON.stringify(body) });

test("config: the MCP port, the TLS files and the poll interval are checked", () => {
  const hub = { FILEDECK_MODE: "hub", NODES: "n=http://127.0.0.1:1" };
  assert.equal(loadConfig(hub).mcpPort, undefined);
  assert.equal(loadConfig({ ...hub, FILEDECK_MCP_PORT: "9092" }).mcpPort, 9092);
  assert.throws(() => loadConfig({ ...hub, FILEDECK_MCP_PORT: "80" }), /FILEDECK_MCP_PORT/);
  assert.throws(() => loadConfig({ ...hub, PORT: "9092", FILEDECK_MCP_PORT: "9092" }), /FILEDECK_MCP_PORT/);
  assert.throws(() => loadConfig({ ...hub, FILEDECK_HUB_METRICS_PORT: "9091", FILEDECK_MCP_PORT: "9091" }), /FILEDECK_MCP_PORT/);
  assert.throws(() => loadConfig({ ...hub, FILEDECK_MCP_POLL_MS: "10" }), /FILEDECK_MCP_POLL_MS/);
  assert.throws(() => loadConfig({ ...hub, FILEDECK_MCP_TLS_CERT: "/x" }), /go together/);
  const cfg = loadConfig({ ...hub, FILEDECK_MCP_GRANTS_FILE: "/g.json", FILEDECK_MCP_TLS_CERT: "/c", FILEDECK_MCP_TLS_KEY: "/k", FILEDECK_MCP_ALLOW_PLAINTEXT: "1" });
  assert.deepEqual([cfg.mcpGrantsFile, cfg.mcpTlsCert, cfg.mcpTlsKey, cfg.mcpAllowPlaintext], ["/g.json", "/c", "/k", true]);
  assert.equal(loadConfig({ ...hub, FILEDECK_MCP_ALLOW_PLAINTEXT: "yes" }).mcpAllowPlaintext, false, "only 1 counts");
  // an agent never has an MCP server
  assert.equal(loadConfig({ FILEDECK_MCP_PORT: "9092", FILEDECK_MCP_GRANTS_FILE: "/g.json" }).mcpPort, undefined);
});

test("the listener is not made without a port, a grants file or TLS", async () => {
  const lines: string[] = [];
  const stub = { fetch: () => new Response(), addMetrics: () => undefined };
  const env = { FILEDECK_MODE: "hub", NODES: "n=http://127.0.0.1:1" };
  const log = (m: string) => lines.push(m);
  assert.equal(await createMcp(loadConfig({ ...env, FILEDECK_MCP_GRANTS_FILE: "/g.json" }), stub, { log }), undefined, "no port: off");
  assert.deepEqual(lines, []);
  assert.equal(await createMcp(loadConfig({ ...env, FILEDECK_MCP_PORT: "9092", FILEDECK_MCP_ALLOW_PLAINTEXT: "1" }), stub, { log }), undefined);
  assert.match(lines.pop()!, /FILEDECK_MCP_GRANTS_FILE/);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "filedeck-mcp-cfg-"));
  try {
    const grants = path.join(dir, "g.json");
    fs.writeFileSync(grants, "[]");
    // no TLS and no explicit plaintext switch: it refuses
    assert.equal(await createMcp(loadConfig({ ...env, FILEDECK_MCP_PORT: "9092", FILEDECK_MCP_GRANTS_FILE: grants }), stub, { log }), undefined);
    assert.match(lines.pop()!, /never serves plain HTTP/);
    // TLS files that do not exist
    assert.equal(await createMcp(loadConfig({ ...env, FILEDECK_MCP_PORT: "9092", FILEDECK_MCP_GRANTS_FILE: grants, FILEDECK_MCP_TLS_CERT: "/nope.crt", FILEDECK_MCP_TLS_KEY: "/nope.key" }), stub, { log }), undefined);
    assert.match(lines.pop()!, /TLS files cannot be read/);
    // a grants file that is not JSON
    fs.writeFileSync(grants, "{ not json");
    assert.equal(await createMcp(loadConfig({ ...env, FILEDECK_MCP_PORT: "9092", FILEDECK_MCP_GRANTS_FILE: grants, FILEDECK_MCP_ALLOW_PLAINTEXT: "1" }), stub, { log }), undefined);
    assert.match(lines.at(-1)!, /grants file cannot be used/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("sign-in off: a missing or wrong token is 401, the right token works with no account", async (t) => {
  const b = await boot();
  t.after(() => b.close());
  const missing = await post(b.url, {});
  assert.equal(missing.status, 401);
  assert.match(missing.headers.get("www-authenticate") ?? "", /^Bearer/);
  for (const h of ["Bearer wrong", `Bearer ${b.token}x`, "Bearer ", "Basic " + b.token, b.token]) assert.equal((await post(b.url, { authorization: h })).status, 401, h);
  const ok = await post(b.url, { authorization: `Bearer ${b.token}` });
  assert.equal(ok.status, 200);
  assert.ok(ok.headers.get("mcp-session-id"));
  const text = await ok.text();
  assert.match(text, /"protocolVersion":"2025-/);
  assert.match(text, /contract 2/);
  assert.match(text, /"subscribe":true/);
  const m = b.hub.metrics;
  const metrics = await (await m.request("/metrics")).text();
  assert.match(metrics, /filedeck_mcp_errors_total\{grant="none",kind="auth"\} 6/);
  assert.match(metrics, /filedeck_mcp_http_requests_total\{grant="none",outcome="unauthorized"\} 6/);
});

test("the token is compared by digest: no prefix or length match", async (t) => {
  const b = await boot();
  t.after(() => b.close());
  for (const h of [b.token.slice(0, 10), b.token + b.token, b.token.toUpperCase()]) assert.equal((await post(b.url, { authorization: `Bearer ${h}` })).status, 401);
});

test("probes need no token; readiness and liveness answer on the MCP listener", async (t) => {
  const b = await boot();
  t.after(() => b.close());
  assert.equal((await fetch(b.url + "/mcp/healthz")).status, 200);
  assert.equal((await fetch(b.url + "/mcp/readyz")).status, 200);
  assert.equal((await fetch(b.url + "/other")).status, 404);
  assert.equal((await fetch(b.url + "/mcp", { method: "PUT", headers: { authorization: `Bearer ${b.token}` } })).status, 405);
});

test("liveness and readiness fail when the hub's own listener does not answer", async (t) => {
  let up = true;
  const b = await boot({ mcp: { hubHealthy: async () => up } });
  t.after(() => b.close());
  assert.equal((await fetch(b.url + "/mcp/healthz")).status, 200);
  up = false;
  assert.equal((await fetch(b.url + "/mcp/healthz")).status, 503);
  assert.equal((await fetch(b.url + "/mcp/readyz")).status, 503);
});

test("a browser origin that is not this host is refused", async (t) => {
  const b = await boot();
  t.after(() => b.close());
  assert.equal((await post(b.url, { authorization: `Bearer ${b.token}`, origin: "https://evil.example" })).status, 403);
  assert.equal((await post(b.url, { authorization: `Bearer ${b.token}`, origin: b.url })).status, 200);
});

test("a request with no session id that is not initialize is refused; an unknown session is 404", async (t) => {
  const b = await boot();
  t.after(() => b.close());
  const h = { authorization: `Bearer ${b.token}` };
  assert.equal((await post(b.url, h, { jsonrpc: "2.0", id: 2, method: "tools/list" })).status, 400);
  assert.equal((await post(b.url, { ...h, "mcp-session-id": "nope" }, { jsonrpc: "2.0", id: 2, method: "tools/list" })).status, 404);
});

test("sign-in on: the token without an account is 403, with an account it works", async (t) => {
  const none = await boot({ auth: true });
  t.after(() => none.close());
  const r = await post(none.url, { authorization: `Bearer ${none.token}` });
  assert.equal(r.status, 403);
  assert.match(await r.text(), /name an account on the grant/);
  assert.equal((await post(none.url, { authorization: "Bearer wrong" })).status, 401, "a wrong token is 401 before the account is looked at");
  assert.equal((await fetch(none.url + "/mcp/healthz")).status, 200);

  const root = await boot({ auth: true, account: "root" });
  t.after(() => root.close());
  assert.equal((await post(root.url, { authorization: `Bearer ${root.token}` })).status, 403, "root is refused");

  // a grant that names its own account works with no default account
  const own = await boot({ auth: true, grants: [everything({ account: "svcgrant" })] });
  t.after(() => own.close());
  assert.equal((await (await own.connect()).client.callTool({ name: "filedeck_nodes", arguments: {} })).isError, undefined);

  const ok = await boot({ auth: true, account: "svcmcp" });
  t.after(() => ok.close());
  const conn = await ok.connect();
  const r2 = await conn.client.callTool({ name: "filedeck_nodes", arguments: {} });
  assert.equal((r2.structuredContent as { nodes: { name: string }[] }).nodes[0]!.name, "n");
});
