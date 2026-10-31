// A rolling deploy: the new process starts its watcher while the old one still runs, and takes the store's writer lease when the old one lets go.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { FanWatch, type HelperProc } from "../src/fanwatch.ts";
import { SizeStore } from "../src/size-store.ts";

type Any = any; // private state on purpose
class Fake extends EventEmitter implements HelperProc {
  stdout = new PassThrough();
  stderr = new PassThrough();
  /** the real helper answers "sync" with "#sync" once it has printed what the kernel had queued; `lag` holds events back until then (see H3) */
  lag: string[] = [];
  stdin = {
    write: (_: string) => {
      for (const l of this.lag.splice(0)) this.stdout.write(l);
      this.stdout.write("#sync\n");
    },
  };
  kill() {
    return true;
  }
}
let tmp: string;
const things: { close(): Promise<void> | void }[] = [];
before(() => void (tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "filedeck-handover-")))));
after(async () => {
  for (const t of things) await t.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (f: () => boolean | Promise<boolean>, ms = 10_000) => {
  for (const t0 = Date.now(); !(await f()) && Date.now() - t0 < ms; ) await sleep(20);
};
const rows = (db: string, sql: string) => {
  const d = new DatabaseSync(db, { readOnly: true });
  try {
    return d.prepare(sql).all() as Any[];
  } finally {
    d.close();
  }
};

function world(name: string) {
  const root = path.join(tmp, name, "root");
  for (const d of ["a/x", "a/y", "b/z"]) fs.mkdirSync(path.join(root, d), { recursive: true });
  for (const f of ["a/x/f", "a/y/f", "b/z/f"]) fs.writeFileSync(path.join(root, f), "12345");
  const mounts = path.join(tmp, name, "mounts");
  fs.writeFileSync(mounts, "/dev/x / ext4 rw 0 0\n");
  const db = path.join(tmp, name, "sizes.db");
  const proc = (id: string) => {
    const store = new SizeStore(db, { root, ttlMs: 3_600_000, maxEntries: 100_000, leaseMs: 300 });
    const helper = new Fake();
    const w = new FanWatch(store, { helper: "fake", root, procMounts: mounts, spawn: () => helper, settleMs: 5, modifyMs: 300, sessionMs: 50, handoverMs: 3000 });
    store.covers = (v) => w.covers(v);
    store.watchedSince = () => w.watchedSince();
    store.quiet = (v) => w.settled(v);
    things.push({ close: () => store.close() }, { close: () => w.stop() });
    return { id, store, helper, w, root, event: (v: string, kind = "x") => helper.stdout.write(`${kind} ${root}${v}\n`) };
  };
  return { root, db, proc };
}
type Proc = ReturnType<ReturnType<typeof world>["proc"]>;
async function up(p: Proc) {
  await p.w.start();
  p.helper.stdout.write("#ready 1\n");
  await until(() => p.w.covers("/"));
  await until(() => !!(p.w as Any).session);
}

test("H1 a clean rolling deploy: the new process continues the watched time, a change made during the hand-over is served stale and then applied, and nothing is read again", async () => {
  const { root, db, proc } = world("h1");
  const A = proc("A");
  await up(A);
  await A.store.scan("/", undefined, true); // validates: the watcher was ready before it began
  await sleep(5);
  assert.ok(await A.store.freshTree("/", 0, false), "A vouches for the tree");
  const aSince = A.w.watchedSince();
  // the new process starts: read-only, its watcher is ready after A's
  await sleep(10);
  const B = proc("B");
  await up(B);
  assert.equal(B.store.isWriter, false);
  assert.ok(B.w.watchedSince() > aSince, "its own ready time until the hand-over is confirmed");
  // an in-place change during the hand-over: both watchers see it
  fs.writeFileSync(path.join(root, "a/x/f"), "1234567890");
  A.event("/a/x");
  B.event("/a/x");
  await until(() => rows(db, "SELECT COUNT(*) n FROM pending")[0].n === 1);
  assert.equal(await B.store.freshTree("/", 0, false), null, "B only reads: stale");
  // SIGTERM on A: events to the store, session ended clean once B is ready, lease released
  await A.w.handover();
  await A.store.close();
  assert.equal(rows(db, "SELECT clean FROM watch_sessions ORDER BY id")[0].clean, 1);
  await until(() => B.store.isWriter);
  assert.ok(B.store.isWriter);
  await until(() => B.w.watchedSince() === aSince);
  assert.equal(B.w.watchedSince(), aSince, "continuous: the watched time carries over");
  // B applies what A left pending (and what it buffered itself)
  await until(async () => (await B.store.freshTree("/", 0, false)) !== null, 15_000);
  const t = await B.store.freshTree("/", 0, false);
  assert.equal(t?.entries[0]?.bytes, 20, "the change is applied and served fresh");
  const r = await B.store.scanRead("/");
  assert.equal(r.read, 0, "no folder was read again");
  assert.equal(r.res.bytes, 20);
});

test("H2 an overflow in the predecessor moves the watched time to the overflow: what was validated before it is not vouched for", async () => {
  const { db, proc } = world("h2");
  const A = proc("A");
  await up(A);
  await A.store.scan("/", undefined, true);
  A.helper.stdout.write("!overflow\n");
  await sleep(50);
  const lostAt = A.w.watchedSince();
  const B = proc("B");
  await up(B);
  await A.w.handover();
  await A.store.close();
  assert.equal(rows(db, "SELECT clean FROM watch_sessions ORDER BY id")[0].clean, 1, "the run itself saw everything after the overflow");
  await until(() => B.store.isWriter);
  await until(() => B.w.watchedSince() === lostAt);
  assert.equal(B.w.watchedSince(), lostAt, "continuous from the overflow on");
  assert.equal(await B.store.freshTree("/", 0, false), null, "the walk before the overflow does not count");
});

test("L-overflow an overflow hours ago, repaired by a full walk, does not cost the next deploy its hand-over", async () => {
  const { proc } = world("ovf");
  const A = proc("A");
  await up(A);
  await A.store.scan("/", undefined, true);
  A.helper.stdout.write("!overflow\n");
  await sleep(50);
  await A.store.scan("/", undefined, true); // re-read everything since
  await sleep(5);
  assert.ok(await A.store.freshTree("/", 0, false), "A repaired and vouches");
  const B = proc("B");
  await up(B);
  await A.w.handover();
  await A.store.close();
  await until(() => B.store.isWriter);
  await until(async () => (await B.store.freshTree("/", 0, false)) !== null, 5000);
  assert.ok(await B.store.freshTree("/", 0, false), "the fast path is back after the deploy without another walk");
});

test("H-lag an event still in the old helper's pipe when the hand-over ends is read before the run is reported clean", async () => {
  const { root, db, proc } = world("lag");
  const A = proc("A");
  await up(A);
  await A.store.scan("/", undefined, true);
  await sleep(5);
  assert.ok(await A.store.freshTree("/", 0, false));
  fs.writeFileSync(path.join(root, "a/x/f"), "1234567890");
  A.helper.lag.push(`x ${root}/a/x\n`); // the kernel has it, the helper has not printed it yet
  await sleep(5);
  const B = proc("B");
  await up(B);
  await A.w.handover(); // asks the helper to catch up and waits for its answer
  await A.store.close();
  assert.equal(rows(db, "SELECT clean FROM watch_sessions ORDER BY id")[0].clean, 1);
  assert.equal(rows(db, "SELECT COUNT(*) n FROM pending")[0].n, 1, "the event reached the store before the run ended");
  await until(() => B.store.isWriter);
  await until(async () => (await B.store.freshTree("/", 0, false)) !== null, 15_000);
  assert.equal((await B.store.freshTree("/", 0, false))?.entries[0]?.bytes, 20);
});

test("H-nosync a helper that cannot sync (an old one) leaves the run unclean", async () => {
  const { db, proc } = world("nosync");
  const A = proc("A");
  await up(A);
  (A.helper as Any).stdin = null;
  const B = proc("B");
  await up(B);
  await A.w.handover();
  await A.store.close();
  assert.equal(rows(db, "SELECT clean FROM watch_sessions ORDER BY id")[0].clean, 0);
});

test("H-taken a folder taken from memory and not applied when the run ends is not reported clean", async () => {
  let gate!: () => void;
  const g = new Promise<void>((r) => (gate = r));
  let ended: boolean | undefined;
  const sink: Any = {
    isWriter: true,
    applyChanged: async () => g,
    markStale() {},
    notePending: async () => false, // the store is unusable: events wait in memory
    takeDue: async () => [],
    noteRan: async () => {},
    markDirty: async () => true,
    sessionStart: async () => 1,
    sessionTick: async () => ({ since: 1, newer: true }),
    sessionEnd: async (_: number, c: boolean) => void (ended = c),
  };
  const mounts = path.join(tmp, "taken-mounts");
  fs.writeFileSync(mounts, "/dev/x / ext4 rw 0 0\n");
  const helper = new Fake();
  const w: Any = new FanWatch(sink, { helper: "fake", root: tmp, procMounts: mounts, spawn: () => helper, settleMs: 1, modifyMs: 1, sessionMs: 10, handoverMs: 50 });
  things.push({ close: () => w.stop() });
  await w.start();
  helper.stdout.write("#ready 1\n");
  await until(() => !!w.session);
  helper.stdout.write(`x ${tmp}/a\n`);
  await until(() => w.taken.size > 0);
  const done = w.handover();
  await sleep(2300); // the drain does not finish: the process would exit with the folder neither applied nor recorded
  gate();
  await done;
  assert.equal(ended, false);
});

test("the shutdown signal starts the hand-over at once, not after the connections drain", async () => {
  const { installShutdown } = await import("../src/shutdown.ts");
  const events: string[] = [];
  const server = { close: (cb: () => void) => setTimeout(() => (events.push("drained"), cb()), 100), closeIdleConnections() {}, closeAllConnections() {} };
  const stop = installShutdown(server as Any, () => void events.push("cleanup"), { onSignal: () => void events.push("signal"), exit: () => {} });
  stop();
  await sleep(250);
  assert.deepEqual(events, ["signal", "drained", "cleanup"]);
});
