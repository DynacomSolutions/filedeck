import { test } from "node:test";
import assert from "node:assert/strict";
import { boot, job } from "./mcp-support.ts";

type R = { structuredContent?: Record<string, any>; isError?: boolean; content: { text?: string }[] };
const call = async (c: { client: { callTool(a: object): Promise<unknown> } }, name: string, args: object = {}) => (await c.client.callTool({ name, arguments: args })) as R;

test("the server lists every tool, each read-only with an output schema", async (t) => {
  const b = await boot();
  t.after(() => b.close());
  const c = await b.connect();
  const { tools } = await c.client.listTools();
  const names = tools.map((x) => x.name).sort();
  assert.deepEqual(names, ["filedeck_change_events", "filedeck_job_get", "filedeck_jobs_list", "filedeck_list", "filedeck_nodes", "filedeck_node_status", "filedeck_scan_status", "filedeck_stat", "filedeck_storage_groups", "filedeck_du"].sort());
  for (const tool of tools) {
    assert.equal(tool.annotations?.readOnlyHint, true, tool.name);
    assert.equal(tool.annotations?.destructiveHint, false, tool.name);
    assert.ok(tool.outputSchema, `${tool.name} has an output schema`);
  }
  assert.equal(c.client.getServerVersion()?.name, "filedeck");
  assert.match(c.client.getInstructions() ?? "", /contract 2/);
});

test("nodes, du, list and stat", async (t) => {
  const b = await boot();
  t.after(() => b.close());
  const c = await b.connect();
  const nodes = await call(c, "filedeck_nodes");
  assert.equal(nodes.structuredContent!.nodes[0].name, "n");
  assert.equal(nodes.structuredContent!.nodes[0].online, true);

  const du = await call(c, "filedeck_du", { node: "n", path: "/data", depth: 1 });
  assert.equal(du.structuredContent!.stored, true);
  assert.equal(du.structuredContent!.entries.length, 2);
  assert.equal(du.structuredContent!.cached, true);
  assert.equal(b.agent.state.hits.get("/api/du"), 1);
  const none = await call(c, "filedeck_du", { node: "n", path: "/unscanned" });
  assert.deepEqual([none.structuredContent!.stored, none.structuredContent!.entries], [false, []]);
  assert.equal(none.isError, undefined);

  const list = await call(c, "filedeck_list", { node: "n", path: "/data", limit: 1 });
  assert.equal(list.structuredContent!.entries.length, 1);
  assert.deepEqual([list.structuredContent!.total, list.structuredContent!.truncated], [2, true]);
  const stat = await call(c, "filedeck_stat", { node: "n", path: "/data/b.txt" });
  assert.equal(stat.structuredContent!.entry.type, "file");
  const missing = await call(c, "filedeck_stat", { node: "n", path: "/missing" });
  assert.equal(missing.isError, true);
  assert.match(missing.content[0]!.text!, /^not found/);
});

test("scan status, node status, jobs and storage groups", async (t) => {
  const b = await boot();
  t.after(() => b.close());
  b.agent.state.jobs.push(job("j1", "size", "running"), job("j2", "compress", "done", { finishedAt: 5, result: { huge: true } }));
  const c = await b.connect();

  const scan = await call(c, "filedeck_scan_status");
  const n = scan.structuredContent!.nodes[0];
  assert.equal(n.state, "available");
  assert.equal(n.roots[0].path, "/");
  assert.deepEqual(n.scans.map((s: { id: string }) => s.id), ["j1"], "only scan jobs");

  const status = await call(c, "filedeck_node_status", { node: "n" });
  assert.equal(status.structuredContent!.nodes[0].state, "available");
  assert.equal(status.structuredContent!.nodes[0].status.watcher.running, true);

  const jobs = await call(c, "filedeck_jobs_list", {});
  assert.equal(jobs.structuredContent!.total, 2);
  const running = await call(c, "filedeck_jobs_list", { state: "running" });
  assert.deepEqual(running.structuredContent!.jobs.map((j: { id: string }) => j.id), ["j1"]);
  const get = await call(c, "filedeck_job_get", { id: "j2" });
  assert.equal(get.structuredContent!.job.state, "done");
  assert.equal(get.structuredContent!.job.result, undefined, "the result is left out");
  assert.equal(get.structuredContent!.job.node, "n");
  assert.equal((await call(c, "filedeck_job_get", { id: "nope" })).isError, true);

  const groups = await call(c, "filedeck_storage_groups", {});
  assert.ok(Array.isArray(groups.structuredContent!.groups.nodes));
  assert.equal((await call(c, "filedeck_node_status", { node: "ghost" })).isError, true);
});

test("change events: catch-up with since, reset, lagged and the limit", async (t) => {
  const b = await boot();
  t.after(() => b.close());
  const ev = (seq: number, kind = "create") => ({ cursor: `n:e1:${seq}`, time: seq, node: "n", kind, dir: false, path: `/data/f${seq}` });
  b.agent.state.changes.push(ev(1), ev(2), ev(3), ev(4));
  const c = await b.connect();
  const all = await call(c, "filedeck_change_events", { node: "n", idleMs: 100 });
  assert.equal(all.structuredContent!.count, 4);
  assert.equal(all.structuredContent!.nextCursor, "n:e1:4");
  assert.equal(all.structuredContent!.ended, "idle");
  assert.equal(all.structuredContent!.needsRescan, false);
  const rest = await call(c, "filedeck_change_events", { node: "n", since: "n:e1:2", idleMs: 100 });
  assert.deepEqual(rest.structuredContent!.events.map((e: { cursor: string }) => e.cursor), ["n:e1:3", "n:e1:4"]);
  const lim = await call(c, "filedeck_change_events", { node: "n", since: "n:e1:0", limit: 2 });
  assert.equal(lim.structuredContent!.ended, "limit");
  assert.equal(lim.structuredContent!.nextCursor, "n:e1:2");

  b.agent.state.changes.push({ cursor: "n:e1:5", time: 5, node: "n", kind: "reset", scope: "node", dir: false });
  b.agent.state.changes.push({ cursor: "n:e1:6", time: 6, node: "n", kind: "lagged", reason: "the subscriber was too slow" });
  const reset = await call(c, "filedeck_change_events", { node: "n", since: "n:e1:4" });
  assert.equal(reset.structuredContent!.needsRescan, true);
  assert.equal(reset.structuredContent!.ended, "lagged");
  assert.equal(reset.structuredContent!.nextCursor, "n:e1:6");
  assert.equal((await call(c, "filedeck_change_events", { node: "ghost" })).isError, true);
});

test("an unknown node and a failing agent are tool errors, and every call is counted", async (t) => {
  const b = await boot();
  t.after(() => b.close());
  const c = await b.connect();
  assert.equal((await call(c, "filedeck_scan_status", { node: "ghost" })).isError, true);
  await call(c, "filedeck_nodes");
  const text = await (await b.hub.metrics.request("/metrics")).text();
  assert.match(text, /filedeck_mcp_tool_calls_total\{grant="all",outcome="ok",tool="filedeck_nodes"\} 1/);
  assert.match(text, /filedeck_mcp_tool_calls_total\{grant="all",outcome="error",tool="filedeck_scan_status"\} 1/);
  assert.match(text, /filedeck_mcp_tool_duration_seconds_count\{grant="all",tool="filedeck_nodes"\} 1/);
  assert.match(text, /filedeck_mcp_tool_duration_seconds_bucket\{grant="all",le="\+Inf",tool="filedeck_nodes"\} 1/);
  assert.match(text, /filedeck_mcp_sessions\{grant="all"\} 1/);
});

test("sign-in on: an administrator account reads everything, a plain account cannot read admin data", async (t) => {
  const admin = await boot({ auth: true, account: "svcadmin", admin: true });
  t.after(() => admin.close());
  const a = await admin.connect();
  assert.equal((await call(a, "filedeck_node_status", { node: "n" })).structuredContent!.nodes[0].state, "available");
  assert.equal((await call(a, "filedeck_nodes")).structuredContent!.nodes.length, 1);
  assert.equal((await call(a, "filedeck_du", { node: "n", path: "/data" })).structuredContent!.stored, true);

  const plain = await boot({ auth: true, account: "svcplain", admin: false });
  t.after(() => plain.close());
  const p = await plain.connect();
  assert.equal((await call(p, "filedeck_nodes")).structuredContent!.nodes.length, 1);
  assert.equal((await call(p, "filedeck_du", { node: "n", path: "/data" })).structuredContent!.stored, true);
  const denied = await call(p, "filedeck_node_status", { node: "n" });
  assert.equal(denied.isError, true);
  assert.match(denied.content[0]!.text!, /^forbidden/);
  assert.equal((await call(p, "filedeck_change_events", { node: "n" })).isError, true);
  assert.equal((await call(p, "filedeck_storage_groups")).isError, true);
});
