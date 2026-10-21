import assert from "node:assert/strict";
import test from "node:test";
import { etaSec, etaText, jobLines, statusPill } from "../src/jobRow.ts";

const prog = (o: Partial<{ bytes: number; totalBytes: number; entries: number; totalEntries: number; current: string }> = {}) => ({ bytes: 0, totalBytes: 0, entries: 0, totalEntries: 0, current: "", ...o });

test("statusPill: text and tone per state, stale connection wins for live jobs", () => {
  assert.deepEqual(statusPill("queued"), { label: "queued", tone: "neutral" });
  assert.deepEqual(statusPill("running", { pct: 42 }), { label: "running 42%", tone: "accent" });
  assert.deepEqual(statusPill("running", { pct: null }), { label: "running", tone: "accent" });
  assert.equal(statusPill("paused").tone, "amber");
  assert.equal(statusPill("done").tone, "green");
  assert.equal(statusPill("failed").tone, "red");
  assert.equal(statusPill("canceled").tone, "muted");
  assert.deepEqual(statusPill("running", { stale: true, who: "hub" }), { label: "waiting for the hub", tone: "amber" });
  assert.deepEqual(statusPill("queued", { stale: true }), { label: "waiting for the agent", tone: "amber" });
  assert.equal(statusPill("done", { stale: true }).label, "done");
});

test("etaSec: needs a total, a rate and a few seconds of history", () => {
  const p = prog({ entries: 100, totalEntries: 400 });
  assert.equal(etaSec(p, 0, 10_000), null); // no start time
  assert.equal(etaSec(p, 9_000, 10_000), null); // too early
  assert.equal(etaSec(prog({ entries: 100 }), 1_000, 11_000), null); // total unknown
  assert.equal(etaSec(prog({ totalEntries: 400 }), 1_000, 11_000), null); // no rate
  assert.equal(etaSec(prog({ entries: 400, totalEntries: 400 }), 1_000, 11_000), null); // finished
  assert.equal(etaSec(p, 1_000, 11_000), 30); // 100 in 10 s, 300 left
  assert.equal(etaSec(prog({ bytes: 50, totalBytes: 150 }), 1_000, 11_000), 20); // bytes when no entry total
});

test("etaText: short forms", () => {
  assert.equal(etaText(12), "under a minute left");
  assert.equal(etaText(240), "about 4 min left");
  assert.equal(etaText(3600), "about 1 h left");
  assert.equal(etaText(7500), "about 2 h 5 min left");
});

test("jobLines: size jobs show size, entries, eta and the current folder", () => {
  const job = { kind: "size", state: "running", startedAt: 1_000, progress: prog({ bytes: 17 * 1024 ** 3, entries: 236482, totalEntries: 4_000_000, current: "/data/a" }) };
  assert.deepEqual(jobLines(job, 1_000 + 10_000), ["17 GiB, 236,482 entries, about 3 min left", "/data/a"]);
  assert.deepEqual(jobLines({ ...job, progress: prog({ entries: 5, current: "/x" }) }, 1_100), ["5 entries", "/x"]);
});

test("jobLines: other kinds show done of total; failed shows the error; queued is empty", () => {
  const p = prog({ bytes: 1024, totalBytes: 4096, entries: 2, totalEntries: 8, current: "f.txt" });
  assert.deepEqual(jobLines({ kind: "compress", state: "running", progress: p }, 0), ["1.0 KiB of 4.0 KiB, 2 of 8 entries", "f.txt"]);
  assert.deepEqual(jobLines({ kind: "size", state: "failed", progress: p, error: "boom" }, 0), ["boom"]);
  assert.deepEqual(jobLines({ kind: "size", state: "queued", progress: prog() }, 0), []);
  assert.deepEqual(jobLines({ kind: "x", state: "done", progress: p, result: { path: "/a.zip", skipped: { symlinks: 1, hardlinks: 0, special: 0 } } }, 0), ["/a.zip", "1 link/special entry skipped for safety"]);
});
