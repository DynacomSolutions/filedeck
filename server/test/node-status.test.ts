import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { serve } from "@hono/node-server";
import { createAgent } from "../src/agent.ts";
import { createHub } from "../src/hub.ts";
import { loadConfig } from "../src/config.ts";
import { signClaim, USER_HEADER, type UserClaim } from "../src/auth/identity.ts";
import { NODE_STATUS_PATH, StatusEventBus } from "../src/node-status.ts";
import type { NodeStatus } from "../src/node-status-types.ts";
import type { Jobs } from "../src/jobs.ts";
import { fakeResolver } from "./worker-env.ts";

const token = "fixture-agent-token";

async function fixture(t: TestContext) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "node-status-"));
  const root = path.join(tmp, "root");
  const mounts = path.join(tmp, "mounts");
  await fs.mkdir(root);
  await fs.writeFile(path.join(root, "one.txt"), "fixture");
  await fs.writeFile(mounts, "/dev/sample / ext4 rw 0 0\nremote /data nfs rw 0 0\n");
  t.after(() => fs.rm(tmp, { recursive: true, force: true }));
  const agent = (extra: Record<string, string> = {}) => createAgent(loadConfig({
    FILEDECK_NODE: "a", FILEDECK_ROOT: root, FILEDECK_PROC_MOUNTS: mounts, FILEDECK_EVENTS_JOURNAL_BYTES: "0",
    FILEDECK_AGENT_TOKEN: token, ...extra,
  } as NodeJS.ProcessEnv), () => {}, { accounts: fakeResolver() }) as ReturnType<typeof createAgent> & { close(): Promise<void>; events: StatusEventBus; jobs: Jobs };
  return { tmp, agent };
}

const headers = { authorization: `Bearer ${token}` };
const peer = { incoming: { socket: { remoteAddress: "127.0.0.1", encrypted: false } } };

test("agent reports stored and missing roots, existing watcher counters and journal cursors without starting work", async (t) => {
  const { agent } = await fixture(t);
  const app = agent();
  try {
    assert.equal((await app.request(NODE_STATUS_PATH)).status, 401);
    assert.equal((await app.request("/api/du?path=/&depth=0", { headers })).status, 200);
    const before = app.jobs.list().length;
    assert.equal(await app.events.whenServing(), true);
    app.events.publish({ kind: "create", path: "/one.txt" });
    app.events.publish({ kind: "overflow", scope: "node" });
    const res = await app.request(NODE_STATUS_PATH, { headers });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("cache-control"), "no-store");
    const status = await res.json() as NodeStatus;
    assert.equal(status.sizeStore.available, true);
    assert.equal(status.roots[0]?.path, "/");
    assert.equal(status.roots[0]?.fullScan, true);
    assert.equal(status.roots[0]?.state, "stale");
    assert.equal(typeof status.roots[0]?.scannedAt, "number");
    assert.deepEqual(status.roots[1], { path: "/data", scannedAt: null, fullScan: false, state: "missing" });
    assert.equal(status.watcher.running, false);
    assert.deepEqual(status.watcher.coverage, [{ path: "/", state: "unwatched" }, { path: "/data", state: "unwatched" }]);
    assert.equal(status.journal.oldestCursor, app.events.cursorOf(1));
    assert.equal(status.journal.newestCursor, app.events.cursorOf(2));
    assert.equal(status.journal.overflows, 1);
    assert.deepEqual(status.journal.subscribers, { http: 0, socket: 0, internal: 0 });
    assert.equal(app.jobs.list().length, before);
  } finally {
    await app.close();
  }
});

test("agent requires a signed administrator claim when sign-in is on", async (t) => {
  const { agent } = await fixture(t);
  const app = agent({ FILEDECK_AUTH: "on" });
  const claim: UserClaim = { kind: "virt", name: "guest", runAs: "guest", grants: [{ path: "/", write: false }], epoch: 1, iat: Date.now() };
  try {
    assert.equal((await app.request(NODE_STATUS_PATH, { headers })).status, 401);
    assert.equal((await app.request(NODE_STATUS_PATH, { headers: { ...headers, [USER_HEADER]: signClaim(claim, token) } })).status, 403);
    assert.equal((await app.request(NODE_STATUS_PATH, { headers: { ...headers, [USER_HEADER]: signClaim({ ...claim, admin: true }, token) } })).status, 200);
  } finally {
    await app.close();
  }
});

test("hub merges current, old and unavailable agents, and selects a single node", async (t) => {
  const { tmp, agent } = await fixture(t);
  const app = agent();
  const upstream = serve({ port: 0, hostname: "127.0.0.1", fetch: app.fetch });
  await new Promise<void>((resolve) => upstream.once("listening", resolve));
  const addr = upstream.address();
  assert.ok(addr && typeof addr !== "string");
  const url = `http://127.0.0.1:${addr.port}`;
  const hub = createHub(loadConfig({ FILEDECK_MODE: "hub", FILEDECK_AGENT_TOKEN: token,
    FILEDECK_STATIC: tmp, FILEDECK_DIFF_DIR: path.join(tmp, "diff"),
    FILEDECK_API_TOKEN: "fixture-read-token", FILEDECK_API_TOKEN_SCOPES: "changes",
    NODES: `a=${url},b=${url}/old,c=http://127.0.0.1:1`,
  } as NodeJS.ProcessEnv));
  try {
    const response = await hub.request("/api/status");
    assert.equal(response.status, 200);
    const data = await response.json() as { nodes: { node: string; state: string }[] };
    assert.deepEqual(data.nodes.map(({ node, state }) => [node, state]), [["a", "available"], ["b", "unsupported"], ["c", "unavailable"]]);
    const single = await hub.request("/api/status?node=a");
    assert.deepEqual((await single.json() as { nodes: unknown[] }).nodes, data.nodes.slice(0, 1));
    assert.equal((await hub.request("/api/status?node=missing")).status, 403);
    assert.equal((await hub.request("/api/status", { headers: { "x-filedeck-token": "fixture-read-token" } })).status, 403);
  } finally {
    upstream.close();
    await Promise.all([app.close(), hub.close()]);
  }
});

test("hub restricts diagnostics and the change stream to accessible administrator sessions", async (t) => {
  const { tmp, agent } = await fixture(t);
  const app = agent({ FILEDECK_AUTH: "on" });
  const upstream = serve({ port: 0, hostname: "127.0.0.1", fetch: app.fetch });
  await new Promise<void>((resolve) => upstream.once("listening", resolve));
  const addr = upstream.address();
  assert.ok(addr && typeof addr !== "string");
  const hub = createHub(loadConfig({ FILEDECK_MODE: "hub", FILEDECK_AUTH: "on", FILEDECK_AGENT_TOKEN: token,
    FILEDECK_STATIC: tmp, FILEDECK_AUTH_FILE: path.join(tmp, "auth.db"), FILEDECK_DIFF_DIR: path.join(tmp, "diff"),
    NODES: `a=http://127.0.0.1:${addr.port},b=http://127.0.0.1:1`,
  } as NodeJS.ProcessEnv), undefined, () => {});
  const call = (route: string, init?: RequestInit) => hub.request("https://localhost" + route, init, peer as never);
  const password = "Fixture password for tests only.";
  try {
    const nodes = { a: { runAs: "guest", grants: [{ path: "/", write: false }] } };
    hub.auth!.accounts.create({ name: "reader", password, admin: false, nodes });
    hub.auth!.accounts.create({ name: "operator", password, admin: true, nodes });
    const signIn = async (name: string) => {
      const response = await call("/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name, password }) });
      assert.equal(response.status, 200);
      return { cookie: response.headers.get("set-cookie")!.split(";")[0]! };
    };
    assert.equal((await call("/api/status")).status, 401);
    const member = await signIn("reader");
    assert.equal((await call("/api/status", { headers: member })).status, 403);
    assert.equal((await call("/api/nodes/a/api/node-status", { headers: member })).status, 403);
    assert.equal((await call("/api/v1/changes?node=a", { headers: member })).status, 403);
    const admin = await signIn("operator");
    assert.equal((await call("/api/status?node=b", { headers: admin })).status, 403);
    const response = await call("/api/status", { headers: admin });
    assert.equal(response.status, 200);
    const data = await response.json() as { nodes: { node: string; state: string }[] };
    assert.deepEqual(data.nodes.map(({ node, state }) => [node, state]), [["a", "available"]]);
  } finally {
    upstream.close();
    await Promise.all([app.close(), hub.close()]);
  }
});

test("watcher ready reports replace the prior list of unwatched paths", async () => {
  const bus = new StatusEventBus({ node: "a", journal: { dir: null } });
  try {
    bus.publish({ kind: "ready", unwatched: ["/data", "/backup", "/data"] });
    assert.deepEqual(bus.unwatchedPaths(), ["/backup", "/data"]);
    bus.publish({ kind: "reset", scope: "filesystem", path: "/other", window: { from: 1 } });
    assert.deepEqual(bus.unwatchedPaths(), ["/backup", "/data", "/other"]);
    bus.publish({ kind: "ready" });
    assert.deepEqual(bus.unwatchedPaths(), []);
  } finally {
    await bus.close();
  }
});
