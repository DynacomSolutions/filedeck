import { test } from "node:test";
import assert from "node:assert/strict";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { McpEventSink, McpModule } from "../src/mcp/index.ts";
import { bodyOf, boot, job, sleep, until } from "./mcp-support.ts";

const SCANS = "filedeck://nodes/n/scans";

test("subscribe: a scan that finishes sends resources/updated, and the resource shows it with a higher revision", async (t) => {
  const b = await boot();
  t.after(() => b.close());
  b.agent.state.jobs.push(job("s1", "size", "running"));
  const c = await b.connect();
  const before = bodyOf(await c.client.readResource({ uri: SCANS }));
  assert.equal(before.contract, 1);
  assert.equal(before.uri, SCANS);
  assert.equal(before.scans[0].state, "running");
  assert.equal(typeof before.revision, "number");
  assert.equal(typeof before.updatedAt, "number");

  await c.client.subscribeResource({ uri: SCANS });
  assert.equal(c.updated.length, 0, "no notification for the state at subscribe time");
  b.agent.state.jobs[0]!.state = "done";
  b.agent.state.jobs[0]!.finishedAt = Date.now();
  await until(() => c.updated.length > 0);
  assert.equal(c.updated[0]!.uri, SCANS);
  assert.deepEqual(Object.keys(c.updated[0]!).sort(), ["_meta", "uri"], "the notification holds the uri and _meta");
  const meta = c.updated[0]!._meta!.filedeck!;
  assert.equal(meta.uri, SCANS);
  assert.match(meta.eventId, /^[0-9a-f]{8}\.\d+$/);
  assert.ok(meta.revision > before.revision, "the notification carries the new revision");

  const after = bodyOf(await c.client.readResource({ uri: SCANS }));
  assert.equal(after.revision, meta.revision, "a read after the change has the revision of the notification");
  assert.equal(after.scans[0].state, "done");
  assert.ok(after.revision > before.revision);
  assert.ok(after.updatedAt >= before.updatedAt);
});

test("a read with no change keeps the revision; progress alone does not change it", async (t) => {
  const b = await boot();
  t.after(() => b.close());
  b.agent.state.jobs.push(job("s1", "size", "running"));
  const c = await b.connect();
  const uri = "filedeck://jobs/s1";
  const r1 = bodyOf(await c.client.readResource({ uri }));
  b.agent.state.jobs[0]!.progress = { entries: 99 };
  const r2 = bodyOf(await c.client.readResource({ uri }));
  assert.equal(r2.job.progress.entries, 99);
  assert.equal(r2.revision, r1.revision);
  assert.equal(r2.updatedAt, r1.updatedAt);
  b.agent.state.jobs[0]!.state = "failed";
  const r3 = bodyOf(await c.client.readResource({ uri }));
  assert.ok(r3.revision > r2.revision);
});

test("job state changes and node status changes are events; unsubscribe stops them", async (t) => {
  const b = await boot();
  t.after(() => b.close());
  b.agent.state.jobs.push(job("c1", "compress", "running"));
  const c = await b.connect();
  await c.client.subscribeResource({ uri: "filedeck://jobs/c1" });
  await c.client.subscribeResource({ uri: "filedeck://nodes/n/status" });
  await c.client.subscribeResource({ uri: "filedeck://nodes/n/jobs" });
  b.agent.state.jobs[0]!.state = "done";
  await until(() => c.updated.some((u) => u.uri === "filedeck://jobs/c1") && c.updated.some((u) => u.uri === "filedeck://nodes/n/jobs"));
  assert.equal(c.updated.some((u) => u.uri === SCANS), false, "not subscribed");

  const rev = bodyOf(await c.client.readResource({ uri: "filedeck://nodes/n/status" })).revision;
  b.agent.state.scannedAt = 2000; // a root was scanned: the status changes (the sample time and journal size change all the time and do not count)
  await until(() => c.updated.some((u) => u.uri === "filedeck://nodes/n/status"));
  assert.ok(bodyOf(await c.client.readResource({ uri: "filedeck://nodes/n/status" })).revision > rev);

  await c.client.unsubscribeResource({ uri: "filedeck://jobs/c1" });
  await c.client.unsubscribeResource({ uri: "filedeck://nodes/n/status" });
  await c.client.unsubscribeResource({ uri: "filedeck://nodes/n/jobs" });
  const n = c.updated.length;
  b.agent.state.jobs[0]!.state = "failed";
  b.agent.state.watcherRunning = false;
  await sleep(500);
  assert.equal(c.updated.length, n, "nothing after unsubscribe");
});

test("a node that stops answering is an event on the node resources", async (t) => {
  const b = await boot();
  t.after(() => b.close());
  const c = await b.connect();
  await c.client.subscribeResource({ uri: "filedeck://nodes/n/status" });
  const rev = bodyOf(await c.client.readResource({ uri: "filedeck://nodes/n/status" })).revision;
  b.agent.state.fail.add("/api/jobs");
  b.agent.state.fail.add("/api/node-status");
  await until(() => c.updated.some((u) => u.uri === "filedeck://nodes/n/status"));
  const down = bodyOf(await c.client.readResource({ uri: "filedeck://nodes/n/status" }));
  assert.equal(down.state, "unavailable");
  assert.ok(down.revision > rev);
  // the jobs seen before are not "removed" because the agent did not answer
  b.agent.state.fail.clear();
});

test("list_changed: a session that listed resources hears when a job appears or goes", async (t) => {
  const b = await boot();
  t.after(() => b.close());
  const c = await b.connect();
  const first = await c.client.listResources();
  assert.ok(first.resources.some((r) => r.uri === "filedeck://nodes"));
  assert.ok(first.resources.some((r) => r.uri === "filedeck://nodes/n/status"));
  assert.equal(first.resources.some((r) => r.uri.startsWith("filedeck://jobs/")), false);
  const templates = await c.client.listResourceTemplates();
  assert.ok(templates.resourceTemplates.some((r) => r.uriTemplate === "filedeck://jobs/{id}"));
  assert.equal(c.listChanged.n, 0);

  b.agent.state.jobs.push(job("n1", "compress", "running"));
  await until(() => c.listChanged.n >= 1);
  const second = await c.client.listResources();
  assert.ok(second.resources.some((r) => r.uri === "filedeck://jobs/n1"));

  const seen = c.listChanged.n;
  b.agent.state.jobs.length = 0;
  await until(() => c.listChanged.n > seen);
  assert.equal((await c.client.listResources()).resources.some((r) => r.uri === "filedeck://jobs/n1"), false);

  // a session that never listed gets none
  const quiet = await b.connect();
  b.agent.state.jobs.push(job("n2", "compress", "running"));
  await until(() => c.listChanged.n > seen + 1);
  assert.equal(quiet.listChanged.n, 0);
});

test("subscribing to an unknown resource or a missing job fails", async (t) => {
  const b = await boot();
  t.after(() => b.close());
  const c = await b.connect();
  await assert.rejects(c.client.subscribeResource({ uri: "filedeck://nope" }), /unknown resource/);
  await assert.rejects(c.client.subscribeResource({ uri: "filedeck://nodes/ghost/status" }), /unknown node/);
  await assert.rejects(c.client.subscribeResource({ uri: "filedeck://jobs/ghost" }), /unknown job/);
  await assert.rejects(c.client.readResource({ uri: "filedeck://jobs/ghost" }), /not found/);
  // unsubscribe of something never subscribed is not an error
  await c.client.unsubscribeResource({ uri: SCANS });
});

test("one shared watch per node: many sessions cost one poll loop, and it stops with the last one", async (t) => {
  const b = await boot();
  t.after(() => b.close());
  const hits = () => b.agent.state.hits.get("/api/jobs") ?? 0;
  const conns = await Promise.all([b.connect(), b.connect(), b.connect()]);
  for (const c of conns) {
    await c.client.subscribeResource({ uri: SCANS });
    await c.client.subscribeResource({ uri: "filedeck://nodes/n/jobs" });
  }
  const text = async () => (await (await b.hub.metrics.request("/metrics")).text());
  assert.match(await text(), /filedeck_mcp_watched_nodes 1/);
  assert.match(await text(), /filedeck_mcp_subscriptions\{grant="all"\} 6/);
  const h0 = hits();
  await sleep(1000);
  const perSecond = hits() - h0;
  assert.ok(perSecond <= 14, `one loop at 100 ms, not three: ${perSecond} polls in a second`);
  assert.ok(perSecond >= 5, `the loop runs: ${perSecond}`);
  for (const c of conns) await c.close();
  await until(() => b.mcp.sessionCount === 0);
  await sleep(300);
  const h1 = hits();
  await sleep(500);
  assert.equal(hits(), h1, "no polling without a follower");
  assert.match(await text(), /filedeck_mcp_watched_nodes 0/);
  assert.match(await text(), /filedeck_mcp_subscriptions\{grant="all"\} 0/);
});

test("a module is added without a change to the core: its resource and events reach a subscriber", async (t) => {
  let sink: McpEventSink | undefined;
  let state = "stage-1";
  const verify: McpModule = {
    name: "disk-verify",
    start: (s) => void (sink = s),
    stop: async () => undefined,
    followList: () => () => undefined,
    follow: async (uri) => (uri === "filedeck://disk-verify/run-1" ? () => undefined : null),
    register(server: McpServer) {
      server.registerResource("verify-run", "filedeck://disk-verify/run-1", { mimeType: "application/json" }, async (uri) => ({ contents: [{ uri: uri.href, text: JSON.stringify({ stage: state }) }] }));
    },
  };
  const b = await boot({ mcp: { modules: () => [verify] } });
  t.after(() => b.close());
  const c = await b.connect();
  await c.client.subscribeResource({ uri: "filedeck://disk-verify/run-1" });
  state = "stage-2";
  sink!.updated({ uri: "filedeck://disk-verify/run-1", revision: 7, events: [{ kind: "stage" }] });
  await until(() => c.updated.length === 1);
  assert.equal(c.updated[0]!.uri, "filedeck://disk-verify/run-1");
  assert.deepEqual(bodyOf(await c.client.readResource({ uri: "filedeck://disk-verify/run-1" })), { stage: "stage-2" });
  // the core still refuses what no module follows
  await assert.rejects(c.client.subscribeResource({ uri: "filedeck://disk-verify/other" }), /unknown resource/);
});

test("notifications are counted by kind", async (t) => {
  const b = await boot();
  t.after(() => b.close());
  b.agent.state.jobs.push(job("m1", "size", "running"));
  const c = await b.connect();
  await c.client.listResources();
  await c.client.subscribeResource({ uri: "filedeck://nodes/n/jobs" });
  b.agent.state.jobs.push(job("m2", "size", "running"));
  await until(() => c.updated.length > 0 && c.listChanged.n > 0);
  const text = await (await b.hub.metrics.request("/metrics")).text();
  assert.match(text, /filedeck_mcp_notifications_total\{grant="all",kind="resource_updated"\} [1-9]/);
  assert.match(text, /filedeck_mcp_notifications_total\{grant="all",kind="list_changed"\} [1-9]/);
  assert.match(text, /filedeck_mcp_watch_polls_total\{outcome="ok",source="n"\} [1-9]/);
  assert.match(text, /filedeck_mcp_sessions_opened_total\{grant="all"\} 1/);
});
