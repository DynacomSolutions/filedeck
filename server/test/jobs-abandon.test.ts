import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createAgent } from "../src/agent.ts";
import { loadConfig } from "../src/config.ts";
import { Jobs } from "../src/jobs.ts";
import { JobStore, type JobRow } from "../src/job-store.ts";

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
function orphan(file: string, id: string, state: string, origin: string, kind: string, seenAt?: number): JobRow {
  const createdAt = 1_000_000 + n;
  const view = { id, kind, title: "t", state, origin, ...(seenAt ? { seenAt } : {}), progress: { bytes: 0, totalBytes: 0, entries: 0, totalEntries: 0, current: "" }, createdAt };
  const row = { id, scope: "t", kind, title: "t", params: JSON.stringify({ path: "/tree", fresh: false }), view: JSON.stringify(view), state, owner: "dead", beat: 0, created_at: createdAt, finished_at: null };
  assert.ok(new JobStore(file).put(row));
  return { ...row, cancel: 0 };
}
const never = (signal: AbortSignal) => new Promise<void>((_, rej) => signal.addEventListener("abort", () => rej(new Error("aborted"))));

test("a queued CLI du job nobody asks about is cancelled; a polled one, a UI one and another kind are kept", async () => {
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
  assert.equal(jobs.get(idle.id)!.state, "canceled");
  assert.equal(jobs.get(polled.id)!.state, "queued");
  assert.equal(jobs.get(ui.id)!.state, "queued");
  assert.equal(jobs.get(size.id)!.state, "queued");
  for (const j of [polled, ui, size]) jobs.cancel(j.id);
});

test("without a grace period nothing is cancelled", async () => {
  const jobs = new Jobs(2);
  const j = jobs.create("du", "t", async () => 1, undefined, never, { origin: "cli" });
  await sleep(150);
  assert.equal(jobs.get(j.id)!.state, "queued");
  jobs.cancel(j.id);
});

test("after a restart a stale CLI du job is dropped as canceled; a recently polled one is adopted; UI jobs are adopted", async () => {
  const a = agent({ FILEDECK_DU_ABANDON_MS: "60000" });
  orphan(a.jobsFile, "q-stale", "queued", "cli", "du");
  orphan(a.jobsFile, "r-stale", "running", "cli", "du");
  orphan(a.jobsFile, "r-seen", "running", "cli", "du", Date.now());
  orphan(a.jobsFile, "ui-size", "running", "ui", "size");
  for (const id of ["q-stale", "r-stale"]) {
    const j = await settle(a, id);
    assert.equal(j.state, "canceled", id);
  }
  assert.equal((await settle(a, "r-seen")).state, "done");
  assert.equal((await settle(a, "ui-size")).state, "done");
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
