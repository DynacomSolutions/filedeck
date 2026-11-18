import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { SizeStore, at, mk, sleep } from "./size-store-support.ts";

// ---- the watcher never queues behind a long walk: one waiting lock must not block every lock asked after it ----

type Held = { held: { path: string; granted: boolean }[] };
const settled = async (p: Promise<unknown>, ms = 100) => Promise.race([p.then(() => true), sleep(ms).then(() => false)]);

test("tryLock is null while an overlapping lock is held or waited for, and holds nothing", async () => {
  const s = mk();
  const a = await s.lock("/a");
  assert.equal(s.tryLock("/a/x"), null, "held");
  assert.equal(s.tryLock("/"), null, "the root overlaps everything");
  const waiter = s.lock("/a/y"); // waits behind /a
  a();
  const w = await waiter; // granted now, held by us
  assert.equal(s.tryLock("/a"), null);
  const mark = s.lockMark();
  assert.equal(s.tryLock("/a/y/z"), null);
  assert.equal((s as unknown as Held).held.length, 1, "a refused try holds nothing");
  assert.equal(s.lockedSince("/a/y/z", mark), true, "but it counts: an answer read without the lock learns a change came");
  assert.equal(s.lockedSince("/b", mark), false);
  w();
  const free = s.tryLock("/b");
  assert.ok(free, "an unrelated path is granted");
  assert.equal(s.tryLock("/b/c"), null);
  free();
  assert.ok(s.tryLock("/b"), "released");
});

test("tryLock is null while an overlapping lock only waits", async () => {
  const s = mk();
  const a = await s.lock("/a");
  const waiting = s.lock("/"); // waits behind /a
  assert.equal(s.tryLock("/b"), null, "a waiter blocks the try as it blocks a lock");
  a();
  (await waiting)();
  assert.ok(s.tryLock("/b"));
});

test("applyChanged with wait false returns false at once when the lock is busy, and a later unrelated lock is granted", async () => {
  fs.mkdirSync(at("nw/a/x"), { recursive: true });
  fs.mkdirSync(at("nw/b"), { recursive: true });
  const s = mk();
  await s.scan("/nw");
  const long = await s.lock("/nw/a"); // a long walk of /nw/a
  // a change of a top-level folder asks for the lock of "/" (its parent): the old code queued here, and every later lock queued behind it
  assert.equal(await s.applyChanged("/nw", undefined, { wait: false }), false);
  assert.equal(await s.applyChanged("/nw/a/x", undefined, { wait: false }), false);
  assert.equal((s as unknown as Held).held.length, 1, "the refused calls hold nothing");
  const later = await Promise.race([s.lock("/nw/b"), sleep(500).then(() => null)]);
  assert.ok(later, "a lock of an unrelated folder is granted at once");
  later();
  // the default still waits
  const waited = s.applyChanged("/nw/a/x");
  assert.equal(await settled(waited), false, "still waiting for the long lock");
  long();
  assert.equal(await waited, true);
  assert.equal(await s.applyChanged("/nw/b", undefined, { wait: false }), true, "free: applied");
});

test("a gone folder whose parent is busy is marked dirty and the call still succeeds", async () => {
  fs.mkdirSync(at("gp/a/x"), { recursive: true });
  const s = new SizeStore(`${at("gp-sizes")}.db`, { root: at("."), ttlMs: 60_000, maxEntries: 1_000_000 });
  await s.scan("/gp");
  fs.rmSync(at("gp/a/x"), { recursive: true });
  // applying "/gp/a/x" takes the lock of "/gp/a", re-reads it; remove "/gp/a" too so that the climb needs the lock of "/gp"
  fs.rmSync(at("gp/a"), { recursive: true });
  const real = s.tryLock.bind(s);
  let n = 0;
  s.tryLock = (v: string) => (n++ === 0 ? real(v) : null); // the first lock is free, the climb finds the next one busy
  const marked: string[][] = [];
  const md = s.markDirty.bind(s);
  s.markDirty = async (ps, also) => (marked.push(ps), md(ps, also));
  assert.equal(await s.applyChanged("/gp/a/x", undefined, { wait: false }), true);
  assert.ok(marked.length === 1, "the busy level above is recorded durably");
  assert.equal((s as unknown as Held).held.length, 0, "the first lock was let go");
});

test("the oldest wait of a lock that is not yet granted", async () => {
  const s = mk();
  assert.equal(s.oldestLockWaitSeconds(), 0);
  const a = await s.lock("/a");
  assert.equal(s.oldestLockWaitSeconds(), 0, "a granted lock does not wait");
  const waiting = s.lock("/a/b");
  await sleep(30);
  assert.ok(s.oldestLockWaitSeconds() > 0, "the waiter counts");
  a();
  (await waiting)();
  assert.equal(s.oldestLockWaitSeconds(), 0);
});

test("the first scan of an unstored tree with a busy lock: a change is retried, and applied once the lock is free", async () => {
  fs.mkdirSync(at("fs/a/x"), { recursive: true });
  const s = mk();
  const walk = await s.lock("/fs"); // a first walk of the tree holds the lock; nothing is stored yet
  assert.equal(await s.applyChanged("/fs/a", undefined, { wait: false }), false, "busy: nothing is recorded by the store, the caller retries");
  fs.mkdirSync(at("fs/a/y"));
  walk();
  assert.equal(await s.applyChanged("/fs/a", undefined, { wait: false }), true, "the retry finds the lock free");
  assert.equal((await s.scan("/fs")).dirs, 3, "a, x, y");
});

test("a scan of a missing top-level folder never queues a lock for the root: an unrelated lock is granted at once", async () => {
  fs.mkdirSync(at("big/deep"), { recursive: true });
  const s = mk();
  const big = await s.lock("/big"); // a long walk
  await assert.rejects(s.scanRead("/gone-top"), /ENOENT|no such/i);
  await sleep(20); // the trim after the failure runs behind
  const boot = await Promise.race([s.lock("/boot"), sleep(500).then(() => null)]);
  assert.ok(boot, "no waiter for '/' is queued");
  boot();
  big();
});
