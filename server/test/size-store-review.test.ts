// Regression tests for the ways the "never serve a changed folder as fresh" invariant was found to break (second review of the validated/dirty design).
// Each test asserts the invariant: the fast path answers either null or the true size.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SizeStore } from "../src/size-store.ts";

type Any = any; // the tests reach into private state on purpose
let tmp: string;
const stores: SizeStore[] = [];
const realNow = Date.now;
before(() => void (tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "filedeck-review-")))));
after(async () => {
  Date.now = realNow;
  for (const s of stores) await s.close().catch(() => {});
  fs.rmSync(tmp, { recursive: true, force: true });
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function fixture(name: string, o: Record<string, unknown> = {}) {
  const root = path.join(tmp, name);
  for (const d of ["a/x", "a/y", "b/z"]) fs.mkdirSync(path.join(root, d), { recursive: true });
  for (const f of ["a/x/f", "a/y/f", "b/z/f"]) fs.writeFileSync(path.join(root, f), "12345");
  const db = path.join(tmp, `${name}.db`);
  const s = new SizeStore(db, { root, ttlMs: 3_600_000, maxEntries: 100_000, ...o });
  stores.push(s);
  return { root, s, db };
}
const open = (db: string, root: string, o: Record<string, unknown> = {}) => {
  const s = new SizeStore(db, { root, ttlMs: 3_600_000, maxEntries: 1000, ...o });
  stores.push(s);
  return s;
};
const arm = (s: SizeStore, ready: number) => {
  const a = s as Any;
  a.covers = () => true;
  a.quiet = () => true;
  a.watchedSince = () => ready;
};
/** watcher ready now, then a fresh (validating) walk */
async function validate(s: SizeStore, p = "/", ready = Date.now()) {
  arm(s, ready);
  await sleep(5);
  await s.scan(p, undefined, true);
  return ready;
}
const bytes = (t: { entries: { bytes: number }[] } | null) => t?.entries?.[0]?.bytes ?? null;
const rows = (db: string, sql: string) => {
  const d = new DatabaseSync(db, { readOnly: true });
  try {
    return d.prepare(sql).all() as Any[];
  } finally {
    d.close();
  }
};
function hold(s: SizeStore, pick: (m: Any) => boolean) {
  const a = s as Any;
  const orig = a.send.bind(s);
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let held = false;
  a.send = async (m: Any) => {
    if (m.op === "commit" && pick(m)) {
      held = true;
      await gate;
    }
    return orig(m);
  };
  return { release, held: () => held };
}
const T = { modifyMs: 100_000, settleMs: 1 };
const dueNow = (p: string) => ({ path: p, dueAt: realNow() - 10, modify: false });

test("N1 a store outage drops changes: after the store is back, nothing validated before it is served", async () => {
  const { root, s } = fixture("n1");
  await s.scan("/");
  await validate(s);
  assert.equal(bytes(await s.freshTree("/", 0, false)), 15);
  const a = s as Any;
  const quiet = console.error;
  console.error = () => undefined;
  try {
    a.giveUp(new Error("disk I/O error (simulated)"));
    fs.writeFileSync(path.join(root, "a/x/f"), "1234567890"); // in place: no folder mtime change
    await s.applyChanged("/a/x"); // applied to nothing: the store is down
    s.markStale("/"); // an overflow during the outage: dropped
    a.retryAt = 1;
    await a.reopen();
  } finally {
    console.error = quiet;
  }
  assert.equal(s.persistent, true);
  const t = await s.freshTree("/", 0, false);
  assert.ok(t === null || bytes(t) === 20, `served ${bytes(t)}`);
  assert.equal((await s.scanRead("/")).res.bytes, 20, "and the tree is re-read once the store is back");
});

test("N2 a mark persisted ahead of the clock does not hide a later overflow mark", async () => {
  const { root, s } = fixture("n2");
  await s.scan("/");
  Date.now = () => realNow() + 86_400_000;
  s.markStale("/a");
  await sleep(20);
  Date.now = realNow;
  await validate(s); // spends the future mark; validated.started is past it
  fs.writeFileSync(path.join(root, "a/x/f"), "1234567890");
  s.markStale("/"); // an overflow now, in real time
  await sleep(20);
  const t = await s.freshTree("/", 0, false);
  assert.ok(t === null || bytes(t) === 20, `served ${bytes(t)}`);
  assert.equal((await s.scanRead("/")).res.bytes, 20);
});

test("N3 a dirty mark made again (same millisecond, or the clock stepped back) is not deleted by a walk that saw the first", async () => {
  const { root, s, db } = fixture("n3");
  await s.scan("/");
  await validate(s);
  const t1 = realNow();
  Date.now = () => t1;
  assert.ok(await s.markDirty(["/a/x"]));
  Date.now = realNow;
  const h = hold(s, (m) => m.last);
  const w = s.scan("/"); // sees the dirty mark of /a/x, held before its last commit
  while (!h.held()) await sleep(5);
  fs.writeFileSync(path.join(root, "a/x/f"), "1234567890"); // after the walk read /a/x
  Date.now = () => t1 - 5_000;
  assert.ok(await s.markDirty(["/a/x"]));
  Date.now = realNow;
  h.release();
  await w;
  assert.equal(rows(db, "SELECT COUNT(*) n FROM dirty")[0].n, 1, "the newer mark is still there");
  const t = await s.freshTree("/", 0, false);
  assert.ok(t === null || bytes(t) === 20, `served ${bytes(t)}`);
});

test("N3b a stale mark made again, in the same millisecond or after a clock step back, is later than the first", async () => {
  const { s, db } = fixture("n3b");
  await s.scan("/");
  const t1 = realNow() + 1_000_000;
  Date.now = () => t1;
  s.markStale("/a");
  const first = (s as Any).marks.get("/a");
  Date.now = () => t1 - 5_000;
  s.markStale("/a");
  Date.now = realNow;
  const second = (s as Any).marks.get("/a");
  assert.ok(second > first, `${second} after ${first}`);
  await s.scan("/b"); // after the writes
  assert.equal(rows(db, "SELECT at FROM stale_trees WHERE path = '/a'")[0].at, second, "memory and file agree");
});

test("N4 a take that is never applied (the process died) keeps blocking other processes, then becomes a dirty mark", async () => {
  const { root, s: A, db } = fixture("n4");
  await A.scan("/");
  const ready = await validate(A);
  const B = open(db, root);
  arm(B, ready);
  fs.writeFileSync(path.join(root, "a/x/f"), "1234567890");
  await A.notePending([dueNow("/a/x")], 100_000);
  assert.equal(await A.freshTree("/", 0, false), null, "pending blocks");
  assert.deepEqual(await B.takeDue(realNow(), 10, T), ["/a/x"]);
  assert.equal(await A.freshTree("/", 0, false), null, "taken by B and being applied");
  await B.close(); // terminated mid-batch: never applied, never reported ended
  assert.equal(await A.freshTree("/", 0, false), null, "still blocked after B died");
  // a survivor converts a take older than the limit into a dirty mark (and the folder is re-read by the next walk)
  rows(db, "SELECT 1");
  const d = new DatabaseSync(db);
  d.exec("PRAGMA busy_timeout=2000");
  d.exec(`UPDATE pending SET taker = ${realNow() - 11 * 60_000}`);
  d.close();
  (A as Any).lastPrune = 0;
  await A.takeDue(realNow(), 10, T);
  assert.deepEqual(rows(db, "SELECT path FROM dirty").map((r) => r.path), ["/a/x"]);
  assert.equal(rows(db, "SELECT COUNT(*) n FROM pending WHERE taker IS NOT NULL")[0].n, 0);
  assert.equal(await A.freshTree("/", 0, false), null, "the dirty mark blocks until a walk re-reads it");
  assert.equal((await A.scanRead("/")).res.bytes, 20);
});

test("N4b a take is cleared by noteRan, and the take survives the prune", async () => {
  const { s, db } = fixture("n4b");
  await s.scan("/");
  await s.notePending([dueNow("/a/x")], 100);
  assert.deepEqual(await s.takeDue(realNow(), 10, { modifyMs: 100, settleMs: 1 }), ["/a/x"]);
  assert.ok(rows(db, "SELECT taker FROM pending")[0].taker > 0);
  await sleep(150);
  (s as Any).lastPrune = 0;
  await s.takeDue(realNow(), 10, { modifyMs: 100, settleMs: 1 }); // prune: a row older than modifyMs, but taken and not ended, stays
  assert.equal(rows(db, "SELECT COUNT(*) n FROM pending")[0].n, 1);
  await s.noteRan([{ path: "/a/x", endedAt: realNow(), hold: false }], 100);
  assert.equal(rows(db, "SELECT taker FROM pending")[0].taker, null);
});

test("N5 a walk that overwrote a change another process applied during it does not validate, and marks the folder dirty", async () => {
  const { root, s: A, db } = fixture("n5");
  await A.scan("/");
  const ready = await validate(A);
  const B = open(db, root);
  arm(B, ready);
  const h = hold(A, (m) => m.last);
  const w = A.scan("/"); // has read everything, held at its last commit
  while (!h.held()) await sleep(5);
  fs.writeFileSync(path.join(root, "a/x/f"), "1234567890");
  await B.notePending([dueNow("/a/x")], 100_000);
  const got = (await B.takeDue(realNow(), 10, T))!;
  for (const p of got) await B.applyChanged(p);
  await B.noteRan(got.map((p) => ({ path: p, endedAt: realNow(), hold: true })), 100_000);
  h.release();
  await w;
  assert.deepEqual(rows(db, "SELECT path FROM dirty").map((r) => r.path), ["/a/x"]);
  const t = await A.freshTree("/", 0, false);
  assert.ok(t === null || bytes(t) === 20, `served ${bytes(t)}`);
  assert.equal((await A.scanRead("/")).res.bytes, 20);
  assert.equal(rows(db, "SELECT COUNT(*) n FROM dirty")[0].n, 0, "re-read, so clean again");
});

test("N6 a process of an older version that drops the shared pending rows and zeroes scanned_at is not believed", async () => {
  const { root, s: A, db } = fixture("n6");
  await A.scan("/");
  await validate(A);
  fs.writeFileSync(path.join(root, "a/x/f"), "1234567890");
  await A.notePending([{ path: "/a/x", dueAt: realNow() + 1000, modify: false }], 100_000);
  assert.equal(await A.freshTree("/", 0, false), null);
  // what the previous version's overflow does: clearPending, then markStale = UPDATE sizes SET scanned_at = 0
  const d = new DatabaseSync(db);
  d.exec("PRAGMA busy_timeout=2000");
  d.exec("DELETE FROM pending");
  d.exec("UPDATE sizes SET scanned_at = 0");
  d.close();
  assert.deepEqual(rows(db, "SELECT path FROM dirty").map((r) => r.path), ["/a/x"], "the trigger recorded the dropped row");
  assert.equal(await A.freshTree("/", 0, false), null);
  // (a) alone: zeroed rows are refused even without the trigger's dirty mark
  const d2 = new DatabaseSync(db);
  d2.exec("DELETE FROM dirty");
  d2.close();
  assert.equal(await A.freshTree("/", 0, false), null, "scanned_at = 0 on the folder");
  assert.equal(await A.freshTree("/a/y", 0, false), null, "and on a folder above");
  assert.equal((await A.scanRead("/")).res.bytes, 20);
});

test("N6b a take by a process of an older version (no taker) leaves a dirty mark; a take by this version does not", async () => {
  const { s, db } = fixture("n6b");
  await s.scan("/");
  await s.notePending([dueNow("/a/x"), dueNow("/b/z")], 100_000);
  const d = new DatabaseSync(db);
  d.exec("PRAGMA busy_timeout=2000");
  d.exec(`UPDATE pending SET last_run = ${realNow()}, due_at = 9007199254740991 WHERE path = '/a/x'`); // the old version's UPDATE
  d.close();
  assert.deepEqual(rows(db, "SELECT path FROM dirty").map((r) => r.path), ["/a/x"]);
  assert.deepEqual(await s.takeDue(realNow(), 10, T), ["/b/z"]);
  assert.deepEqual(rows(db, "SELECT path FROM dirty").map((r) => r.path), ["/a/x"], "this version's take records itself as the taker");
});

test("N7 a validated ancestor does not vouch for a row of another device below it (a mount the walk never entered)", async () => {
  const { s, db } = fixture("n7");
  await s.scan("/");
  const d = new DatabaseSync(db);
  d.prepare("INSERT INTO sizes (path,parent,ino,dev,mtime_ms,scanned_at,seen_at,own_bytes,own_disk,own_files,own_symlinks,own_other,own_dirs,own_mounts,own_errors,tot_bytes,tot_disk,tot_files,tot_symlinks,tot_other,tot_dirs,tot_mounts,tot_errors) VALUES ('/a/mnt','/a',1,999,1,?,1,7,7,1,0,0,0,0,0,7,7,1,0,0,0,0,0)").run(realNow() - 10 * 3_600_000);
  d.close();
  await validate(s);
  assert.equal(await s.freshTree("/a/mnt", 0, false), null);
  assert.ok(await s.freshTree("/a", 0, false), "the real folders are still answered");
});

test("N8 right after a restart one plain walk is enough to validate (11.79 does not wait out the TTL)", async () => {
  const { root, s, db } = fixture("n8");
  await s.scan("/");
  await s.close();
  const s2 = open(db, root);
  arm(s2, realNow());
  await sleep(5);
  assert.equal(await s2.freshTree("/", 0, false), null, "nothing validated yet");
  const r1 = await s2.scanRead("/");
  assert.ok(r1.read > 0, "rows older than the watcher are re-read, not reused on their age");
  assert.equal(bytes(await s2.freshTree("/", 0, false)), 15);
  assert.equal((await s2.scanRead("/")).read, 0, "the second walk reuses what the first wrote");
});

test("M2 after a restart with a short TTL the answer is the same: one plain walk validates", async () => {
  const { root, s, db } = fixture("m2", { ttlMs: 300 });
  await s.scan("/");
  await s.close();
  const s2 = open(db, root, { ttlMs: 300 });
  arm(s2, realNow());
  await sleep(5);
  await s2.scanRead("/");
  assert.equal(bytes(await s2.freshTree("/", 0, false)), 15);
});

test("N9 a dirty row left for a folder that is gone does not block its ancestors", async () => {
  const { root, s, db } = fixture("n9");
  await s.scan("/");
  await validate(s);
  await s.markDirty(["/a/x"]);
  fs.rmSync(path.join(root, "a/x"), { recursive: true });
  const d = new DatabaseSync(db);
  d.exec("PRAGMA busy_timeout=2000");
  d.exec("DELETE FROM sizes WHERE path = '/a/x' OR path LIKE '/a/x/%'"); // an older version's purge touches sizes only
  d.close();
  await s.scan("/", undefined, true);
  await s.scan("/");
  assert.equal(rows(db, "SELECT COUNT(*) n FROM dirty")[0].n, 0);
  assert.ok(await s.freshTree("/", 0, false));
});

test("N9b dirty rows without a stored folder are swept when the store is opened", async () => {
  const { root, s, db } = fixture("n9b");
  await s.scan("/");
  await s.close();
  const d = new DatabaseSync(db);
  d.prepare("INSERT INTO dirty (path, at) VALUES ('/gone', 1), ('/a/x', 1)").run();
  d.close();
  const s2 = open(db, root);
  await s2.scan("/b");
  for (let i = 0; i < 100 && rows(db, "SELECT COUNT(*) n FROM dirty")[0].n > 1; i++) await sleep(20);
  assert.deepEqual(rows(db, "SELECT path FROM dirty").map((r) => r.path), ["/a/x"]);
});

test("N10 a folder validated alone and then replaced by a rename (the event is on its unstored parent) is not served", async () => {
  const { root, s, db } = fixture("n10");
  await validate(s, "/a/x");
  assert.equal(bytes(await s.freshTree("/a/x", 0, false)), 5);
  fs.mkdirSync(path.join(root, "a/x.new"));
  fs.writeFileSync(path.join(root, "a/x.new/big"), "z".repeat(1000));
  fs.renameSync(path.join(root, "a/x"), path.join(root, "a/x.old"));
  fs.renameSync(path.join(root, "a/x.new"), path.join(root, "a/x"));
  assert.equal(await s.freshTree("/a/x", 0, false), null, "even before any event: the folder is not the one stored");
  await s.notePending([dueNow("/a")], 100_000);
  const got = (await s.takeDue(realNow(), 10, T))!;
  for (const p of got) await s.applyChanged(p);
  await s.noteRan(got.map((p) => ({ path: p, endedAt: realNow(), hold: true })), 100_000);
  assert.deepEqual(rows(db, "SELECT path FROM stale_trees").map((r) => r.path), ["/a"], "the unstored parent with stored rows below it is marked");
  const t = await s.freshTree("/a/x", 0, false);
  assert.ok(t === null || bytes(t) === 1000, `served ${bytes(t)}`);
});

test("M1 a later walk does not repair a pending row another process dropped (the change is in place): the dropped row is dirty", async () => {
  const { root, s: A, db } = fixture("m1");
  await A.scan("/");
  await validate(A);
  fs.writeFileSync(path.join(root, "a/x/f"), "1234567890");
  await A.notePending([{ path: "/a/x", dueAt: realNow() + 1000, modify: false }], 100_000);
  const d = new DatabaseSync(db);
  d.exec("PRAGMA busy_timeout=2000");
  d.exec("DELETE FROM pending"); // a foreign clearPending
  d.close();
  const w = await A.scanRead("/");
  assert.equal(w.res.bytes, 20, "the dirty folder is re-read by the walk");
  const t = await A.freshTree("/", 0, false);
  assert.ok(t === null || bytes(t) === 20);
});

test("perf: the live-pending lookup does not scan the idle pending rows", async () => {
  const { s, db } = fixture("perf");
  await s.scan("/");
  await s.close();
  const d = new DatabaseSync(db);
  d.exec("PRAGMA synchronous=OFF; BEGIN");
  const ins = d.prepare("INSERT INTO pending (path, due_at, last_run) VALUES (?, 9007199254740991, ?)");
  for (let i = 0; i < 400_000; i++) ins.run(`/w/t${i % 50}/d${i}`, 1);
  d.exec("COMMIT");
  d.close();
  const s2 = open(db, path.join(tmp, "perf"));
  arm(s2, realNow());
  await s2.scanRead("/");
  for (let i = 0; i < 200 && !rows(db, "SELECT name FROM sqlite_master WHERE name = 'pending_live'").length; i++) await sleep(50);
  assert.ok(rows(db, "SELECT name FROM sqlite_master WHERE name = 'pending_live'").length, "the partial index was built in the background");
  const t0 = performance.now();
  const t = await s2.freshTree("/", 0, false);
  const ms = performance.now() - t0;
  console.log(`# freshTree / with 400k idle pending rows: ${ms.toFixed(1)} ms`);
  assert.equal(bytes(t), 15);
  assert.ok(ms < 40, `took ${ms} ms`);
});
