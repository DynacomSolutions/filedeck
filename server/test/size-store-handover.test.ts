// A rolling deploy: the new process starts its watcher while the old one still runs, and takes the store's writer lease when the old one lets go.
import { test as nodeTest, before, after } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { FanWatch, type HelperProc } from "../src/fanwatch.ts";
import { SizeStore } from "../src/size-store.ts";

/** every test here starts agents, helpers and workers: a leak must fail the test, not hang the runner */
const test = ((name: string, fn: (t: never) => unknown) => nodeTest(name, { timeout: 120_000 }, fn as never)) as typeof nodeTest;

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
  for (const t of things) await Promise.race([Promise.resolve(t.close()).catch(() => undefined), new Promise((r) => setTimeout(r, 15_000))]);
  fs.rmSync(tmp, { recursive: true, force: true });
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (f: () => boolean | Promise<boolean>, ms = 60_000) => {
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

/** Long enough that a holder whose heartbeat a loaded host delays by seconds is not taken over by the next process mid-test. A test that needs a lapse makes one with `expireLease`. */
const LEASE_MS = 3000;
/** The holder stopped beating: age its heartbeat in the file (repeated while waiting, as a beat already in flight can still land), so the next process takes the lease at its next attempt, without waiting for a real lapse. */
const expireLease = (db: string) => {
  const d = new DatabaseSync(db);
  try {
    d.exec("PRAGMA busy_timeout = 10000");
    d.exec("UPDATE writer SET beat = 0 WHERE id = 1");
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
    const store = new SizeStore(db, { root, ttlMs: 3_600_000, maxEntries: 100_000, leaseMs: LEASE_MS });
    const helper = new Fake();
    const w = new FanWatch(store, { helper: "fake", root, procMounts: mounts, spawn: () => helper, settleMs: 5, modifyMs: 300, sessionMs: 50, handoverMs: 3000 });
    store.covers = (v) => w.covers(v);
    store.watchedSince = () => w.watchedSince();
    store.quiet = (v) => w.settled(v);
    store.chainMin = () => w.chainMin();
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
  await until(async () => (await B.store.freshTree("/", 0, false)) !== null, 60_000);
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
  await until(async () => (await B.store.freshTree("/", 0, false)) !== null, 60_000);
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
  await until(async () => (await B.store.freshTree("/", 0, false)) !== null, 60_000);
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
  // the drain does not finish (its apply waits on `gate`): the process would exit with the folder neither applied nor recorded. The hand-over's own bounded wait for the
  // drain ends the run; releasing the gate only afterwards keeps this independent of how long that wait takes on a loaded host.
  await done;
  gate();
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

/** the process dies without releasing the lease: its beats stop, and (as after a real lapse) the file's heartbeat is old */
const kill = (p: Proc, db: string) => {
  clearInterval((p.store as Any).leaseTimer);
  (p.store as Any).tryLease = async () => {};
  p.w.stop();
  expireLease(db);
};
const bytes = (t: Any) => t?.entries?.[0]?.bytes ?? null;

test("V1 a crash in the overlap: a walk of the old process begun after the new one was ready reused a row whose change never reached the store; the new one does not vouch for it", async () => {
  const { root, db, proc } = world("v1");
  const A = proc("A");
  await up(A);
  await A.store.scan("/", undefined, true);
  await sleep(5);
  assert.ok(await A.store.freshTree("/", 0, false));
  fs.writeFileSync(path.join(root, "a/x/f"), "1234567890"); // in place; the event is still in A's kernel queue or pipe, not in the store
  await sleep(5);
  const B = proc("B");
  await up(B); // B's marks come after the change: it never sees it
  await sleep(10);
  const r = await A.store.scanRead("/"); // a plain du on A in the overlap: rows reused under A's trust, the walk vouches
  assert.equal(r.untrusted, false);
  assert.ok(rows(db, "SELECT started FROM validated")[0].started > B.w.watchedSince() - 1);
  kill(A, db); // SIGKILL, OOM, the hard exit: no session end
  await until(() => (expireLease(db), B.store.isWriter && (B.store as Any).idxReady));
  await sleep(200);
  assert.equal((B.w.chainMin() !== null), false);
  const t = await B.store.freshTree("/a/x", 0, false);
  assert.ok(t === null || bytes(t) === 10, `served ${bytes(t)} as fresh`);
});

test("V1b the same without a crash: the old helper's sync times out, the run ends unclean, its overlap validation does not count", async () => {
  const { root, db, proc } = world("v1b");
  const A = proc("A");
  await up(A);
  (A.helper as Any).stdin = { write: () => true }; // never answers: no #sync within the time allowed
  await A.store.scan("/", undefined, true);
  await sleep(5);
  fs.writeFileSync(path.join(root, "a/x/f"), "1234567890");
  await sleep(5);
  const B = proc("B");
  await up(B);
  await sleep(10);
  await A.store.scanRead("/");
  await A.w.handover();
  await A.store.close();
  assert.equal(rows(db, "SELECT clean FROM watch_sessions ORDER BY id")[0].clean, 0);
  await until(() => B.store.isWriter && (B.store as Any).idxReady);
  await sleep(200);
  const t = await B.store.freshTree("/a/x", 0, false);
  assert.ok(t === null || bytes(t) === 10, `served ${bytes(t)} as fresh`);
});

test("V1c a clean hand-over keeps the old process's validation, a rescan of the new one makes its own", async () => {
  const { db, proc } = world("v1c");
  const A = proc("A");
  await up(A);
  await A.store.scan("/", undefined, true);
  await sleep(5);
  const B = proc("B");
  await up(B);
  await A.w.handover();
  await A.store.close();
  await until(() => B.store.isWriter && (B.w.chainMin() !== null));
  await until(async () => (await B.store.freshTree("/", 0, false)) !== null, 60_000);
  assert.ok(await B.store.freshTree("/", 0, false), "carried: epoch 1's validation counts");
  assert.equal(rows(db, "SELECT epoch FROM validated")[0].epoch, 1);
});

test("V2 a walk begun under one lease is fenced once the next exists", async () => {
  const { root, db, proc } = world("v2");
  const A = proc("A");
  (A.store as Any).o.commitChunk = 1;
  await up(A);
  await A.store.scan("/", undefined, true);
  await sleep(5);
  const send = (A.store as Any).send.bind(A.store);
  let gate!: () => void;
  const g = new Promise<void>((r) => (gate = r));
  let held = false;
  (A.store as Any).send = async (m: Any) => {
    if (m.op === "commit" && !held) {
      held = true;
      await g;
    }
    return send(m);
  };
  const w = A.store.scanRead("/", undefined, true).then(() => "ended", (e: Any) => String(e.message));
  await until(() => held);
  clearInterval((A.store as Any).leaseTimer);
  (A.store as Any).tryLease = async () => {}; // A stalls: no more beats
  expireLease(db);
  const B = proc("B");
  await until(() => (expireLease(db), B.store.isWriter));
  fs.writeFileSync(path.join(root, "a/y/f"), "1234567890");
  gate();
  assert.match(await w, /lease/);
  assert.equal(rows(db, "SELECT COUNT(*) n FROM sizes WHERE ver = 1 AND path = '/a/y' AND tot_bytes = 10")[0].n, 0);
});

test("V3 a writer that lost the lease and got it back under a stalled walk does not vouch for what that walk read", async () => {
  const { root, db, proc } = world("v3");
  const A = proc("A");
  (A.store as Any).o.commitChunk = 1;
  await up(A);
  await A.store.scan("/", undefined, true);
  await sleep(5);
  const send = (A.store as Any).send.bind(A.store);
  let gate!: () => void;
  const g = new Promise<void>((r) => (gate = r));
  let held = false;
  (A.store as Any).send = async (m: Any) => {
    if (m.op === "commit" && !held) {
      held = true;
      await g;
    }
    return send(m);
  };
  const tl = (A.store as Any).tryLease.bind(A.store);
  const w = A.store.scan("/", undefined, true).then(() => "ended", (e: Any) => String(e.message));
  await until(() => held);
  (A.store as Any).tryLease = async () => {};
  expireLease(db);
  const B = proc("B");
  await until(() => (expireLease(db), B.store.isWriter));
  await sleep(50);
  fs.writeFileSync(path.join(root, "a/y/f"), "1234567890");
  A.event("/a/y");
  await sleep(50);
  await B.store.close();
  (A.store as Any).epoch = 0;
  (A.store as Any).idxReady = false;
  (A.store as Any).tryLease = tl;
  await until(() => A.store.isWriter && (A.store as Any).idxReady);
  gate();
  await w;
  await sleep(400);
  const t = await A.store.freshTree("/a", 1, false);
  assert.ok(t === null || bytes(t) === 15, `served ${bytes(t)}`);
});

test("S5 a store outage in the life of a process does not end its watcher run unclean: the hand-over carries the floor", async () => {
  const { db, proc } = world("s5");
  const A = proc("A");
  await up(A);
  const s = A.store as Any;
  const id = (A.w as Any).session.id;
  s.floor = Date.now();
  await A.store.sessionEnd(id, true, 0);
  const r = rows(db, "SELECT clean, since FROM watch_sessions WHERE id = " + id)[0];
  assert.equal(r.clean, 1);
  assert.equal(r.since, s.floor);
});

test("E1 a helper whose stdin is gone: the hand-over does not crash, the run is unclean, and the lease is released", async () => {
  const { db, proc } = world("e1");
  const A = proc("A");
  await up(A);
  const EPIPE = Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
  const listeners: (() => void)[] = [];
  (A.helper as Any).stdin = {
    on: (_: string, f: () => void) => void listeners.push(f),
    removeListener: () => undefined,
    write: () => {
      setImmediate(() => listeners.forEach((f) => f())); // the error event arrives, as a socket's does
      void EPIPE;
      return true;
    },
  };
  const B = proc("B");
  await up(B);
  await A.w.handover();
  await A.store.releaseLease();
  assert.equal(rows(db, "SELECT clean FROM watch_sessions ORDER BY id")[0].clean, 0);
});

test("E2 a real helper process that closed its stdin: writing the sync request is not an unhandled error", async () => {
  const dir = path.join(tmp, "e2");
  fs.mkdirSync(dir, { recursive: true });
  const h = path.join(dir, "h.sh");
  fs.writeFileSync(h, "#!/bin/sh\nexec 0<&-\necho '#ready 1'\nexec sleep 30\n", { mode: 0o755 });
  const m = path.join(dir, "mounts");
  fs.writeFileSync(m, "/dev/x / ext4 rw 0 0\n");
  const ends: boolean[] = [];
  const sink: Any = { isWriter: true, applyChanged: async () => {}, markStale() {}, notePending: async () => true, takeDue: async () => [], noteRan: async () => {}, markDirty: async () => true, sessionStart: async () => 1, sessionTick: async () => ({ since: 1, newer: true, minEpoch: null }), sessionEnd: async (_: number, c: boolean) => void ends.push(c) };
  const w: Any = new FanWatch(sink, { helper: h, root: "/tmp", procMounts: m, settleMs: 1, modifyMs: 1, sessionMs: 10 });
  const errors: unknown[] = [];
  const onUncaught = (e: unknown) => void errors.push(e);
  process.on("uncaughtException", onUncaught);
  try {
    await w.start();
    await until(() => !!w.session);
    await sleep(100);
    await w.handover();
    await sleep(300);
  } finally {
    process.off("uncaughtException", onUncaught);
  }
  assert.deepEqual(errors, []);
  assert.deepEqual(ends, [false]);
});

/** A writes then crashes in the overlap with B, so B refuses A's validation; the event died with A */
async function crashInOverlap(name: string) {
  const { root, db, proc } = world(name);
  const A = proc("A");
  await up(A);
  await A.store.scan("/", undefined, true);
  await sleep(5);
  fs.writeFileSync(path.join(root, "a/x/f"), "1234567890");
  await sleep(5);
  const B = proc("B");
  await up(B);
  await sleep(10);
  await A.store.scanRead("/");
  kill(A, db);
  await until(() => (expireLease(db), B.store.isWriter && (B.store as Any).idxReady));
  await sleep(200);
  return { root, db, proc, B };
}

test("C1 A unclean, B clean, C: the validation B refused is not counted again by C", async () => {
  const { proc, B } = await crashInOverlap("c1");
  assert.equal(B.w.chainMin(), null);
  assert.equal(await B.store.freshTree("/a/x", 0, false), null, "control: B refuses it");
  const C = proc("C");
  await up(C);
  await B.w.handover();
  await B.store.close();
  await until(() => C.store.isWriter && (C.store as Any).idxReady && C.w.chainMin() !== null);
  await sleep(200);
  assert.notEqual(C.w.chainMin(), null, "C carries B's time");
  const t = await C.store.freshTree("/a/x", 0, false);
  assert.ok(t === null || bytes(t) === 10, `served ${bytes(t)} as fresh`);
});

test("C2 A clean, B unclean, C: C does not carry", async () => {
  const { root, db, proc } = world("c2");
  const A = proc("A");
  await up(A);
  await A.store.scan("/", undefined, true);
  await sleep(5);
  const B = proc("B");
  await up(B);
  await A.w.handover();
  await A.store.close();
  await until(() => B.store.isWriter && (B.store as Any).idxReady && B.w.chainMin() !== null);
  await until(async () => (await B.store.freshTree("/", 0, false)) !== null, 60_000);
  assert.ok(await B.store.freshTree("/", 0, false), "control: B carried");
  fs.writeFileSync(path.join(root, "a/x/f"), "1234567890");
  await sleep(5);
  const C = proc("C");
  await up(C);
  await sleep(10);
  await B.store.scanRead("/");
  kill(B, db);
  await until(() => (expireLease(db), C.store.isWriter && (C.store as Any).idxReady));
  await sleep(200);
  assert.equal(C.w.chainMin(), null);
  const t = await C.store.freshTree("/a/x", 0, false);
  assert.ok(t === null || bytes(t) === 10, `served ${bytes(t)} as fresh`);
});

test("C3 a carried run that overflows: the carried validation stops counting", async () => {
  const { proc } = world("c3");
  const A = proc("A");
  await up(A);
  await A.store.scan("/", undefined, true);
  await sleep(5);
  const B = proc("B");
  await up(B);
  await A.w.handover();
  await A.store.close();
  await until(() => B.store.isWriter && (B.store as Any).idxReady && B.w.chainMin() !== null);
  await until(async () => (await B.store.freshTree("/", 0, false)) !== null, 60_000);
  B.helper.stdout.write("!overflow\n");
  await sleep(300);
  assert.equal(await B.store.freshTree("/", 0, false), null);
});

test("C4 liveness: after a crash the first rescan brings the fast path back, on a new lease and without a chain", async () => {
  const { B } = await crashInOverlap("c4");
  assert.equal(await B.store.freshTree("/", 0, false), null);
  await B.store.scan("/", undefined, true);
  await sleep(5);
  const t = await B.store.freshTree("/", 0, false);
  assert.ok(t, "fast path back");
  assert.equal(bytes(t), 20);
});

test("C5 a carried run that loses and regains the lease (no other holder wrote) still answers from the fast path", async () => {
  const { proc } = world("c5");
  const A = proc("A");
  await up(A);
  await A.store.scan("/", undefined, true);
  await sleep(5);
  const B = proc("B");
  await up(B);
  await A.w.handover();
  await A.store.close();
  await until(() => B.store.isWriter && (B.store as Any).idxReady && B.w.chainMin() !== null);
  await until(async () => (await B.store.freshTree("/", 0, false)) !== null, 60_000);
  (B.store as Any).loseLease();
  await until(() => B.store.isWriter && (B.store as Any).idxReady);
  await sleep(100);
  assert.ok(await B.store.freshTree("/", 0, false));
});
