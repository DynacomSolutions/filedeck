import assert from "node:assert/strict";
import { test } from "node:test";
import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import { createHub } from "../src/hub.ts";
import { createAgent } from "../src/agent.ts";
import { loadConfig } from "../src/config.ts";
import { runGroups } from "../src/groups-cli.ts";
import { signClaim, USER_HEADER } from "../src/auth/identity.ts";

test("agent storage reports require the signed capability when sign-in is on", async (t) => {
  const agent = createAgent(loadConfig({ FILEDECK_ROOT: process.cwd(), FILEDECK_AUTH: "on", FILEDECK_AGENT_TOKEN: "fixture",
    FILEDECK_EVENTS_JOURNAL_BYTES: "0" }));
  t.after(() => (agent as unknown as { close(): Promise<void> }).close());
  const make = (storageGroups?: true) => ({
    authorization: "Bearer fixture",
    [USER_HEADER]: signClaim({ kind: "sys", name: "reader", epoch: 1, iat: Date.now(), storageGroups }, "fixture"),
  });
  assert.equal((await agent.request("/api/groups")).status, 401);
  assert.equal((await agent.request("/api/groups", { headers: make() })).status, 403);
  assert.equal((await agent.request("/api/groups", { headers: make(true) })).status, 200);
  assert.match(await (await agent.request("/metrics")).text(), /filedeck_groups_requests_total 1/);
});

test("hub lists node groups, reports unavailable nodes and limits the token to sizes", async (t) => {
  let agentCalls = 0;
  const server = await new Promise<ReturnType<typeof serve>>((resolve) => {
    const running = serve({ port: 0, hostname: "127.0.0.1", fetch: (r) => {
      agentCalls++;
      assert.equal(new URL(r.url).pathname, "/api/groups");
      assert.equal(r.headers.get("x-filedeck-token"), null);
      if (agentCalls === 1) return Response.json({ node: "internal", drives: [], labels: [{ name: "A", match: { container: "a" } }] });
      return new Response(null, { status: 503 });
    } }, () => resolve(running));
  });
  t.after(() => server.close());
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const hub = createHub(loadConfig({ FILEDECK_MODE: "hub", NODES: `studio=${url},archive=${url}`,
    FILEDECK_API_TOKEN: "size-fixture", FILEDECK_API_TOKEN_SCOPES: "groups",
    FILEDECK_VICTORIA_METRICS_URL: "http://metrics.example" }));
  t.after(() => hub.close());
  const headers = { "x-filedeck-token": "size-fixture" };
  const body = await (await hub.request("/api/groups", { headers })).json();
  assert.equal(body.nodes.length + body.unavailable.length, 2);
  assert.deepEqual(Object.keys(body.nodes[0]), ["node", "drives"]);
  assert.equal(body.io.status, "disabled");
  assert.equal((await hub.request("/api/groups?node=missing", { headers })).status, 404);
  for (const p of ["/api/nodes", "/api/nodes/studio/api/groups", "/api/nodes/studio/api/du", "/api/jobs", "/metrics"]) {
    assert.equal((await hub.request(p, { headers })).status, 403);
  }
  const refused = await hub.request("/api/groups", { method: "POST", headers });
  assert.equal(refused.status, 403);
  assert.equal((await refused.json()).error, "forbidden: this token may only read grouped storage sizes");
  assert.match(await (await hub.request("/metrics")).text(), /filedeck_group_io_requests_total 0/);
});

test("signed-in group totals require an admin and omit nodes without account access", async (t) => {
  const groupRequests: string[] = [];
  const server = await new Promise<ReturnType<typeof serve>>((resolve) => {
    const running = serve({ port: 0, hostname: "127.0.0.1", fetch: async (req) => {
      const target = new URL(req.url);
      if (target.pathname.endsWith("/api/auth/lookup")) return Response.json({ exists: target.pathname.startsWith("/visible/") });
      if (target.pathname.endsWith("/api/groups")) {
        groupRequests.push(target.pathname);
        return Response.json({ drives: [], labels: [] });
      }
      return new Response(null, { status: 404 });
    } }, () => resolve(running));
  });
  t.after(() => server.close());
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const hub = createHub(loadConfig({ FILEDECK_MODE: "hub", NODES: `visible=${url}/visible,hidden=${url}/hidden`,
    FILEDECK_AUTH: "on", FILEDECK_AGENT_TOKEN: "fixture", FILEDECK_ADMINS: "operator", FILEDECK_VAULT_FILE: ":memory:",
    FILEDECK_AUTH_FILE: ":memory:", FILEDECK_JOBS_FILE: ":memory:", FILEDECK_PUSH_FILE: ":memory:" }));
  t.after(() => hub.close());
  const headers = (name: string) => ({ cookie: `__Host-filedeck=${hub.auth!.sessions.create("sys", name)}` });
  assert.equal((await hub.request("/api/groups", { headers: headers("reader") })).status, 403);
  await hub.presence!.refresh("operator");
  const admin = headers("operator");
  const allowed = await hub.request("/api/groups", { headers: admin });
  assert.equal(allowed.status, 200);
  assert.deepEqual(await allowed.json(), { nodes: [{ node: "visible", drives: [] }], unavailable: [], io: { status: "disabled" } });
  assert.equal((await hub.request("/api/groups?node=hidden", { headers: admin })).status, 404);
  assert.deepEqual(groupRequests, ["/visible/api/groups"]);
});

test("CLI sends a read-only token, optional node and JSON or text", async () => {
  let output = "";
  let error = "";
  const io = {
    fetch: (async (input, init) => {
      const url = new URL(String(input));
      assert.equal(url.pathname, "/api/groups");
      assert.equal(url.searchParams.get("node"), "blue room");
      assert.equal(new Headers(init?.headers).get("X-Filedeck-Token"), "fixture");
      return Response.json({ nodes: [{ node: "blue room", drives: [] }], unavailable: [], io: { status: "disabled" } });
    }) as typeof fetch,
    out: (s: string) => { output += s; },
    err: (s: string) => { error += s; },
    signal: new AbortController().signal,
  };
  const env = { FILEDECK_URL: "https://filemanager.example", FILEDECK_TOKEN: "fixture" };
  assert.equal(await runGroups(["--json", "blue room"], env, io), 0);
  assert.equal(JSON.parse(output).nodes[0].node, "blue room");
  output = "";
  assert.equal(await runGroups(["blue room"], env, io), 0);
  assert.equal(output, "blue room\n");
  assert.equal(error, "");
  assert.equal(await runGroups(["--invalid"], env, io), 2);
  assert.match(error, /filedeck groups/);
});
