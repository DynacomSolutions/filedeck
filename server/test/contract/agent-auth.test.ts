import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { serve } from "@hono/node-server";
import type { AddressInfo } from "node:net";
import { createHub } from "../../src/hub.ts";
import { loadConfig } from "../../src/config.ts";
import { agentUnderTest, contractTest, dropFixtureRoot, fixtureRoot } from "./agent-under-test.ts";

const tmp = fixtureRoot("filedeck-auth-");
const servers: ReturnType<typeof serve>[] = [];
const open = (app: { fetch: never }) =>
  new Promise<ReturnType<typeof serve>>((res) => {
    const s: ReturnType<typeof serve> = serve({ fetch: app.fetch, port: 0 }, () => res(s));
    servers.push(s);
  });
after(() => {
  for (const s of servers) s.close();
  dropFixtureRoot(tmp);
});

contractTest("agent demands the shared token, the hub supplies it and never forwards the client's", async () => {
  const TOKEN = "t0ken-" + "x".repeat(40);
  const agent = await agentUnderTest({ root: tmp, env: { FILEDECK_AGENT_TOKEN: TOKEN } });
  after(() => agent.close());
  const a = await agent.listen();
  assert.equal((await fetch(`${a}/healthz`)).status, 200, "probe stays open");
  assert.equal((await fetch(`${a}/api/fs/list?path=/`)).status, 401);
  assert.equal((await fetch(`${a}/api/fs/list?path=/`, { headers: { authorization: "Bearer wrong" } })).status, 401);
  assert.equal((await fetch(`${a}/api/fs/list?path=/`, { headers: { authorization: "Basic " + TOKEN } })).status, 401);
  assert.equal((await fetch(`${a}/api/fs/list?path=/`, { headers: { authorization: `Bearer ${TOKEN}` } })).status, 200);

  const mk = async (token: string | undefined) =>
    `http://127.0.0.1:${((await open(createHub(loadConfig({ FILEDECK_MODE: "hub", NODES: `t=${a}`, FILEDECK_STATIC: tmp, ...(token ? { FILEDECK_AGENT_TOKEN: token } : {}) } as never)) as never)).address() as AddressInfo).port}`;
  const good = await mk(TOKEN);
  assert.equal((await fetch(`${good}/api/nodes/t/api/fs/list?path=/`)).status, 200);
  const spoof = await fetch(`${good}/api/nodes/t/api/fs/list?path=/`, { headers: { authorization: "Bearer attacker" } });
  assert.equal(spoof.status, 200, "the hub replaces the client's header with its own");
  const bad = await mk("another-token");
  assert.equal((await fetch(`${bad}/api/nodes/t/api/fs/list?path=/`)).status, 401);
  const none = await mk(undefined);
  assert.equal((await fetch(`${none}/api/nodes/t/api/fs/list?path=/`)).status, 401);
  const nodes = (await (await fetch(`${none}/api/nodes`)).json()) as { nodes: { online: boolean }[] };
  assert.equal(nodes.nodes[0]?.online, true, "online state uses the open probe");
});

contractTest("agent without a token is unchanged", async () => {
  const app = await agentUnderTest({ root: tmp });
  after(() => app.close());
  assert.equal((await app.request("/api/fs/list?path=/")).status, 200);
});
