import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { serve } from "@hono/node-server";
import type { AddressInfo } from "node:net";
import { createAgent as makeAgent } from "../src/agent.ts";
import { createHub } from "../src/hub.ts";
import { loadConfig } from "../src/config.ts";
import { createReviewer, type PostReview } from "../src/k8s-auth.ts";

const agents: { close(): Promise<void> }[] = [];
const servers: ReturnType<typeof serve>[] = [];
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "filedeck-k8sauth-")));
fs.mkdirSync(path.join(tmp, "d"));
fs.writeFileSync(path.join(tmp, "d/f"), "hello");
after(async () => {
  for (const a of agents) await a.close().catch(() => {});
  for (const s of servers) s.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});
const open = (app: { fetch: never }) =>
  new Promise<ReturnType<typeof serve>>((res) => {
    const s: ReturnType<typeof serve> = serve({ fetch: app.fetch, port: 0 }, () => res(s));
    servers.push(s);
  });

const jwt = (exp: number, n = "a") => `${Buffer.from("{}").toString("base64url")}.${Buffer.from(JSON.stringify({ exp, n })).toString("base64url")}.sig`;
const farExp = Math.floor(Date.now() / 1000) + 3600;
/** A fake API server: the token text picks the answer. */
function fakeReview(calls: object[] = []): PostReview {
  return async (body) => {
    calls.push(body);
    const raw = (body as { spec: { token: string } }).spec.token;
    // the "n" claim picks the answer
    const token = raw.includes(".") ? Buffer.from(raw.split(".")[1] as string, "base64url").toString() : raw;
    const user = (ns: string, sa: string) => `system:serviceaccount:${ns}:${sa}`;
    const answer = (status: object) => ({ status: 200, json: { status } });
    if (token.includes("bad")) return answer({ authenticated: false });
    const aud = (token.includes("aud") ? ["other"] : ["filedeck"]);
    return answer({ authenticated: true, audiences: aud, user: { username: token.includes("stranger") ? user("evil", "x") : user("agents", "worker") } });
  };
}
const ALLOW = ["agents/worker"];
async function hub(calls: object[] = [], audit: string[] = []) {
  const made = makeAgent(loadConfig({ FILEDECK_ROOT: tmp, FILEDECK_NODE: "t", FILEDECK_AGENT_TOKEN: "agent-secret" } as never));
  agents.push(made as unknown as { close(): Promise<void> });
  const agent = await open(made as never);
  const h = createHub(
    loadConfig({ FILEDECK_MODE: "hub", FILEDECK_STATIC: tmp, FILEDECK_AGENT_TOKEN: "agent-secret", FILEDECK_K8S_ALLOW: ALLOW.join(","), NODES: `n=http://127.0.0.1:${(agent.address() as AddressInfo).port}` } as never),
    undefined,
    (l) => audit.push(l),
    { k8sReview: fakeReview(calls) },
  );
  return (p: string, token: string, method = "GET") => h.request(p, { method, headers: { "x-filedeck-token": token } });
}

test("allowed ServiceAccount token reads du, and the call is audited with the caller", async () => {
  const calls: object[] = [];
  const audit: string[] = [];
  const req = await hub(calls, audit);
  const t = jwt(farExp);
  const r = await req("/api/nodes/n/api/du?path=/d&depth=1", t);
  assert.equal(r.status, 200);
  assert.deepEqual((calls[0] as { spec: { audiences: string[] } }).spec.audiences, ["filedeck"]);
  const line = JSON.parse(audit.at(-1) as string) as { caller: string; status: number; auth: string };
  assert.deepEqual([line.caller, line.status, line.auth], ["agents/worker", 200, "k8s"]);
});

test("rejected, wrong audience and unreviewable tokens answer 401", async () => {
  const req = await hub();
  assert.equal((await req("/api/nodes/n/api/du?path=/d", jwt(farExp, "bad"))).status, 401);
  assert.equal((await req("/api/nodes/n/api/du?path=/d", jwt(farExp, "aud"))).status, 401);
  assert.equal((await req("/api/nodes/n/api/du?path=/d", "not-a-jwt")).status, 401);
});

test("a ServiceAccount outside the allowlist answers 403", async () => {
  const audit: string[] = [];
  const req = await hub([], audit);
  assert.equal((await req("/api/nodes/n/api/du?path=/d", jwt(farExp, "stranger"))).status, 403);
  assert.equal((JSON.parse(audit.at(-1) as string) as { caller: string }).caller, "evil/x");
});

test("a ServiceAccount token reaches no route but du and its jobs", async () => {
  const req = await hub();
  const t = jwt(farExp);
  for (const [p, m] of [["/api/groups", "GET"], ["/api/v1/changes", "GET"], ["/api/nodes/n/api/v1/changes", "GET"], ["/api/nodes/n/api/list?path=/d", "GET"], ["/api/nodes/n/api/jobs/size", "POST"], ["/api/admin/accounts", "GET"], ["/api/nodes/n/api/du?path=/d", "POST"]] as const) {
    assert.equal((await req(p, t, m)).status, 403, `${m} ${p}`);
  }
});

test("the reviewer caches by token hash until the token expires", async () => {
  const calls: object[] = [];
  let now = 1_000_000;
  const review = createReviewer({ allow: ALLOW, audience: "filedeck", api: "", tokenFile: "", caFile: "" }, fakeReview(calls), () => now);
  const t = jwt(Math.floor(now / 1000) + 60);
  assert.equal((await review(t)).ok, true);
  assert.equal((await review(t)).ok, true);
  assert.equal(calls.length, 1);
  now += 61_000;
  assert.equal((await review(t)).ok, true);
  assert.equal(calls.length, 2);
  // a refusal is remembered for a short time only
  const bad = jwt(farExp, "bad");
  assert.equal((await review(bad)).ok, false);
  assert.equal((await review(bad)).ok, false);
  assert.equal(calls.length, 3);
  now += 31_000;
  await review(bad);
  assert.equal(calls.length, 4);
});

test("an API server failure is not cached", async () => {
  let n = 0;
  const review = createReviewer({ allow: ALLOW, audience: "filedeck", api: "", tokenFile: "", caFile: "" }, async (b) => {
    if (n++ === 0) throw new Error("down");
    return fakeReview()(b);
  });
  const t = jwt(farExp);
  assert.equal((await review(t)).ok, false);
  assert.equal((await review(t)).ok, true);
});

test("a namespace wildcard allows every ServiceAccount in it", async () => {
  const review = createReviewer({ allow: ["agents/*"], audience: "filedeck", api: "", tokenFile: "", caFile: "" }, fakeReview());
  assert.equal((await review(jwt(farExp))).ok, true);
  assert.equal((await review(jwt(farExp, "stranger"))).ok, false);
});
