import { before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { agentUnderTest, contractTest, dropFixtureRoot, fixtureRoot, type AgentUnderTest } from "./agent-under-test.ts";

// Behaviour that needs a scan that lasts: a queued job nobody asks about is forgotten (test/jobs-abandon.test.ts), a scan of an
// overlapping folder is not waited for (test/size-store-fresh-api.test.ts), a du that waits too long answers 202 and its repeat is
// answered from that job (test/size-store-rounds.test.ts). The TS tests hold the walk on a gate inside the process. Over HTTP the walk
// is a big tree, so each test says "too fast" when the agent finished the scan before the check could be made.
let tmp: string;
before(() => {
  tmp = fixtureRoot("filedeck-du-queue-");
  for (let i = 0; i < 12_000; i++) {
    const d = path.join(tmp, `big/a${i % 120}/b${i}`);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, "f"), "x");
    fs.writeFileSync(path.join(d, "g"), "yy");
  }
  fs.mkdirSync(path.join(tmp, "small"), { recursive: true });
  fs.writeFileSync(path.join(tmp, "small/f"), "12345");
});
after(() => dropFixtureRoot(tmp));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
type Job = { id: string; state: string };
const post = (a: AgentUnderTest, p: string, body: unknown) => a.request(p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const state = async (a: AgentUnderTest, id: string) => ((await (await a.request(`/api/jobs/${id}`)).json()) as Job).state;

contractTest("a queued CLI du job nobody asks about is forgotten; a polled one is kept", async () => {
  const app = await agentUnderTest({ root: tmp, env: { FILEDECK_JOB_CONCURRENCY: "1", FILEDECK_DU_ABANDON_MS: "60", FILEDECK_DU_WAIT_MS: "20" } });
  try {
    const busy = (await (await post(app, "/api/jobs/size", { path: "/big", fresh: true })).json()) as Job;
    const idle = await app.request("/api/du?path=/small&depth=0");
    const polled = await app.request("/api/du?path=/big/a1&depth=0");
    assert.equal(idle.status, 202, "the slot is taken, so the du waits in the queue");
    assert.equal(polled.status, 202);
    const idleId = ((await idle.json()) as { jobId: string }).jobId;
    const polledId = ((await polled.json()) as { jobId: string }).jobId;
    const listed = async () => ((await (await app.request("/api/jobs")).json()) as { jobs: Job[] }).jobs.map((j) => j.id); // (a list does not mark anything as seen)
    let forgotten = false;
    while ((await state(app, busy.id)) === "running") {
      assert.equal((await app.request(`/api/jobs/${polledId}`)).status, 200); // this poll keeps the job
      if (!(await listed()).includes(idleId)) {
        forgotten = true;
        break;
      }
      await sleep(15);
    }
    assert.ok(forgotten, "the scan ended before the grace period did: the tree is too small for this agent");
    assert.ok((await listed()).includes(polledId), "a polled job stays");
    assert.equal((await app.request(`/api/jobs/${idleId}`)).status, 404, "forgotten, not canceled: a returning client gets 404");
    // the du CLI asks again, and gets its answer
    for (const id of [busy.id, polledId]) for (let i = 0; i < 400 && ["queued", "running"].includes(await state(app, id)); i++) await sleep(20);
    const again = await app.request("/api/du?path=/small&depth=0&fresh=1");
    assert.ok([200, 202].includes(again.status));
  } finally {
    await app.close();
  }
});

contractTest("without a grace period nothing is dropped", async () => {
  const app = await agentUnderTest({ root: tmp, env: { FILEDECK_JOB_CONCURRENCY: "1", FILEDECK_DU_ABANDON_MS: "0", FILEDECK_DU_WAIT_MS: "20" } });
  try {
    const busy = (await (await post(app, "/api/jobs/size", { path: "/big", fresh: true })).json()) as Job;
    const r = await app.request("/api/du?path=/small&depth=0");
    assert.equal(r.status, 202);
    const id = ((await r.json()) as { jobId: string }).jobId;
    await sleep(150);
    const list = ((await (await app.request("/api/jobs")).json()) as { jobs: Job[] }).jobs;
    assert.ok(list.some((j) => j.id === id), "still known");
    for (const x of [busy.id, id]) for (let i = 0; i < 600 && ["queued", "running"].includes(await state(app, x)); i++) await sleep(20);
  } finally {
    await app.close();
  }
});

contractTest("a du of a folder with a live scan of an overlapping folder is answered from stored rows with stale:true and starts no job", async () => {
  const app = await agentUnderTest({ root: tmp, env: { FILEDECK_DU_WAIT_MS: "60000" } });
  try {
    // /big/a0 is stored; a rescan of /big (which holds it) is then live
    assert.equal((await app.request("/api/du?path=/big/a0&depth=1")).status, 200);
    const scan = (await (await post(app, "/api/jobs/size", { path: "/big", fresh: true })).json()) as Job;
    const before = ((await (await app.request("/api/jobs")).json()) as { jobs: unknown[] }).jobs.length;
    let seen: { stale?: boolean; entries: { path: string }[] } | undefined;
    while ((await state(app, scan.id)) !== "done" && !seen?.stale) {
      const r = await app.request("/api/du?path=/big/a0&depth=1");
      assert.equal(r.status, 200, "answered at once");
      const body = (await r.json()) as { stale?: boolean; entries: { path: string }[] };
      if (body.stale) seen = body;
      else await sleep(5);
    }
    assert.ok(seen, "the scan ended before an answer could be asked for: the tree is too small for this agent");
    assert.equal(seen.entries[0]!.path, "/big/a0");
    const after = ((await (await app.request("/api/jobs")).json()) as { jobs: unknown[] }).jobs.length;
    assert.equal(after, before, "no job was started for the du");
    for (let i = 0; i < 600 && ["queued", "running"].includes(await state(app, scan.id)); i++) await sleep(20);
  } finally {
    await app.close();
  }
});

contractTest("a du that waits too long answers 202; the job is followed with a long poll and the repeat is answered from it", async (t) => {
  const app = await agentUnderTest({ root: tmp, env: { FILEDECK_DU_WAIT_MS: "20" } });
  try {
    const first = await app.request("/api/du?path=/big&depth=0&fresh=1");
    if (first.status === 200) return void t.skip("the agent scanned the tree within the wait: nothing to follow");
    assert.equal(first.status, 202);
    const { jobId, state: s0 } = (await first.json()) as { jobId: string; state: string };
    assert.ok(["queued", "running"].includes(s0));
    const j = (await (await app.request(`/api/jobs/${jobId}?wait=30`)).json()) as { state: string; kind: string; origin: string; result?: { res: { files: number } } };
    assert.equal(j.state, "done");
    assert.equal(j.kind, "du");
    assert.equal(j.origin, "cli");
    assert.equal(j.result!.res.files, 24_000);
    // the same request, within a minute, is answered from that scan: no new walk
    const jobsBefore = ((await (await app.request("/api/jobs")).json()) as { jobs: unknown[] }).jobs.length;
    const again = await app.request("/api/du?path=/big&depth=0&fresh=1");
    assert.equal(again.status, 200);
    const body = (await again.json()) as { cached: boolean; entries: { files: number; dirs: number }[] };
    assert.equal(body.cached, true, "nothing was read for the repeat");
    assert.equal(body.entries[0]!.files, 24_000);
    assert.equal(body.entries[0]!.dirs, 12_120);
    assert.equal(((await (await app.request("/api/jobs")).json()) as { jobs: unknown[] }).jobs.length, jobsBefore);
  } finally {
    await app.close();
  }
});
