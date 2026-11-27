import { test } from "node:test";
import assert from "node:assert/strict";
import { boot, sleep, until } from "./mcp-support.ts";

const init = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } };

test("drain: readiness fails, no new session, the call in flight finishes, then the streams close", async (t) => {
  const b = await boot();
  t.after(() => b.close());
  const c = await b.connect();
  await c.client.subscribeResource({ uri: "filedeck://nodes/n/jobs" });
  b.agent.state.delay.set("/api/fs/stat", 700);
  const slow = c.client.callTool({ name: "filedeck_stat", arguments: { node: "n", path: "/data/b.txt" } });
  await until(() => (b.agent.state.hits.get("/api/fs/stat") ?? 0) === 1);

  const done = b.mcp.drain();
  assert.equal(b.mcp.draining, true);
  assert.equal((await fetch(b.url + "/mcp/readyz")).status, 503);
  assert.equal((await fetch(b.url + "/mcp/healthz")).status, 200, "liveness stays up while draining");

  const fresh = await fetch(b.url + "/mcp", { method: "POST", headers: { authorization: `Bearer ${b.token}`, "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify(init) });
  assert.equal(fresh.status, 503);
  assert.equal(fresh.headers.get("retry-after"), "1");
  await assert.rejects(c.client.callTool({ name: "filedeck_nodes", arguments: {} }), /shutting down|503/, "no new call on an open session");

  const result = (await slow) as { structuredContent?: { entry: { type: string } } };
  assert.equal(result.structuredContent!.entry.type, "file", "the call in flight finished");
  await done;
  assert.equal(b.mcp.sessionCount, 0);
  await assert.rejects(c.client.callTool({ name: "filedeck_nodes", arguments: {} }), "the session is gone");
  const metrics = await (await b.hub.metrics.request("/metrics")).text();
  assert.match(metrics, /filedeck_mcp_draining 1/);
  assert.match(metrics, /filedeck_mcp_sessions\{grant="all"\} 0/);
  assert.match(metrics, /filedeck_mcp_subscriptions\{grant="all"\} 0/);
  assert.match(metrics, /filedeck_mcp_sessions_closed_total\{grant="all",reason="drain"\} 1/);
});

test("drain with nothing in flight closes at once, and a second call joins the first", async (t) => {
  const b = await boot();
  t.after(() => b.close());
  await b.connect();
  const t0 = Date.now();
  await Promise.all([b.mcp.drain(), b.mcp.drain()]);
  assert.ok(Date.now() - t0 < 1000);
  assert.equal(b.mcp.sessionCount, 0);
  await sleep(10);
});

test("an idle session is closed by the sweep and its watch stops", async (t) => {
  const b = await boot({ mcp: { idleMs: 1200 } });
  t.after(() => b.close());
  const c = await b.connect();
  await c.client.subscribeResource({ uri: "filedeck://nodes/n/jobs" });
  await c.transport.terminateSession().catch(() => undefined);
  await until(() => b.mcp.sessionCount === 0, 6000);
  assert.equal(b.mcp.subscriptionCount, 0);
});
