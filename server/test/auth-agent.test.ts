import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createAgent } from "../src/agent.ts";
import { loadConfig } from "../src/config.ts";
import { signClaim, USER_HEADER, type UserClaim } from "../src/auth/identity.ts";
import { useSandboxOrOff } from "./sandbox-env.ts";
import { chownForTest, fakeResolver, privateTmpdir } from "./worker-env.ts";

await useSandboxOrOff(); // with sign-in on, the file routes run in a worker started through the sandbox launcher

const T = "agent-secret-header";
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "filedeck-authagent-")));
fs.chmodSync(tmp, 0o755);
chownForTest(tmp); // (a root suite runs its workers as nobody)
const apps: { close(): Promise<void> }[] = [];
const dropTmp = privateTmpdir(); // the workers' folders go with it
after(async () => {
  for (const a of apps) await a.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  dropTmp();
});
const agent = (env: Record<string, string>, sink?: (l: string) => void) => {
  const app = createAgent(loadConfig({ FILEDECK_ROOT: tmp, FILEDECK_NODE: "t", FILEDECK_AGENT_TOKEN: T, ...env } as never), sink, { accounts: fakeResolver({ guest: {} }) });
  apps.push(app as unknown as { close(): Promise<void> });
  return app;
};
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
  assert.equal((await app.request("/api/fs/read?path=/", { method: "HEAD", headers: { authorization: `Bearer ${T}` } })).status, 401, "HEAD without a claim");
  assert.equal((await get(app, "/api/fs/stat?path=/", signClaim(claim(Date.now() + 20_000), T))).status, 401, "20 s in the future");
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

test("a refused request is audited with the account; a missing claim is audited without a header value", async () => {
  const lines: string[] = [];
  const app = agent({ FILEDECK_AUTH: "on" }, (l) => lines.push(l));
  const value = signClaim(claim(Date.now()), T);
  const r = await app.request("/api/fs/mkdir", { method: "POST", headers: { authorization: `Bearer ${T}`, "content-type": "text/plain", [USER_HEADER]: value }, body: "x" });
  assert.equal(r.status, 415);
  const ref = JSON.parse(lines[0]!);
  assert.equal(ref.refused, true);
  assert.equal(ref.user, "virt:guest1");
  lines.length = 0;
  // one character in the middle of the signature changed for another: the last ones may already be the replacement, or differ only
  // in the bits base64url leaves unused, and then the "forgery" still verifies
  const dot = value.indexOf(".");
  const at = dot + 1 + Math.floor((value.length - dot - 1) / 2);
  const forged = value.slice(0, at) + (value[at] === "A" ? "B" : "A") + value.slice(at + 1);
  assert.equal((await get(app, "/api/fs/stat?path=/", forged)).status, 401);
  const no = JSON.parse(lines[0]!);
  assert.equal(no.status, 401);
  assert.ok(!("user" in no));
  assert.ok(!lines.join("\n").includes(forged.split(".")[1]!) && !lines.join("\n").includes(forged.split(".")[0]!));
});
