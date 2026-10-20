import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Jobs, type Rebuild } from "../src/jobs.ts";
import { JobStore } from "../src/job-store.ts";

let tmp: string;
let n = 0;
before(() => void (tmp = fs.mkdtempSync(path.join(os.tmpdir(), "filedeck-jobstore-"))));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const file = () => path.join(tmp, `jobs-${n++}.db`);
const mk = (f: string, leaseMs = 50, keep = 100, rebuild?: Record<string, Rebuild>) =>
  new Jobs(2, keep, undefined, undefined, { store: new JobStore(f), scope: "n", leaseMs, tickMs: 3_600_000, rebuild });
const hang = (ctl: { signal: AbortSignal }) => new Promise<void>((_, rej) => ctl.signal.addEventListener("abort", () => rej(new Error("aborted"))));

test("another instance reads, lists and cancels a job it does not own", async () => {
  const f = file();
  const a = mk(f, 10_000);
  const b = mk(f, 10_000);
  const v = a.create("x", "slow", hang);
  assert.equal(b.get(v.id)?.title, "slow");
  assert.deepEqual(b.list().map((j) => j.id), [v.id]);
  assert.equal(b.dismiss(v.id), false);
  b.cancel(v.id);
  a.tick();
  await sleep(20);
  assert.equal(a.get(v.id)?.state, "canceled");
  assert.equal(b.get(v.id)?.state, "canceled");
  assert.equal(b.dismiss(v.id), true);
  assert.equal(a.get(v.id)?.state, "canceled"); // a still remembers it, the row is gone
  assert.equal(new Jobs(1, 100, undefined, undefined, { store: new JobStore(f), scope: "n" }).get(v.id), undefined);
});

test("a silent owner's job is failed by an adopter, same id; a beating owner keeps it", async () => {
  const f = file();
  const a = mk(f);
  const b = mk(f);
  const v = a.create("x", "slow", hang);
  await sleep(10);
  b.tick();
  assert.equal(b.get(v.id)?.state, "running"); // lease not over
  a.tick(); // beat
  await sleep(40);
  b.tick();
  assert.equal(b.get(v.id)?.state, "running");
  await sleep(70);
  b.tick();
  const got = b.get(v.id)!;
  assert.equal(got.state, "failed");
  assert.match(got.error!, /Start it again/);
  assert.ok(got.finishedAt);
  a.tick(); // the old owner learns it lost the job and stops it, persisting nothing
  await sleep(10);
  assert.equal(a.get(v.id)?.state, "failed");
});

test("claim is a compare and swap: one winner", () => {
  const f = file();
  const a = mk(f);
  const s = new JobStore(f);
  const v = a.create("x", "slow", hang);
  const row = s.get(v.id)!;
  assert.equal(s.claim(v.id, row.owner, row.beat, "p1", 1), true);
  assert.equal(s.claim(v.id, row.owner, row.beat, "p2", 2), false);
});

test("an adopted job with params and a rebuilder runs again under the same id", async () => {
  const f = file();
  const a = mk(f);
  const v = a.create("x", "again", hang, undefined, undefined, { params: { p: 1 } });
  const seen: unknown[] = [];
  const b = mk(f, 50, 100, { x: async (p) => (seen.push(p), { run: async () => "ok" }) });
  await sleep(70);
  b.tick();
  await sleep(30);
  assert.deepEqual(seen, [{ p: 1 }]);
  assert.equal(b.get(v.id)?.state, "done");
  assert.equal(b.get(v.id)?.createdAt, v.createdAt);
});

test("prune keeps the newest N finished rows", async () => {
  const f = file();
  const a = mk(f, 10_000, 2);
  for (let i = 0; i < 4; i++) {
    a.create("x", `j${i}`, async () => i);
    await sleep(5);
  }
  await sleep(20);
  assert.equal(new JobStore(f).list("n").length, 2);
});

test("no jobsFile: in memory, nothing persisted", async () => {
  const a = new Jobs(1);
  const v = a.create("x", "t", async () => 1);
  await sleep(10);
  a.tick();
  assert.equal(a.get(v.id)?.state, "done");
  assert.equal(a.dismiss(v.id), true);
  assert.equal(a.get(v.id), undefined);
});

test("interrupt hands live jobs over: beat 0, not canceled, adopted at once", async () => {
  const f = file();
  const a = mk(f, 10_000);
  const b = mk(f, 10_000);
  const v = a.create("x", "slow", hang);
  await a.interrupt(500);
  const row = new JobStore(f).get(v.id)!;
  assert.equal(row.beat, 0);
  assert.equal(row.state, "running");
  b.tick();
  assert.equal(b.get(v.id)?.state, "failed"); // no rebuilder: failed, by the adopter and not as canceled
  assert.equal(new JobStore(f).get(v.id)!.owner === row.owner, false);
});
