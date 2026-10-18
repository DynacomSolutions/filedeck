import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { serve } from "@hono/node-server";
import type { AddressInfo } from "node:net";
import { createAgent } from "../src/agent.ts";
import { createHub } from "../src/hub.ts";
import { loadConfig } from "../src/config.ts";

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "filedeck-apitoken-")));
fs.mkdirSync(path.join(tmp, "d"));
fs.writeFileSync(path.join(tmp, "d/f"), "hello");
const servers: ReturnType<typeof serve>[] = [];
const open = (app: { fetch: never }) =>
  new Promise<ReturnType<typeof serve>>((res) => {
    const s: ReturnType<typeof serve> = serve({ fetch: app.fetch, port: 0 }, () => res(s));
    servers.push(s);
  });
after(() => {
  for (const s of servers) s.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const TOKEN = "du-token-" + "y".repeat(30);
async function hub(env: Record<string, string>) {
  const agent = await open(createAgent(loadConfig({ FILEDECK_ROOT: tmp, FILEDECK_NODE: "t", FILEDECK_AGENT_TOKEN: "agent-secret", ...(env.FILEDECK_DU_WAIT_MS ? { FILEDECK_DU_WAIT_MS: env.FILEDECK_DU_WAIT_MS } : {}) } as never)) as never);
  const h = createHub(loadConfig({ FILEDECK_MODE: "hub", FILEDECK_STATIC: tmp, FILEDECK_AGENT_TOKEN: "agent-secret", NODES: `n=http://127.0.0.1:${(agent.address() as AddressInfo).port}`, ...env } as never));
  return (p: string, init?: RequestInit & { token?: string }) =>
    h.request(p, { ...init, headers: { ...(init?.token ? { authorization: `Bearer ${init.token}` } : {}), ...(init?.headers as object) } });
}

test("token may read du and its job, nothing else", async () => {
  const req = await hub({ FILEDECK_API_TOKEN: TOKEN });
  const du = await req("/api/nodes/n/api/du?path=/d&depth=1", { token: TOKEN });
  assert.equal(du.status, 200);
  const body = (await du.json()) as { entries: { bytes: number }[] };
  assert.equal(body.entries[0]!.bytes >= 5, true);
  // a size job (not du) is hidden, a du job is visible
  const size = await req("/api/nodes/n/api/jobs/size", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: "/d" }) });
  const sj = (await size.json()) as { id: string };
  assert.equal((await req(`/api/nodes/n/api/jobs/${sj.id}`, { token: TOKEN })).status, 404);
  assert.equal((await req(`/api/nodes/n/api/jobs/${sj.id}`)).status, 200, "same job stays visible to the session");
  for (const [m, p] of [["GET", "/api/nodes/n/api/fs/list?path=/"], ["GET", "/api/nodes/n/api/jobs"], ["POST", "/api/nodes/n/api/jobs/size"], ["DELETE", `/api/nodes/n/api/jobs/${sj.id}`], ["POST", "/api/transfer"], ["GET", "/api/nodes"], ["GET", "/"]] as const) {
    assert.equal((await req(p, { method: m, token: TOKEN })).status, 403, `${m} ${p}`);
  }
});

test("a du job is readable through the token", async () => {
  const req = await hub({ FILEDECK_API_TOKEN: TOKEN, FILEDECK_DU_WAIT_MS: "0" });
  const r = await req("/api/nodes/n/api/du?path=/d&depth=0&fresh=1", { token: TOKEN });
  assert.equal(r.status, 202);
  const { jobId } = (await r.json()) as { jobId: string };
  const jr = await req(`/api/nodes/n/api/jobs/${jobId}`, { token: TOKEN });
  assert.equal(jr.status, 200);
  assert.equal(((await jr.json()) as { kind: string }).kind, "du");
});

test("bad tokens are refused; no Bearer header behaves as before", async () => {
  const req = await hub({ FILEDECK_API_TOKEN: TOKEN });
  for (const t of ["wrong", TOKEN + "x", TOKEN.slice(1)]) {
    assert.equal((await req("/api/nodes/n/api/du?path=/d", { token: t })).status, 401, t);
    assert.equal((await req("/api/nodes", { token: t })).status, 401);
  }
  assert.equal((await req("/api/nodes/n/api/du?path=/d")).status, 200, "session auth is outside the hub");
  assert.equal((await req("/api/nodes")).status, 200);
});

test("feature is off without FILEDECK_API_TOKEN; the token file works", async () => {
  const off = await hub({});
  assert.equal((await off("/api/nodes", { token: "anything" })).status, 200);
  const f = path.join(tmp, "tokfile");
  fs.writeFileSync(f, TOKEN + "\n");
  const on = await hub({ FILEDECK_API_TOKEN_FILE: f });
  assert.equal((await on("/api/nodes/n/api/du?path=/d", { token: TOKEN })).status, 200);
  assert.equal((await on("/api/nodes", { token: TOKEN })).status, 403);
  assert.equal(loadConfig({ FILEDECK_API_TOKEN: "x" } as never).apiToken, undefined, "agents ignore it");
});
