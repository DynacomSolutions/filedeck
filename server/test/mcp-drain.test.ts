import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { boot, job, sleep, until, type Boot } from "./mcp-support.ts";

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

// ---- a client that does not read an answer ----

/** A session that the test opens by hand, and a raw socket that sends a big `tools/call` and then reads nothing. */
async function stalledClient(b: Boot, jobs: number, titleBytes: number): Promise<{ sock: net.Socket; closed: () => boolean; received: () => number }> {
  // `closed` tells what the hub did: its response to the call ended with the connection (a paused client socket reports an end only when it is read)
  const url = new URL(b.url);
  const headers = { authorization: `Bearer ${b.token}`, "content-type": "application/json", accept: "application/json, text/event-stream" };
  const open = await fetch(b.url + "/mcp", { method: "POST", headers, body: JSON.stringify(init) });
  const sid = open.headers.get("mcp-session-id")!;
  await open.text();
  let closed = false;
  b.mcp.server.on("request", (req, res) => {
    if (req.method === "POST" && req.headers["mcp-session-id"] === sid) res.once("close", () => void (closed = true));
  });
  const title = "y".repeat(titleBytes);
  b.agent.state.jobs = Array.from({ length: jobs }, (_, i) => job(`j${i}`, "size", "done", { title }));
  const body = JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "filedeck_jobs_list", arguments: { limit: jobs } } });
  const sock = net.connect(Number(url.port), url.hostname);
  await new Promise<void>((r) => sock.once("connect", () => r()));
  let received = 0;
  sock.on("data", (d) => {
    received += d.length;
    sock.pause(); // reads the first bytes, then nothing
  });
  sock.on("error", () => undefined);
  sock.write(`POST /mcp HTTP/1.1\r\nhost: ${url.host}\r\nauthorization: Bearer ${b.token}\r\ncontent-type: application/json\r\naccept: application/json, text/event-stream\r\nmcp-session-id: ${sid}\r\nmcp-protocol-version: 2025-06-18\r\ncontent-length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
  return { sock, closed: () => closed, received: () => received };
}

test("a client that stops reading an answer does not hold the drain: the drain ends, and stop() cuts the connection", async (t) => {
  // the limit is far above the answer, so only the drain rule is tested here
  const b = await boot({ mcp: { maxBacklog: 1 << 30 } });
  t.after(() => b.close());
  const stalled = await stalledClient(b, 200, 100_000); // an answer of about 20 MB, more than the buffers of the connection hold
  t.after(() => stalled.sock.destroy());
  await until(() => b.agent.state.hits.get("/api/jobs")! >= 2);
  await sleep(1500); // the tool has answered; the answer waits in the hub for a client that does not read
  const t0 = Date.now();
  const result = await Promise.race([b.mcp.drain().then(() => "drained"), sleep(6000).then(() => "still draining")]);
  assert.equal(result, "drained", "the drain waits for work, not for a client");
  assert.ok(Date.now() - t0 < 5000);
  assert.equal(b.mcp.sessionCount, 0);
  assert.equal(stalled.closed(), false, "the drain alone does not cut a client that may still be reading");
  await b.mcp.stop(); // the clean-up of the hub (main.ts) runs this after the drain
  await until(() => stalled.closed(), 4000);
  assert.ok(stalled.received() < 10_000_000, `the connection was cut, the answer did not arrive (${stalled.received()} bytes)`);
});

test("an answer that waits for a client that does not read, above the limit, ends its connection at once", async (t) => {
  const b = await boot({ mcp: { maxBacklog: 256 * 1024 } });
  t.after(() => b.close());
  const stalled = await stalledClient(b, 200, 100_000);
  t.after(() => stalled.sock.destroy());
  const metrics = async () => (await b.hub.metrics.request("/metrics")).text();
  for (const t0 = Date.now(); !(await metrics()).includes('filedeck_mcp_errors_total{grant="all",kind="slow"} 1') && Date.now() - t0 < 8000; ) await sleep(50);
  assert.match(await metrics(), /filedeck_mcp_errors_total\{grant="all",kind="slow"\} 1/);
  assert.match(await metrics(), /filedeck_mcp_inflight_requests 0/);
  await until(() => stalled.closed(), 4000);
  await Promise.race([b.mcp.drain(), sleep(4000).then(() => assert.fail("the drain does not end"))]);
});
