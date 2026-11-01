import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createAgent } from "../src/agent.ts";
import { loadConfig } from "../src/config.ts";
import { Jobs } from "../src/jobs.ts";
import { JobStore, type JobRow } from "../src/job-store.ts";
import { SizeStore } from "../src/size-store.ts";
import { run as duRun, type RunIo } from "../src/du-cli.ts";

let tmp: string;
let n = 0;
before(() => void (tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "filedeck-abandon-")))));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Job = { id: string; state: string; origin?: string; seenAt?: number };
function agent(env: Record<string, string> = {}) {
  const root = path.join(tmp, `root${n}`);
  fs.mkdirSync(path.join(root, "tree"), { recursive: true });
  fs.writeFileSync(path.join(root, "tree/a.txt"), "12345");
  const jobsFile = path.join(tmp, `jobs${n++}.db`);
  const app = createAgent(loadConfig({ FILEDECK_ROOT: root, FILEDECK_NODE: "t", FILEDECK_JOBS_FILE: jobsFile, ...env } as never));
  return { app, jobsFile, close: () => (app as unknown as { close(): Promise<void> }).close() };
}
async function settle(a: { app: { request: Function } }, id: string): Promise<Job> {
  for (let i = 0; i < 400; i++) {
    const r = (await a.app.request(`/api/jobs/${id}`)) as Response;
    if (r.status === 200) {
      const j = (await r.json()) as Job;
      if (j.state !== "queued" && j.state !== "running") return j;
    }
    await sleep(25);
  }
  throw new Error("job did not settle");
}
function orphan(file: string, id: string, state: string, origin: string, kind: string, seenAt?: number, column = 0): JobRow {
  const createdAt = 1_000_000 + n;
  const view = { id, kind, title: "t", state, origin, ...(seenAt ? { seenAt } : {}), progress: { bytes: 0, totalBytes: 0, entries: 0, totalEntries: 0, current: "" }, createdAt };
  const row = { id, scope: "t", kind, title: "t", params: JSON.stringify({ path: "/tree", fresh: false }), view: JSON.stringify(view), state, owner: "dead", beat: 0, created_at: createdAt, finished_at: null };
  void column;
  assert.ok(new JobStore(file).put(row));
  return { ...row, cancel: 0 };
}
const never = (signal: AbortSignal) => new Promise<void>((_, rej) => signal.addEventListener("abort", () => rej(new Error("aborted"))));

/** (read from the store, not through the API: a poll is exactly what keeps a job alive) */
async function gone(a: { jobsFile: string }, id: string): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (!new JobStore(a.jobsFile).get(id, "t")) return;
    await sleep(25);
  }
  throw new Error("job still known");
}

test("a queued CLI du job nobody asks about is forgotten; a polled one, a UI one and another kind are kept", async () => {
  const jobs = new Jobs(2);
  jobs.abandonMs = 200;
  const mk = (kind: string, origin: "cli" | "ui") => jobs.create(kind, "t", async () => 1, undefined, never, { origin });
  const idle = mk("du", "cli");
  const polled = mk("du", "cli");
  const ui = mk("du", "ui");
  const size = mk("size", "cli");
  for (let i = 0; i < 12; i++) {
    jobs.touch(polled.id);
    await sleep(40);
  }
  assert.equal(jobs.get(idle.id), undefined, "forgotten, not canceled: a returning client gets 404");
  assert.equal(jobs.get(polled.id)!.state, "queued");
  assert.equal(jobs.get(ui.id)!.state, "queued");
  assert.equal(jobs.get(size.id)!.state, "queued");
  for (const j of [polled, ui, size]) jobs.cancel(j.id);
});

test("without a grace period nothing is dropped", async () => {
  const jobs = new Jobs(2);
  const j = jobs.create("du", "t", async () => 1, undefined, never, { origin: "cli" });
  await sleep(150);
  assert.equal(jobs.get(j.id)!.state, "queued");
  jobs.cancel(j.id);
});

test("a client polling through another process keeps the owner's queued job alive, and the owner's heartbeat does not lose it", async () => {
  const file = path.join(tmp, `shared${n++}.db`);
  const shared = (store: JobStore) => ({ store, scope: "t", tickMs: 50, leaseMs: 30_000 });
  const A = new Jobs(2, 100, undefined, undefined, shared(new JobStore(file)));
  const B = new Jobs(2, 100, undefined, undefined, shared(new JobStore(file)));
  A.abandonMs = B.abandonMs = 300;
  const j = A.create("du", "t", async () => 1, undefined, never, { origin: "cli", params: { path: "/x", fresh: false } });
  for (let i = 0; i < 20; i++) {
    B.touch(j.id);
    await sleep(50);
  }
  assert.equal(A.get(j.id)!.state, "queued");
  assert.equal(B.get(j.id)!.state, "queued");
  assert.ok(JSON.parse(new JobStore(file).get(j.id, "t")!.view).seenAt > 0, "the owner's heartbeat carries the time other processes recorded");
  // and once nobody polls, the owner forgets it
  await sleep(700);
  assert.equal(A.get(j.id), undefined);
  assert.equal(new JobStore(file).get(j.id, "t"), undefined);
});

test("after a restart a CLI du job whose client was last seen long ago is forgotten, one seen recently or never recorded is adopted, UI jobs are adopted", async () => {
  const a = agent({ FILEDECK_DU_ABANDON_MS: "60000" });
  orphan(a.jobsFile, "q-stale", "queued", "cli", "du", 5_000);
  orphan(a.jobsFile, "r-stale", "running", "cli", "du", 5_000);
  orphan(a.jobsFile, "r-seen", "running", "cli", "du", Date.now());
  orphan(a.jobsFile, "r-unknown", "running", "cli", "du"); // a row of a version that did not record it: its client may well be polling
  orphan(a.jobsFile, "ui-size", "running", "ui", "size");
  await gone(a, "q-stale");
  await gone(a, "r-stale");
  for (const id of ["r-seen", "r-unknown", "ui-size"]) assert.equal((await settle(a, id)).state, "done", id);
  await a.close();
});

test("the replay of a finished du still works and the poll marks the job as seen", async () => {
  const a = agent({ FILEDECK_DU_ABANDON_MS: "60000" });
  const first = (await a.app.request("/api/du?path=/tree&fresh=1")) as Response;
  assert.equal(first.status, 200);
  const list = ((await (await a.app.request("/api/jobs")).json()) as { jobs: Job[] }).jobs;
  assert.equal(list[0]!.origin, "cli");
  assert.ok(list[0]!.seenAt);
  assert.equal(((await a.app.request("/api/du?path=/tree&fresh=1")) as Response).status, 200);
  await a.close();
});

test("the du CLI whose job was forgotten while it was away asks for the scan again and gets its answer", async () => {
  const dir = path.join(tmp, `idx${n}`);
  fs.mkdirSync(dir);
  // another process holds the writer lease, so the agent's scan stays queued
  const holder = new SizeStore(path.join(dir, "sizes-t.db"), { root: tmp, ttlMs: 1000, maxEntries: 1000, leaseMs: 60_000 });
  assert.equal(await holder.mayScan(), true);
  const a = agent({ FILEDECK_DU_ABANDON_MS: "300", FILEDECK_DU_WAIT_MS: "50", FILEDECK_INDEX_DIR: dir, FILEDECK_NODE: "t" });
  const err: string[] = [];
  const out: string[] = [];
  let sleeps = 0;
  const io: RunIo = {
    fetch: (async (u: string) => a.app.request(String(u).replace("https://hub.example/api/nodes/t", ""))) as never,
    out: (s) => out.push(s),
    err: (s) => err.push(s),
    sleep: async () => {
      sleeps++;
      if (sleeps === 1) await sleep(900); // the client is away longer than the grace period: its queued job is forgotten
      else if (sleeps === 2) await holder.close(); // then the other process leaves and the scan can run
      else await sleep(20);
    },
    now: Date.now,
  };
  const status = await duRun(["-s", "--fresh", "t:/tree"], { FILEDECK_URL: "https://hub.example", FILEDECK_TOKEN: "tok" }, io);
  assert.equal(status, 0, err.join("") + " sleeps=" + sleeps);
  assert.match(err.join(""), /job lost, asking for the scan again/);
  assert.match(out.join(""), /\/tree/);
  await a.close();
});
