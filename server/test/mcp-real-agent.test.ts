import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { serve } from "@hono/node-server";
import type { AddressInfo } from "node:net";
import { createAgent } from "../src/agent.ts";
import { loadConfig } from "../src/config.ts";
import { bodyOf, boot, until } from "./mcp-support.ts";

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "filedeck-mcp-real-")));
fs.mkdirSync(path.join(tmp, "d"));
fs.writeFileSync(path.join(tmp, "d/f"), "hello");
const agent = createAgent(loadConfig({ FILEDECK_ROOT: tmp, FILEDECK_NODE: "t", FILEDECK_EVENTS_JOURNAL_BYTES: "0" } as never));
let server: ReturnType<typeof serve>;
after(async () => {
  await (agent as unknown as { close(): Promise<void> }).close().catch(() => undefined);
  server?.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});
const url = async () => {
  server ??= await new Promise((res) => { const s = serve({ fetch: agent.fetch, port: 0, hostname: "127.0.0.1" }, () => res(s)); });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
};

test("a real agent: tools answer, and a real scan that finishes is a resources/updated event", async (t) => {
  const b = await boot({ agentUrl: await url() });
  t.after(() => b.close());
  const c = await b.connect();
  const call = async (name: string, args: Record<string, unknown>) => (await c.client.callTool({ name, arguments: args })) as { structuredContent: Record<string, any>; isError?: boolean };

  const list = await call("filedeck_list", { node: "n", path: "/d" });
  assert.deepEqual(list.structuredContent.entries.map((e: { name: string }) => e.name), ["f"]);
  assert.equal((await call("filedeck_stat", { node: "n", path: "/d/f" })).structuredContent.entry.size, 5);
  assert.equal((await call("filedeck_du", { node: "n", path: "/d" })).structuredContent.stored, false, "nothing scanned yet: the tool starts no scan");
  assert.equal((await call("filedeck_node_status", { node: "n" })).structuredContent.nodes[0].state, "available");

  await c.client.subscribeResource({ uri: "filedeck://nodes/n/scans" });
  const started = await b.hub.request("/api/nodes/n/api/jobs/size", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: "/d" }) });
  assert.equal(started.status, 202);
  const { id } = (await started.json()) as { id: string };
  await until(() => c.updated.some((u) => u.uri === "filedeck://nodes/n/scans"), 15_000);
  const scans = bodyOf(await c.client.readResource({ uri: "filedeck://nodes/n/scans" }));
  const j = scans.scans.find((s: { id: string }) => s.id === id);
  assert.ok(j, "the scan job is listed");
  assert.equal(scans.contract, 1);
  assert.ok(scans.revision > 0);
  const jobState = (await call("filedeck_job_get", { id })).structuredContent.job.state;
  assert.ok(["running", "queued", "done"].includes(jobState));
});
