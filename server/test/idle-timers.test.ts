import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Jobs } from "../src/jobs.ts";
import { JobStore } from "../src/job-store.ts";
import { EventBus } from "../src/events/bus.ts";
import { Filter } from "../src/events/filter.ts";
import { trackTimers } from "./timer-probe.ts";

const work = fs.mkdtempSync(path.join(os.tmpdir(), "filedeck-idle-"));
after(() => fs.rmSync(work, { recursive: true, force: true }));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (f: () => boolean, ms = 5000) => {
  for (const t0 = Date.now(); !f() && Date.now() - t0 < ms; ) await sleep(10);
};

test("jobs: the shared-store tick runs only while a job is live, and starts again with the next one", async () => {
  const probe = trackTimers();
  try {
    const jobs = new Jobs(2, 100, undefined, undefined, { store: new JobStore(path.join(work, "jobs.db")), scope: "t", tickMs: 20 });
    await until(() => probe.active() === 0);
    assert.equal(probe.active(), 0, "no job and an empty store: no timer");
    let release!: () => void;
    const j = jobs.create("size", "t", () => new Promise<void>((r) => (release = r)));
    assert.equal(probe.active() > 0, true, "a live job arms the tick");
    await sleep(60);
    assert.equal(probe.active() > 0, true, "it keeps running while the job runs");
    release();
    await until(() => jobs.get(j.id)?.state === "done");
    await until(() => probe.active() === 0);
    assert.equal(probe.active(), 0, "the job is done and stored: the tick stopped");
    jobs.create("size", "t", async () => 1);
    assert.equal(probe.active() > 0, true, "the next job arms it again");
    await until(() => probe.active() === 0);
    assert.equal(probe.active(), 0);
  } finally {
    probe.restore();
  }
});

test("jobs: a live row of another owner keeps the tick running, so a dead peer's job is still adopted", async () => {
  const probe = trackTimers();
  try {
    const file = path.join(work, "peer.db");
    const peer = new JobStore(file);
    const row = { id: "j1", scope: "t", kind: "size", title: "t", params: null, view: JSON.stringify({ id: "j1", kind: "size", title: "t", state: "running", progress: { bytes: 0, totalBytes: 0, entries: 0, totalEntries: 0, current: "" }, createdAt: 1 }), state: "running", owner: "peer", beat: Date.now(), created_at: 1, finished_at: null };
    assert.ok(peer.put(row));
    new Jobs(2, 100, undefined, undefined, { store: new JobStore(file), scope: "t", tickMs: 20, leaseMs: 100_000 });
    await sleep(120);
    assert.equal(probe.active() > 0, true, "the peer's row is live: keep looking");
    assert.ok(peer.put({ ...row, state: "done", finished_at: 2 }));
    await until(() => probe.active() === 0);
    assert.equal(probe.active(), 0, "the row ended: nothing left to watch");
  } finally {
    probe.restore();
  }
});

test("event bus: no timer without a subscriber, one while a subscriber is connected", async () => {
  const probe = trackTimers();
  const bus = new EventBus({ node: "n1", journal: { dir: null } });
  try {
    assert.equal(probe.active(), 0, "a new bus holds no timer");
    bus.publish({ kind: "create", path: "/a", dir: false } as never);
    await until(() => probe.active() === 0); // the first event waits for the lease, then the bus serves and the tick ends
    assert.equal(probe.active(), 0, "a writer with no subscriber checks its lease at each event, not on a timer");
    const sub = await bus.subscribe(new Filter({}), undefined, "internal");
    assert.equal(probe.active() > 0, true, "a subscriber arms the lease tick");
    sub.close();
    await until(() => probe.active() === 0);
    assert.equal(probe.active(), 0, "the last subscriber left: the tick stopped");
  } finally {
    await bus.close();
    probe.restore();
  }
});

test("jobs: an idle process wakes its tick when a peer's live row appears in the store (the file change tells it, no poll)", async () => {
  const probe = trackTimers();
  try {
    const file = path.join(work, "wake.db");
    const jobs = new Jobs(2, 100, undefined, undefined, { store: new JobStore(file), scope: "t", tickMs: 20, leaseMs: 100_000 });
    await until(() => probe.active() === 0);
    assert.equal(probe.active(), 0);
    const view = JSON.stringify({ id: "w1", kind: "size", title: "t", state: "running", progress: { bytes: 0, totalBytes: 0, entries: 0, totalEntries: 0, current: "" }, createdAt: 1 });
    const peer = new JobStore(file);
    assert.ok(peer.put({ id: "w1", scope: "t", kind: "size", title: "t", params: null, view, state: "running", owner: "peer", beat: Date.now(), created_at: 1, finished_at: null }));
    await until(() => probe.active() > 0);
    assert.equal(probe.active() > 0, true, "the new row woke the tick");
    assert.ok(peer.put({ id: "w1", scope: "t", kind: "size", title: "t", params: null, view, state: "done", owner: "peer", beat: Date.now(), created_at: 1, finished_at: 2 }));
    await until(() => probe.active() === 0);
    assert.equal(probe.active(), 0);
    await jobs.interrupt(10);
  } finally {
    probe.restore();
  }
});
