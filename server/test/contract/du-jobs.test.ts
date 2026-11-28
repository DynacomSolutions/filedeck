import { before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { agentUnderTest, contractTest, dropFixtureRoot, fixtureRoot, type AgentUnderTest } from "./agent-under-test.ts";

// The job routes and the refresh=auto answer, at HTTP level: test/size-store-fresh-api.test.ts (refresh=auto, the long poll),
// test/jobs-abandon.test.ts (the replay and the seen time of a du job) and test/size-store-rounds.test.ts (cancel, vanished folders).
let tmp: string;
before(() => {
  tmp = fixtureRoot("filedeck-du-jobs-");
  fs.mkdirSync(path.join(tmp, "t/sub"), { recursive: true });
  fs.writeFileSync(path.join(tmp, "t/sub/f"), "abc");
  for (let i = 0; i < 300; i++) fs.mkdirSync(path.join(tmp, `t/d${i}/e`), { recursive: true });
  fs.mkdirSync(path.join(tmp, "tree"), { recursive: true });
  fs.writeFileSync(path.join(tmp, "tree/a.txt"), "12345");
});
after(() => dropFixtureRoot(tmp));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
type Job = { id: string; kind: string; state: string; origin?: string; seenAt?: number; error?: string; result?: Record<string, unknown>; createdAt: number; startedAt?: number; finishedAt?: number; progress: { bytes: number; totalBytes: number; entries: number; totalEntries: number; current: string }; queue?: { position: number; ahead: unknown[] } };
const post = (a: AgentUnderTest, p: string, body: unknown) => a.request(p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const job = async (a: AgentUnderTest, id: string) => (await (await a.request(`/api/jobs/${id}`)).json()) as Job;
async function settle(a: AgentUnderTest, id: string): Promise<Job> {
  for (let i = 0; i < 500; i++) {
    const j = await job(a, id);
    if (j.state !== "queued" && j.state !== "running") return j;
    await sleep(20);
  }
  throw new Error("job did not settle");
}

contractTest("GET /api/du?refresh=auto: stored rows answer at once, one background job refreshes them, cachedOnly stays as it was", async () => {
  const app = await agentUnderTest({ root: tmp, env: { FILEDECK_DU_WAIT_MS: "60000" } });
  try {
    type Ans = { stale?: boolean; ageMs?: number; refreshJobId?: string; cached: boolean; entries: { bytes: number }[] };
    const list = async () => ((await (await app.request("/api/jobs")).json()) as { jobs: { id: string; kind: string }[] }).jobs;
    const auto = async () => (await (await app.request("/api/du?path=/t&depth=1&refresh=auto")).json()) as Ans;
    assert.equal((await app.request("/api/du?path=/t&depth=1&refresh=sometimes")).status, 400);
    assert.equal((await app.request("/api/du?path=/t&depth=1&refresh=auto&fresh=1")).status, 400);
    assert.equal((await app.request("/api/du?path=/t&depth=1&refresh=auto&cachedOnly=1")).status, 400);
    // not stored: the old path (a job, then the answer), nothing new in the answer
    const first = await app.request("/api/du?path=/t&depth=1&refresh=auto");
    assert.equal(first.status, 200);
    assert.equal(((await first.json()) as Ans).refreshJobId, undefined);
    // stored, not vouched for: three requests at once are answered from the store and share one job
    const before = (await list()).length;
    const t0 = Date.now();
    const [a, b, c] = await Promise.all([auto(), auto(), auto()]);
    assert.ok(Date.now() - t0 < 5000);
    for (const x of [a, b, c]) {
      assert.equal(x.stale, true);
      assert.equal(x.cached, true);
      assert.equal(typeof x.ageMs, "number");
      assert.ok(x.entries[0]!.bytes >= 3);
      assert.equal(typeof x.refreshJobId, "string");
    }
    assert.equal(b.refreshJobId, a.refreshJobId, "joined the same job");
    assert.equal(c.refreshJobId, a.refreshJobId);
    assert.equal((await list()).length, before + 1, "one job for three requests");
    // the job can be followed with a long poll
    const done = (await (await app.request(`/api/jobs/${a.refreshJobId}?wait=20`)).json()) as Job;
    assert.equal(done.state, "done");
    assert.equal((await app.request(`/api/jobs/${a.refreshJobId}?wait=abc`)).status, 400);
    assert.equal((await app.request(`/api/jobs/${a.refreshJobId}?wait=31`)).status, 400);
    assert.equal((await app.request(`/api/jobs/${a.refreshJobId}?wait=`)).status, 400);
    // cachedOnly: no job, no refreshJobId, as before
    const n = (await list()).length;
    const cached = (await (await app.request("/api/du?path=/t&depth=1&cachedOnly=1")).json()) as Ans;
    assert.equal(cached.stale, true);
    assert.equal(cached.refreshJobId, undefined);
    assert.equal((await list()).length, n);
  } finally {
    await app.close();
  }
});

contractTest("the job view: fields, the queue of a waiting job, the long poll, cancel and dismiss", async () => {
  // one job at a time, so the second waits
  const app = await agentUnderTest({ root: tmp, env: { FILEDECK_JOB_CONCURRENCY: "1", FILEDECK_DU_WAIT_MS: "60000" } });
  try {
    const a = (await (await post(app, "/api/jobs/size", { path: "/t", fresh: true })).json()) as Job;
    const b = (await (await post(app, "/api/jobs/size", { path: "/tree", fresh: true })).json()) as Job;
    assert.equal(a.kind, "size");
    assert.equal(a.origin, "ui");
    assert.ok(a.id && a.id !== b.id);
    assert.equal(typeof a.createdAt, "number");
    assert.deepEqual(Object.keys(a.progress).sort(), ["bytes", "current", "entries", "totalBytes", "totalEntries"]);
    // the second job is queued behind the first or already done: when it still waits it says what is ahead of it
    const bj = await job(app, b.id);
    if (bj.state === "queued") {
      assert.ok(bj.queue!.position >= 1);
      assert.ok(bj.queue!.ahead.length >= 1);
    }
    // the long poll returns when the job has ended, well before the wait is over
    const t0 = Date.now();
    const ended = (await (await app.request(`/api/jobs/${b.id}?wait=25`)).json()) as Job;
    assert.equal(ended.state, "done");
    assert.ok(Date.now() - t0 < 20_000);
    assert.ok(ended.startedAt && ended.finishedAt && ended.finishedAt >= ended.startedAt);
    assert.equal(ended.result!.files, 1);
    assert.equal(ended.result!.bytes, 5);
    const listed = ((await (await app.request("/api/jobs")).json()) as { jobs: Job[] }).jobs;
    assert.ok(listed.some((j) => j.id === a.id) && listed.some((j) => j.id === b.id));
    for (let i = 1; i < listed.length; i++) assert.ok(listed[i - 1]!.createdAt >= listed[i]!.createdAt, "newest first");
    // a finished job is dismissed; an unknown one is not found; cancel answers the job
    await settle(app, a.id);
    assert.equal((await app.request(`/api/jobs/${a.id}`, { method: "DELETE" })).status, 200);
    assert.equal((await app.request(`/api/jobs/${a.id}`)).status, 404);
    assert.equal((await app.request(`/api/jobs/${a.id}`, { method: "DELETE" })).status, 404);
    assert.equal((await post(app, `/api/jobs/${a.id}/cancel`, {})).status, 404);
    const c = (await post(app, `/api/jobs/${b.id}/cancel`, {})) ;
    assert.equal(c.status, 200);
    assert.equal(((await c.json()) as Job).state, "done", "cancelling a finished job changes nothing");
    assert.equal((await app.request("/api/jobs/does-not-exist?wait=1")).status, 404);
  } finally {
    await app.close();
  }
});

contractTest("a queued job can be canceled, and it does not block the one after it", async () => {
  const app = await agentUnderTest({ root: tmp, env: { FILEDECK_JOB_CONCURRENCY: "1", FILEDECK_DU_WAIT_MS: "60000" } });
  try {
    // five scans of one folder, one after the other: while the first runs the others wait for the slot
    const ids: string[] = [];
    for (const p of ["/t", "/tree", "/t/sub", "/t/d1", "/t/d2"]) ids.push(((await (await post(app, "/api/jobs/size", { path: p, fresh: true })).json()) as Job).id);
    const victim = ids[4]!;
    const r = await post(app, `/api/jobs/${victim}/cancel`, {});
    assert.equal(r.status, 200);
    const v = await settle(app, victim);
    assert.ok(["canceled", "done"].includes(v.state), v.state); // (a fast agent may have finished it already)
    for (const id of ids.slice(0, 4)) assert.equal((await settle(app, id)).state, "done");
    // and the agent still scans
    assert.equal((await settle(app, ((await (await post(app, "/api/jobs/size", { path: "/tree" })).json()) as Job).id)).state, "done");
  } finally {
    await app.close();
  }
});

contractTest("a size job of a folder that vanished before it started fails with not found; the others go on", async () => {
  const root = path.join(tmp, "p");
  for (const d of ["x", "z"]) fs.mkdirSync(path.join(root, d), { recursive: true });
  const app = await agentUnderTest({ root: tmp, env: { FILEDECK_JOB_CONCURRENCY: "1", FILEDECK_DU_WAIT_MS: "60000" } });
  try {
    const first = (await (await post(app, "/api/jobs/size", { path: "/t", fresh: true })).json()) as Job;
    const x = (await (await post(app, "/api/jobs/size", { path: "/p/x" })).json()) as Job;
    const z = (await (await post(app, "/api/jobs/size", { path: "/p/z" })).json()) as Job;
    fs.rmSync(path.join(root, "x"), { recursive: true });
    assert.equal((await settle(app, first.id)).state, "done");
    const xs = await settle(app, x.id);
    // (a fast agent may have started it before the folder went: then it is done)
    if (xs.state === "failed") assert.equal(xs.error, "not found");
    else assert.equal(xs.state, "done");
    assert.equal((await settle(app, z.id)).state, "done");
  } finally {
    await app.close();
  }
});

contractTest("the replay of a finished du still works, and the poll marks the job as seen", async () => {
  const app = await agentUnderTest({ root: tmp, env: { FILEDECK_DU_ABANDON_MS: "60000" } });
  try {
    const first = await app.request("/api/du?path=/tree&fresh=1");
    assert.equal(first.status, 200);
    const list = ((await (await app.request("/api/jobs")).json()) as { jobs: Job[] }).jobs;
    assert.equal(list[0]!.origin, "cli", "a du job comes from the CLI");
    assert.equal(list[0]!.kind, "du");
    assert.ok(list[0]!.seenAt, "the request that waited on it marked it as seen");
    assert.equal((await app.request("/api/du?path=/tree&fresh=1")).status, 200);
  } finally {
    await app.close();
  }
});

contractTest("a size job and a du of one path share one live job; a rescan joins only a rescan", async () => {
  const app = await agentUnderTest({ root: tmp, env: { FILEDECK_JOB_CONCURRENCY: "1", FILEDECK_DU_WAIT_MS: "60000" } });
  try {
    // keep the slot busy so the jobs below stay queued while the requests are made
    const busy = (await (await post(app, "/api/jobs/size", { path: "/t", fresh: true })).json()) as Job;
    const plain = (await (await post(app, "/api/jobs/size", { path: "/tree" })).json()) as Job;
    const again = (await (await post(app, "/api/jobs/size", { path: "/tree" })).json()) as Job;
    if (plain.state !== "queued") return; // (the agent was fast enough to finish them: nothing to join)
    assert.equal(again.id, plain.id, "the same path joins the live job");
    const rescan = (await (await post(app, "/api/jobs/size", { path: "/tree", fresh: true })).json()) as Job;
    assert.notEqual(rescan.id, plain.id, "a rescan does not join a job that may answer from stored rows");
    const rescan2 = (await (await post(app, "/api/jobs/size", { path: "/tree", fresh: true })).json()) as Job;
    assert.equal(rescan2.id, rescan.id);
    for (const j of [busy, plain, rescan]) await settle(app, j.id);
  } finally {
    await app.close();
  }
});
