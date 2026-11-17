import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createAgent } from "../src/agent.ts";
import { loadConfig } from "../src/config.ts";
import { signClaim, USER_HEADER, type UserClaim } from "../src/auth/identity.ts";

const T = "agent-secret-header";
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "filedeck-authagent-")));
const agent = (env: Record<string, string>, sink?: (l: string) => void) =>
  createAgent(loadConfig({ FILEDECK_ROOT: tmp, FILEDECK_NODE: "t", FILEDECK_AGENT_TOKEN: T, ...env } as never), sink);
const claim = (iat: number): UserClaim => ({ kind: "virt", name: "guest1", epoch: 1, runAs: "guest", grants: [{ path: "/", write: true }], iat });
const get = (app: ReturnType<typeof agent>, p: string, header?: string) =>
  app.request(p, { headers: { authorization: `Bearer ${T}`, ...(header ? { [USER_HEADER]: header } : {}) } });

test("forged or stale header refused", async () => {
  const app = agent({ FILEDECK_AUTH: "on" });
  const now = Date.now();
  const none = await get(app, "/api/fs/stat?path=/");
  assert.equal(none.status, 401);
  assert.deepEqual(await none.json(), { error: "no user" });
  assert.equal((await get(app, "/api/fs/stat?path=/", signClaim(claim(now), "another-token"))).status, 401, "signed with another token");
  assert.equal((await get(app, "/api/fs/stat?path=/", "garbage")).status, 401);
  assert.equal((await get(app, "/api/fs/stat?path=/", signClaim(claim(now - 61_000), T))).status, 401, "61 s old");
  assert.equal((await get(app, "/api/fs/stat?path=/", signClaim(claim(now), T))).status, 200);
  // the open probes need no user
  assert.equal((await get(app, "/healthz")).status, 200);
  assert.equal((await get(app, "/metrics")).status, 200);
  // a look-alike path is not a probe
  assert.equal((await get(app, "/healthz/x")).status, 401);
});

test("auth off unchanged", async () => {
  const app = agent({});
  assert.equal((await get(app, "/api/fs/stat?path=/")).status, 200);
  assert.equal((await get(app, "/api/fs/stat?path=/", "garbage")).status, 200, "the header is ignored");
});

test("no header or MAC reaches the audit line or the error body", async () => {
  const lines: string[] = [];
  const app = agent({ FILEDECK_AUTH: "on" }, (l) => lines.push(l));
  const value = signClaim(claim(Date.now()), T);
  const r = await app.request("/api/fs/mkdir", { method: "POST", headers: { authorization: `Bearer ${T}`, "content-type": "application/json", [USER_HEADER]: value }, body: JSON.stringify({ path: "/agentmade" }) });
  assert.equal(r.status, 201);
  assert.equal(JSON.parse(lines[0]!).user, "virt:guest1");
  assert.ok(!lines.join("\n").includes(value.split(".")[1]!));
  const bad = await get(app, "/api/fs/stat?path=/", value + "x");
  assert.ok(!(await bad.text()).includes(value));
});
