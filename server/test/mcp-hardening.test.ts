import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import { McpError } from "@modelcontextprotocol/sdk/types.js";
import { loadConfig } from "../src/config.ts";
import { createMcp, McpHttp, McpStartError, startMcp } from "../src/mcp/index.ts";
import { CoreModule, RESOURCE_NOT_FOUND } from "../src/mcp/core.ts";
import { McpMetrics } from "../src/mcp/metrics.ts";
import { SourceWatch, type WatchEvent } from "../src/mcp/watch.ts";
import type { HubCaller } from "../src/mcp/hub-call.ts";
import { boot, job, makeCert, sleep, twoAgents, until, type GrantDef } from "./mcp-support.ts";

type R = { isError?: boolean; content: { text: string }[]; structuredContent?: Record<string, any> };
const call = async (c: { client: { callTool(a: object): Promise<unknown> } }, name: string, args: Record<string, unknown> = {}) => (await c.client.callTool({ name, arguments: args })) as unknown as R;
const init = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } };
const headers = (token: string, extra: Record<string, string> = {}) => ({ authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream", ...extra });
const grant = (id: string, resources: string[], tools = ["*"]): GrantDef => ({ id, token: `${id}-token-` + "x".repeat(24), resources, tools });
const metricsOf = async (b: { hub: { metrics: { request(p: string): Response | Promise<Response> } } }) => (await b.hub.metrics.request("/metrics")).text();

// ---- finding 1: a job of a node outside the grant ----

test("a job on a node outside the grant cannot be read, found or followed, and no agent outside the grant is asked", async (t) => {
  const two = await twoAgents();
  const only = grant("n-only", ["filedeck://nodes/n/", "filedeck://jobs/"]);
  const both = grant("both", ["filedeck://nodes/", "filedeck://jobs/"]);
  const b = await boot({ agentUrl: two.n.url, grants: [only, both], env: { NODES: two.nodes } });
  t.after(async () => {
    await b.close();
    two.close();
  });
  two.m.agent.state.jobs = [job("secret1", "compress", "running")];
  const c = await b.connect({ token: only.token });
  const code = (e: unknown) => (e as McpError).code;
  const ghost = await c.client.subscribeResource({ uri: "filedeck://jobs/ghost" }).catch((e: Error) => e);
  const secret = await c.client.subscribeResource({ uri: "filedeck://jobs/secret1" }).catch((e: Error) => e);
  assert.ok(ghost instanceof McpError && secret instanceof McpError, "both are refused");
  assert.equal(secret.message.replace("secret1", "ID"), ghost.message.replace("ghost", "ID"), "a job of another node answers as an unknown job: no way to tell that it exists");
  assert.match(secret.message, /unknown job/);
  const readSecret = await c.client.readResource({ uri: "filedeck://jobs/secret1" }).catch((e: Error) => e);
  const readGhost = await c.client.readResource({ uri: "filedeck://jobs/ghost" }).catch((e: Error) => e);
  assert.equal(code(readSecret), RESOURCE_NOT_FOUND);
  assert.equal(code(readGhost), RESOURCE_NOT_FOUND);
  assert.equal((await call(c, "filedeck_job_get", { id: "secret1" })).isError, true);
  assert.deepEqual([...two.m.agent.state.hits.keys()], [], "the agent of the other node was never asked, and no poll of it started");

  // the other node's job changes: the session hears nothing and nothing polls that node
  two.m.agent.state.jobs = [job("secret1", "compress", "done")];
  await sleep(500);
  assert.deepEqual(c.updated, []);
  assert.deepEqual([...two.m.agent.state.hits.keys()], []);

  // a grant that names the node follows the same job
  const full = await b.connect({ token: both.token });
  await full.client.subscribeResource({ uri: "filedeck://jobs/secret1" });
  two.m.agent.state.jobs = [job("secret1", "compress", "failed")];
  await until(() => full.updated.length > 0);
});

// ---- finding 2: what names a node ----

test("a grant for one resource of a node, or for `filedeck://nodes` alone, gives no tool on any node", async (t) => {
  const statusOnly = grant("status-only", ["filedeck://nodes/{node}/status"]);
  const listOnly = grant("list-only", ["filedeck://nodes"]);
  const scansOnly = grant("scans-only", ["filedeck://nodes/n/scans"]);
  const nodePrefix = grant("prefix", ["filedeck://nodes/n/"]);
  const template = grant("template", ["filedeck://nodes/{node}/"]);
  const b = await boot({ grants: [statusOnly, listOnly, scansOnly, nodePrefix, template] });
  t.after(() => b.close());
  const tools = [["filedeck_du", { node: "n", path: "/data" }], ["filedeck_list", { node: "n", path: "/data" }], ["filedeck_stat", { node: "n", path: "/data" }], ["filedeck_change_events", { node: "n" }], ["filedeck_jobs_list", { node: "n" }]] as const;
  for (const g of [statusOnly, listOnly, scansOnly]) {
    const c = await b.connect({ token: g.token });
    for (const [name, args] of tools) {
      const r = await call(c, name, args);
      assert.equal(r.isError, true, `${g.id} ${name}`);
      assert.match(r.content[0]!.text, /^forbidden/, `${g.id} ${name}`);
    }
    assert.deepEqual((await call(c, "filedeck_nodes")).structuredContent!.nodes, [], `${g.id}: it names no node`);
  }
  for (const g of [nodePrefix, template]) {
    const c = await b.connect({ token: g.token });
    assert.equal((await call(c, "filedeck_du", { node: "n", path: "/data" })).isError, undefined, g.id);
  }
  // the resource itself still works for the grant that names it
  const c = await b.connect({ token: statusOnly.token });
  assert.ok((await c.client.readResource({ uri: "filedeck://nodes/n/status" })).contents.length === 1);
  await c.client.subscribeResource({ uri: "filedeck://nodes/n/status" });
  const list = await b.connect({ token: listOnly.token });
  assert.ok((await list.client.readResource({ uri: "filedeck://nodes" })).contents.length === 1);
  await assert.rejects(list.client.readResource({ uri: "filedeck://nodes/n/status" }), /forbidden|not found/, "the node list gives no resource below it");
});

// ---- finding 3: TLS files that are not valid, and a hub that cannot start its MCP server ----

test("a bad or empty PEM is a log line and no server, not a throw", async (t) => {
  const b = await boot();
  t.after(() => b.close());
  const stub = { fetch: () => new Response(), addMetrics: () => undefined };
  const env = { FILEDECK_MODE: "hub", NODES: "n=http://127.0.0.1:1", FILEDECK_MCP_PORT: "9092", FILEDECK_MCP_GRANTS_FILE: b.dir + "/grants.json" };
  const good = makeCert(b.dir);
  for (const [label, content] of [["garbage", "not a pem"], ["empty", ""]] as const) {
    const bad = path.join(b.dir, `bad-${label}.crt`);
    fs.writeFileSync(bad, content);
    const lines: string[] = [];
    const made = await createMcp(loadConfig({ ...env, FILEDECK_MCP_TLS_CERT: bad, FILEDECK_MCP_TLS_KEY: good.key }), stub, { log: (m) => lines.push(m) });
    assert.equal(made, undefined, label);
    assert.match(lines.at(-1)!, /not started.*TLS certificate or key is not valid/, label);
  }
  // a key that does not belong to the certificate
  const other = makeCert(b.dir, "renewed");
  const lines: string[] = [];
  assert.equal(await createMcp(loadConfig({ ...env, FILEDECK_MCP_TLS_CERT: good.cert, FILEDECK_MCP_TLS_KEY: other.key }), stub, { log: (m) => lines.push(m) }), undefined);
  assert.match(lines.at(-1)!, /not valid/);
});

test("startMcp: off without a port; an error when the port is set and the server cannot start", async (t) => {
  const b = await boot();
  t.after(() => b.close());
  const stub = { fetch: () => new Response(), addMetrics: () => undefined };
  const hub = { FILEDECK_MODE: "hub", NODES: "n=http://127.0.0.1:1" };
  const log = () => undefined;
  assert.equal(await startMcp(loadConfig(hub), stub, { log }), undefined, "no port: off, not an error");
  await assert.rejects(startMcp(loadConfig({ ...hub, FILEDECK_MCP_PORT: "9092" }), stub, { log }), McpStartError);
  await assert.rejects(startMcp(loadConfig({ ...hub, FILEDECK_MCP_PORT: "9092", FILEDECK_MCP_GRANTS_FILE: b.dir + "/grants.json" }), stub, { log }), McpStartError, "no TLS and no test switch");
});

test("the hub process exits with code 2 and one clear line when FILEDECK_MCP_PORT is set and the MCP server cannot start", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "filedeck-mcp-main-"));
  const main = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "main.ts");
  const probe = http.createServer();
  await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
  const port = (probe.address() as AddressInfo).port;
  await new Promise<void>((r) => probe.close(() => r()));
  const child = spawn(process.execPath, ["--import", "tsx", main], {
    cwd: path.join(path.dirname(main), ".."), // the package folder: tsx is found from there
    env: { PATH: process.env.PATH, HOME: dir, TMPDIR: process.env.TMPDIR ?? os.tmpdir(), FILEDECK_MODE: "hub", NODES: "n=http://127.0.0.1:1", PORT: String(port), FILEDECK_HOST: "127.0.0.1", FILEDECK_STATIC: "/nonexistent", FILEDECK_MCP_PORT: String(port + 1) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let err = "";
  child.stderr.on("data", (d) => (err += d));
  child.stdout.on("data", () => undefined);
  const killer = setTimeout(() => child.kill("SIGKILL"), 240_000);
  try {
    const code = await new Promise<number | null>((r) => child.once("exit", r));
    assert.equal(code, 2, err);
    assert.match(err, /FILEDECK_MCP_GRANTS_FILE/, "the reason is in the log");
    assert.match(err, /FILEDECK_MCP_PORT is set but the MCP server cannot start/);
  } finally {
    clearTimeout(killer);
    if (child.exitCode === null) child.kill("SIGKILL");
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---- finding 4: sessions of one grant ----

test("a grant at its limit of sessions ends its own oldest session, and the other grants keep theirs", async (t) => {
  const a = grant("a", ["filedeck://"]);
  const other = grant("other", ["filedeck://"]);
  const b = await boot({ grants: [a, other], env: { FILEDECK_MCP_SESSIONS_PER_GRANT: "2" } });
  t.after(() => b.close());
  const o1 = await b.connect({ token: other.token });
  const c1 = await b.connect({ token: a.token });
  await sleep(5);
  const c2 = await b.connect({ token: a.token });
  await sleep(5);
  await call(c1, "filedeck_nodes"); // c1 is used again, so c2 is the oldest
  await sleep(5);
  const c3 = await b.connect({ token: a.token });
  assert.equal(b.mcp.sessionCount, 3, "two of grant a and one of the other grant");
  await assert.rejects(call(c2, "filedeck_nodes"), "the oldest session of the grant is gone");
  assert.equal((await call(c1, "filedeck_nodes")).isError, undefined);
  assert.equal((await call(c3, "filedeck_nodes")).isError, undefined);
  assert.equal((await call(o1, "filedeck_nodes")).isError, undefined, "another grant is not touched");
  assert.match(await metricsOf(b), /filedeck_mcp_sessions_closed_total\{grant="a",reason="evicted"\} 1/);
});

// ---- finding 5: allowed hosts of the MCP listener ----

const rawPost = (url: string, token: string, host: string) =>
  new Promise<number>((resolve, reject) => {
    const u = new URL(url);
    const req = http.request({ host: u.hostname, port: u.port, path: "/mcp", method: "POST", headers: headers(token, { host }), agent: false }, (res) => {
      res.resume();
      resolve(res.statusCode!);
    });
    req.on("error", reject);
    req.end(JSON.stringify(init));
  });

test("the MCP listener has its own host list: empty means any host, and FILEDECK_ALLOWED_HOSTS does not apply to it", async (t) => {
  const open = await boot({ env: { FILEDECK_ALLOWED_HOSTS: "files.example.org" } });
  const closed = await boot({ env: { FILEDECK_MCP_ALLOWED_HOSTS: "Filedeck-Hub.apps.svc:9092, other.svc" } });
  t.after(async () => {
    await open.close();
    await closed.close();
  });
  assert.equal(await rawPost(open.url, open.token, "filedeck-hub.apps.svc:9092"), 200, "the Service name works although the public list names another host");
  assert.equal(await rawPost(closed.url, closed.token, "filedeck-hub.apps.svc:9092"), 200);
  assert.equal(await rawPost(closed.url, closed.token, "other.svc"), 200);
  assert.equal(await rawPost(closed.url, closed.token, "evil.example.org"), 421);
  // the Origin check stays on with an open list
  const res = await fetch(open.url + "/mcp", { method: "POST", headers: headers(open.token, { origin: "https://evil.example.org" }), body: JSON.stringify(init) });
  assert.equal(res.status, 403);
  assert.deepEqual(loadConfig({ FILEDECK_MODE: "hub", NODES: "n=http://127.0.0.1:1", FILEDECK_MCP_ALLOWED_HOSTS: " A.svc , ,b.svc:9092" }).mcpAllowedHosts, ["a.svc", "b.svc:9092"]);
  assert.deepEqual(loadConfig({ FILEDECK_MODE: "hub", NODES: "n=http://127.0.0.1:1" }).mcpAllowedHosts, []);
  assert.equal(loadConfig({ FILEDECK_MODE: "hub", NODES: "n=http://127.0.0.1:1" }).mcpSessionsPerGrant, 32);
  assert.throws(() => loadConfig({ FILEDECK_MODE: "hub", NODES: "n=http://127.0.0.1:1", FILEDECK_MCP_SESSIONS_PER_GRANT: "0" }), /FILEDECK_MCP_SESSIONS_PER_GRANT/);
  assert.throws(() => loadConfig({ FILEDECK_MODE: "hub", NODES: "n=http://127.0.0.1:1", FILEDECK_MCP_SESSIONS_PER_GRANT: "257" }), /FILEDECK_MCP_SESSIONS_PER_GRANT/);
});

// ---- finding 6: list_changed follows the scope ----

test("list_changed reaches only the sessions that may see the node where a job appeared", async (t) => {
  const two = await twoAgents();
  const nOnly = grant("n-only", ["filedeck://nodes/n/", "filedeck://jobs/"]);
  const all = grant("all", ["filedeck://"]);
  const b = await boot({ agentUrl: two.n.url, grants: [nOnly, all], env: { NODES: two.nodes } });
  t.after(async () => {
    await b.close();
    two.close();
  });
  const narrow = await b.connect({ token: nOnly.token });
  const wide = await b.connect({ token: all.token });
  await narrow.client.listResources();
  await wide.client.listResources();
  two.m.agent.state.jobs.push(job("on-m", "compress", "running"));
  await until(() => wide.listChanged.n >= 1);
  await sleep(300);
  assert.equal(narrow.listChanged.n, 0, "a job on a node outside the grant is no change of its list");
  two.n.agent.state.jobs.push(job("on-n", "compress", "running"));
  await until(() => narrow.listChanged.n >= 1);
  assert.equal((await narrow.client.listResources()).resources.some((r) => r.uri === "filedeck://jobs/on-m"), false);
});

// ---- finding 7: a session that opens just after its grant was revoked ----

test("a session that is initialised after its grant was removed is closed at once", async () => {
  const g = { id: "g", fingerprint: "f1", resources: ["filedeck://"], tools: ["*"], tokenDigest: Buffer.alloc(32) };
  let current: unknown[] = [g];
  const store = { match: () => g, get grants() { return current; }, onRevoked: () => undefined, stop: () => undefined, start: () => undefined };
  const metrics = new McpMetrics();
  const mcp = new McpHttp({
    grants: store as never,
    callerFor: () => ({} as HubCaller),
    signIn: false,
    modules: [new CoreModule({ nodes: [], pollMs: 1000 })],
    metrics,
    allowedHosts: [],
    serverVersion: "test",
    keepAliveMs: 0,
    // the grant disappears while the session is made (after the token was checked, before it is announced)
    log: () => undefined,
  });
  // the module list is read when the session is made: a hook there removes the grant at that moment
  (mcp as unknown as { o: { modules: unknown[] } }).o.modules.push({ name: "revoker", register: () => void (current = []), follow: async () => null, followList: () => () => undefined, start: () => undefined, stop: async () => undefined });
  await new Promise<void>((r) => mcp.server.listen(0, "127.0.0.1", r));
  try {
    const url = `http://127.0.0.1:${(mcp.server.address() as AddressInfo).port}/mcp`;
    const res = await fetch(url, { method: "POST", headers: headers("any"), body: JSON.stringify(init) });
    await res.text().catch(() => undefined);
    // the client gets no usable session: the initialize fails, or the session is gone at the next request
    const sid = res.headers.get("mcp-session-id");
    if (sid) {
      const again = await fetch(url, { method: "POST", headers: headers("any", { "mcp-session-id": sid }), body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }) });
      assert.equal(again.status, 404, "the session is gone");
    } else assert.equal(res.status, 404);
    assert.equal(mcp.sessionCount, 0);
    assert.match(metrics.lines().join("\n"), /filedeck_mcp_sessions_closed_total\{grant="g",reason="revoked"\} 1/);
  } finally {
    await mcp.stop();
    mcp.server.closeAllConnections();
    await new Promise<void>((r) => mcp.server.close(() => r()));
  }
});

// ---- finding 8: the watch after a re-subscribe, and after a failed first poll ----

function fakeCaller() {
  const state = { jobs: [] as unknown[], failing: false, hang: undefined as Promise<void> | undefined, calls: 0 };
  const caller = {
    json: async (_path: string, signal?: AbortSignal) => {
      state.calls++;
      if (state.hang) {
        const gate = state.hang;
        await new Promise<void>((resolve, reject) => {
          gate.then(resolve);
          signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        });
      }
      if (state.failing) return { status: 500, body: { error: "broken" } };
      return { status: 200, body: { jobs: state.jobs } };
    },
  } as unknown as HubCaller;
  return { state, caller };
}

test("watch: a re-subscribe while a poll is cut off starts a new poll, and the first answer is the baseline of the new loop", async () => {
  const { state, caller } = fakeCaller();
  const events: WatchEvent[] = [];
  const w = new SourceWatch({ key: "n", jobsPath: "/api/jobs", call: caller, pollMs: 60, metrics: new McpMetrics(), emit: (e) => events.push(...e) });
  try {
    let open!: () => void;
    state.hang = new Promise<void>((r) => (open = r));
    const r1 = w.acquire();
    await until(() => state.calls >= 1);
    r1(); // the last follower leaves: the poll is cut off
    state.hang = undefined;
    const r2 = w.acquire(); // a follower comes back at once
    await w.ready();
    assert.notEqual(w.snapshot.polledAt, undefined, "ready waits for a poll of the new loop, not the cut-off one");
    assert.ok(state.calls >= 2, "a new poll was made");
    // a job appears after that baseline: it is an event, not part of a silent baseline
    state.jobs = [{ id: "j1", state: "running", kind: "compress", title: "t" }];
    await until(() => events.some((e) => e.kind === "job.created"));
    open();
    r2();
  } finally {
    await w.stop();
  }
});

test("watch: after a failed first poll, the first good poll reports the jobs it finds", async () => {
  const { state, caller } = fakeCaller();
  const events: WatchEvent[] = [];
  const w = new SourceWatch({ key: "n", jobsPath: "/api/jobs", call: caller, pollMs: 40, metrics: new McpMetrics(), emit: (e) => events.push(...e) });
  try {
    state.failing = true;
    const release = w.acquire();
    await w.ready();
    assert.equal(w.snapshot.reachable, false);
    state.jobs = [{ id: "j1", state: "running", kind: "compress", title: "t" }];
    state.failing = false;
    await until(() => events.some((e) => e.kind === "job.created"));
    assert.ok(events.some((e) => e.kind === "reachable" && e.reachable), "the node is reachable again");
    release();
  } finally {
    await w.stop();
  }
});

// ---- finding 9: a client that does not read ----

test("a stream that holds more than the limit ends its session, and a client that reads is not touched", async (t) => {
  const b = await boot();
  t.after(() => b.close());
  let slowStream = false;
  b.mcp.server.on("request", (req, res) => {
    // stands in for a client that reads nothing: the bytes queued on its stream pass the limit (the kernel buffer hides this on a loopback test)
    if (req.method === "GET" && slowStream) Object.defineProperty(res, "writableLength", { get: () => 2 * 1024 * 1024 });
  });
  const reader = await b.connect();
  await reader.client.subscribeResource({ uri: "filedeck://nodes/n/jobs" });
  slowStream = true;
  const slow = await b.connect();
  await slow.client.subscribeResource({ uri: "filedeck://nodes/n/jobs" });
  await sleep(150); // both clients have opened their stream
  slowStream = false;
  b.agent.state.jobs.push(job("j1", "compress", "running"));
  await until(() => reader.updated.length > 0);
  await until(() => b.mcp.sessionCount === 1);
  assert.match(await metricsOf(b), /filedeck_mcp_sessions_closed_total\{grant="all",reason="error"\} 1/);
  assert.equal((await call(reader, "filedeck_nodes")).isError, undefined, "the reading client keeps its session");
});

// ---- finding 10: the drain has no time limit ----

test("drain waits for a call longer than the old four-second limit", async (t) => {
  const b = await boot();
  t.after(() => b.close());
  const c = await b.connect();
  b.agent.state.delay.set("/api/fs/stat", 4800);
  const slow = c.client.callTool({ name: "filedeck_stat", arguments: { node: "n", path: "/data/b.txt" } }, undefined, { timeout: 30_000 });
  await until(() => (b.agent.state.hits.get("/api/fs/stat") ?? 0) === 1);
  let finished = false;
  const done = b.mcp.drain().then(() => void (finished = true));
  await sleep(4400);
  assert.equal(finished, false, "the drain still waits: it has no timer");
  const result = (await slow) as unknown as R;
  assert.equal(result.structuredContent!.entry.type, "file", "the call finished");
  await done;
});

// ---- finding 11 and 12: job ids and the error code of a missing resource ----

test("a job id is checked before it is used in a path; a missing node or job in resources/read is -32002", async (t) => {
  const b = await boot();
  t.after(() => b.close());
  const c = await b.connect();
  const before = [...b.agent.state.hits.keys()].length;
  for (const id of ["../nodes", "a/b", "x y", "a".repeat(129), "%2e%2e"]) {
    const r = await call(c, "filedeck_job_get", { id });
    assert.equal(r.isError, true, id);
    assert.match(r.content[0]!.text, /^not found/, id);
  }
  assert.equal([...b.agent.state.hits.keys()].filter((p) => !p.startsWith("/api/jobs")).length, before, "no request for such an id went to an agent");
  assert.ok(![...b.agent.state.hits.keys()].some((p) => p.includes("..")));
  for (const uri of ["filedeck://jobs/ghost", "filedeck://jobs/..%2Fnodes", "filedeck://nodes/ghost/status", "filedeck://nodes/ghost/scans", "filedeck://nodes/ghost/jobs"]) {
    const e = await c.client.readResource({ uri }).catch((x: Error) => x);
    assert.ok(e instanceof McpError, uri);
    assert.equal(e.code, RESOURCE_NOT_FOUND, uri);
    assert.match(e.message, /not found/, uri);
  }
  // a good id of a job that exists works
  b.agent.state.jobs.push(job("Job_1-a", "compress", "running"));
  assert.equal((await call(c, "filedeck_job_get", { id: "Job_1-a" })).isError, undefined);
});

test("a TLS certificate fixture works for a server and has a long life", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "filedeck-mcp-cert-"));
  try {
    const { cert } = makeCert(dir);
    const { X509Certificate } = await import("node:crypto");
    const x = new X509Certificate(fs.readFileSync(cert));
    assert.ok(new Date(x.validTo).getFullYear() >= 2100, "valid for about 100 years");
    assert.match(x.subjectAltName ?? "", /DNS:localhost/);
    assert.match(x.subjectAltName ?? "", /IP Address:127\.0\.0\.1/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
