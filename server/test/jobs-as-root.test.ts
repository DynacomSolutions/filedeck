import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Jobs } from "../src/jobs.ts";
import { JobStore } from "../src/job-store.ts";

/**
 * work-item: a job an administrator starts on an agent under act as root runs as root, so it must stop when the switch ends. The agent
 * gives such a job the switch's end (`until`); the job queue cancels it then, and keeps the end in the stored params, so a process that
 * adopts the job after a restart cancels it at the same time.
 */
let tmp: string;
before(() => void (tmp = fs.mkdtempSync(path.join(os.tmpdir(), "filedeck-jobs-asroot-"))));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const hang = (ctl: { signal: AbortSignal }) => new Promise<void>((_, rej) => ctl.signal.addEventListener("abort", () => rej(new Error("aborted"))));

test("a root job is canceled at its end, running or queued; the end shows in its view", async () => {
  const jobs = new Jobs(1);
  const until = Date.now() + 120;
  const running = jobs.create("compress", "a", hang, undefined, undefined, { owner: "sys:alice", until });
  const queued = jobs.create("compress", "b", hang, undefined, undefined, { owner: "sys:alice", until });
  const plain = jobs.create("compress", "c", hang, undefined, undefined, { owner: "sys:alice" });
  assert.equal(running.asRootUntil, until);
  assert.equal(queued.asRootUntil, until);
  assert.equal(plain.asRootUntil, undefined);
  await sleep(20);
  assert.equal(jobs.get(running.id)?.state, "running");
  await sleep(200);
  assert.equal(jobs.get(running.id)?.state, "canceled");
  assert.equal(jobs.get(queued.id)?.state, "canceled");
  // a job without an end is left alone (it has now started, in the place the others left)
  assert.equal(jobs.get(plain.id)?.state, "running");
  jobs.cancel(plain.id);
});

test("an end that has passed: the job is canceled and never runs; a job that finished first is left as it is", async () => {
  const jobs = new Jobs(2);
  let ran = false;
  let dropped = false;
  const late = jobs.create("compress", "late", async () => void (ran = true), () => void (dropped = true), undefined, { owner: "sys:alice", until: Date.now() - 1 });
  assert.equal(late.state, "canceled");
  await sleep(20);
  assert.equal(jobs.get(late.id)?.state, "canceled");
  assert.equal(ran, false, "its run never started");
  assert.equal(dropped, true, "its onDrop ran, as for any queued job that is canceled");
  const quick = jobs.create("compress", "quick", async () => "ok", undefined, undefined, { owner: "sys:alice", until: Date.now() + 50 });
  await sleep(100);
  assert.equal(jobs.get(quick.id)?.state, "done");
});

test("a job adopted after its end has passed is canceled and never runs", async () => {
  const f = path.join(tmp, "jobs-late.db");
  let ran = false;
  const mk = (rebuild?: Record<string, (p: unknown) => Promise<{ run: (ctl: { signal: AbortSignal }) => Promise<unknown> }>>) =>
    new Jobs(2, 100, undefined, undefined, { store: new JobStore(f), scope: "n", leaseMs: 50, tickMs: 3_600_000, rebuild });
  const a = mk();
  const v = a.create("compress", "root job", hang, undefined, undefined, { params: { dir: "/" }, owner: "sys:alice", until: Date.now() + 60 });
  const b = mk({ compress: async () => ({ run: async () => void (ran = true) }) });
  await sleep(100);
  b.tick();
  await sleep(50);
  assert.equal(b.get(v.id)?.state, "canceled");
  assert.equal(ran, false);
});

test("the end is kept in the stored params: a job adopted after a restart is canceled at the same time", async () => {
  const f = path.join(tmp, "jobs.db");
  const mk = (rebuild?: Record<string, (p: unknown) => Promise<{ run: (ctl: { signal: AbortSignal }) => Promise<unknown> }>>) =>
    new Jobs(2, 100, undefined, undefined, { store: new JobStore(f), scope: "n", leaseMs: 50, tickMs: 3_600_000, rebuild });
  const a = mk();
  const until = Date.now() + 250;
  const v = a.create("compress", "root job", hang, undefined, undefined, { params: { dir: "/" }, owner: "sys:alice", until });
  const seen: unknown[] = [];
  const b = mk({ compress: async (p) => (seen.push(p), { run: hang }) });
  await sleep(70);
  b.tick();
  await sleep(30);
  assert.equal((seen[0] as { asRootUntil?: number }).asRootUntil, until);
  assert.equal(b.get(v.id)?.state, "running");
  assert.equal(b.get(v.id)?.asRootUntil, until);
  await sleep(250);
  assert.equal(b.get(v.id)?.state, "canceled");
});
