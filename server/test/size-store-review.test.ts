// Regression tests for the ways the "never serve a changed folder as fresh" invariant was found to break (second review of the validated/dirty design).
// Each test asserts the invariant: the fast path answers either null or the true size.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SizeStore } from "../src/size-store.ts";
import { createAgent } from "../src/agent.ts";
import { loadConfig } from "../src/config.ts";

type Any = any; // the tests reach into private state on purpose
let tmp: string;
const stores: SizeStore[] = [];
const agents: { close(): Promise<void> }[] = [];
const realNow = Date.now;
before(() => void (tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "filedeck-review-")))));
after(async () => {
  Date.now = realNow;
  for (const a of agents) await a.close().catch(() => {});
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
/** the process stops without a word: no heartbeat, no release (SIGKILL, or paused past its lease) */
function crash(s: SizeStore) {
  clearInterval((s as Any).leaseTimer);
}
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

test("N4 what a dead writer left half done is recorded when the next one takes the lease: takes become dirty, walks become marks", async () => {
  const { root, s: A, db } = fixture("n4", { leaseMs: 300 });
  await A.scan("/");
  await validate(A);
  fs.writeFileSync(path.join(root, "a/x/f"), "1234567890");
  await A.notePending([dueNow("/a/x")], 100_000);
  assert.deepEqual(await A.takeDue(realNow(), 10, T), ["/a/x"]); // taken, never reported ended
  assert.ok(rows(db, "SELECT taker FROM pending")[0].taker > 0);
  (A as Any).o.commitChunk = 1;
  const h = hold(A, (m) => m.last);
  void A.scan("/", undefined, true).catch(() => undefined); // a walk whose first chunk is committed and whose root is not
  while (!h.held()) await sleep(5);
  await sleep(30);
  assert.equal(rows(db, "SELECT COUNT(*) n FROM walking")[0].n, 1);
  crash(A); // no release, no more heartbeats
  const B = open(db, root, { leaseMs: 300 });
  for (let i = 0; i < 200 && !B.isWriter; i++) await sleep(20);
  assert.ok(B.isWriter, "the lease lapsed and B took it");
  for (let i = 0; i < 100 && !rows(db, "SELECT 1 FROM dirty").length; i++) await sleep(20); // (an acquire that met a busy file tries again on the next beat)
  assert.deepEqual(rows(db, "SELECT path FROM dirty").map((r) => r.path), ["/a/x"], "the take of the dead writer");
  assert.deepEqual(rows(db, "SELECT path FROM stale_trees").map((r) => r.path), ["/"], "its walk");
  assert.equal(rows(db, "SELECT COUNT(*) n FROM walking")[0].n, 0);
  assert.equal(rows(db, "SELECT COUNT(*) n FROM pending WHERE taker IS NOT NULL")[0].n, 0);
  arm(B, realNow() - 1000);
  assert.equal(await B.freshTree("/", 0, false), null);
  assert.equal((await B.scanRead("/")).res.bytes, 20, "and both are re-read by the next walk");
  h.release();
});

test("N4b a take is cleared by noteRan, and the prune keeps a take that is not ended", async () => {
  const { s, db } = fixture("n4b");
  await s.scan("/");
  await s.notePending([dueNow("/a/x")], 100);
  assert.deepEqual(await s.takeDue(realNow(), 10, { modifyMs: 100, settleMs: 1 }), ["/a/x"]);
  await sleep(150);
  (s as Any).lastPrune = 0;
  await s.takeDue(realNow(), 10, { modifyMs: 100, settleMs: 1 });
  assert.equal(rows(db, "SELECT COUNT(*) n FROM pending")[0].n, 1);
  await s.noteRan([{ path: "/a/x", endedAt: realNow(), hold: false }], 100);
  assert.equal(rows(db, "SELECT taker FROM pending")[0].taker, null);
});

test("W1 only one process writes: a second store on the file reads, defers its marks, and takes over when the first lets go", async () => {
  const { root, s: A, db } = fixture("w1", { leaseMs: 300 });
  await A.scan("/");
  const B = open(db, root, { leaseMs: 300 });
  await B.mayScan();
  assert.equal(A.isWriter, true);
  assert.equal(B.isWriter, false);
  assert.equal((await B.tree("/", 0, false)).entries[0]!.bytes, 15, "reads are served");
  await assert.rejects(B.scan("/"), /writer lease/);
  assert.equal(await B.notePending([dueNow("/a/x")], 100), false, "nothing is noted");
  B.markStale("/b");
  assert.equal(rows(db, "SELECT COUNT(*) n FROM stale_trees")[0].n, 0, "not written by a reader");
  await A.close();
  for (let i = 0; i < 100 && !B.isWriter; i++) await sleep(20);
  assert.ok(B.isWriter, "taken over at once: the lease was released");
  await sleep(50);
  assert.deepEqual(rows(db, "SELECT path FROM stale_trees").map((r) => r.path), ["/b"], "the deferred mark is written");
  assert.equal((await B.scanRead("/")).read, 2, "and honoured");
});

test("W2 fencing: a writer paused past its lease cannot commit after the next one took over", async () => {
  const { root, s: A, db } = fixture("w2", { leaseMs: 300 });
  await A.scan("/");
  const before = rows(db, "SELECT COUNT(*) n FROM sizes")[0].n;
  crash(A); // paused: no heartbeats, but still believes it is the writer
  assert.equal(A.isWriter, true);
  const B = open(db, root, { leaseMs: 300 });
  for (let i = 0; i < 200 && !B.isWriter; i++) await sleep(20);
  assert.ok(B.isWriter);
  // A wakes up and writes: both a mark and a walk
  A.markStale("/a");
  await assert.rejects(A.scan("/", undefined, true), /lease/);
  await sleep(50);
  assert.equal(A.isWriter, false, "A noticed");
  assert.equal(rows(db, "SELECT COUNT(*) n FROM stale_trees WHERE path = '/a'")[0].n, 0, "the mark did not land");
  assert.equal(rows(db, "SELECT COUNT(*) n FROM sizes")[0].n, before);
  assert.equal(rows(db, "SELECT COUNT(*) n FROM sizes WHERE ver = 1 AND scanned_at > 0")[0].n, before, "rows are still those of epoch 1");
});

test("W3 rows written by a version without the lease (ver = 0) are never vouched for", async () => {
  const { s, db } = fixture("w3");
  await s.scan("/");
  await validate(s);
  assert.ok(await s.freshTree("/", 0, false));
  // the old version's INSERT OR REPLACE has no ver column
  const d = new DatabaseSync(db);
  d.exec("PRAGMA busy_timeout=2000");
  d.prepare("INSERT OR REPLACE INTO sizes (path,parent,ino,dev,mtime_ms,scanned_at,seen_at,own_bytes,own_disk,own_files,own_symlinks,own_other,own_dirs,own_mounts,own_errors,tot_bytes,tot_disk,tot_files,tot_symlinks,tot_other,tot_dirs,tot_mounts,tot_errors) SELECT path,parent,ino,dev,mtime_ms,?,seen_at,own_bytes,own_disk,own_files,own_symlinks,own_other,own_dirs,own_mounts,own_errors,tot_bytes,tot_disk,tot_files,tot_symlinks,tot_other,tot_dirs,tot_mounts,tot_errors FROM sizes WHERE path = '/a/x'").run(realNow());
  d.close();
  assert.equal(rows(db, "SELECT ver FROM sizes WHERE path = '/a/x'")[0].ver, 0);
  assert.equal(await s.freshTree("/", 0, false), null);
  assert.equal(await s.freshTree("/a/x", 0, false), null);
  assert.ok(await s.freshTree("/b", 0, false), "other folders are still fine");
});

test("P4 an old version's whole walk that rewrote a folder the new writer applied cannot make it fresh; the next walk re-reads what it wrote", async () => {
  const { root, s, db } = fixture("p4");
  await s.scan("/");
  await validate(s);
  fs.writeFileSync(path.join(root, "a/x/f"), "1234567890");
  await s.applyChanged("/a/x"); // the new writer: /a/x is 10 now, ver 1
  // then the old version commits what it had read before the change (5 bytes), as rows without a ver
  const d = new DatabaseSync(db);
  d.exec("PRAGMA busy_timeout=2000");
  d.exec("UPDATE sizes SET tot_bytes = 5, own_bytes = 5, ver = 0 WHERE path = '/a/x'");
  d.exec("UPDATE sizes SET tot_bytes = 15, ver = 0 WHERE path IN ('/', '/a')");
  d.close();
  assert.equal(await s.freshTree("/", 0, false), null);
  assert.equal(await s.freshTree("/a/x", 0, false), null);
  const w = await s.scanRead("/", undefined, true);
  assert.equal(w.res.bytes, 20);
});

test("P1 a writer killed in the middle of a walk: its child rows are in, the totals above are not; the next writer marks the walked tree", async () => {
  const { root, s: A, db } = fixture("p1", { leaseMs: 300 });
  await A.scan("/");
  await validate(A);
  (A as Any).o.commitChunk = 1;
  fs.writeFileSync(path.join(root, "a/x/f"), "1234567890");
  await A.notePending([dueNow("/a/x")], T.modifyMs);
  const h = hold(A, (m) => m.last);
  void A.scan("/a", undefined, true).catch(() => undefined);
  while (!h.held()) await sleep(5);
  await sleep(50);
  assert.equal(rows(db, "SELECT tot_bytes b FROM sizes WHERE path = '/a/x'")[0].b, 10, "the child is stored");
  assert.equal(rows(db, "SELECT tot_bytes b FROM sizes WHERE path = '/a'")[0].b, 10, "the parent is not");
  assert.equal(await A.freshTree("/", 0, false), null, "not while the walk is open");
  crash(A);
  const B = open(db, root, { leaseMs: 300 });
  for (let i = 0; i < 200 && !B.isWriter; i++) await sleep(20);
  arm(B, realNow() - 1000);
  await sleep(100);
  // B applies the pending change as usual: the delta is zero, because the child already holds the new value
  const got = (await B.takeDue(realNow(), 10, T))!;
  for (const p of got) await B.applyChanged(p);
  await B.noteRan(got.map((p) => ({ path: p, endedAt: realNow(), hold: false })), T.modifyMs);
  const t = await B.freshTree("/", 0, false);
  assert.ok(t === null || bytes(t) === 20, `served ${bytes(t)}`);
  assert.equal((await B.scanRead("/")).res.bytes, 20);
  h.release();
});

test("L1 after a restart a plain du reuses what is within the TTL (it does not read the whole tree)", async () => {
  const { root, s, db } = fixture("l1");
  for (let i = 0; i < 20; i++) fs.mkdirSync(path.join(root, `d${i}/e`), { recursive: true });
  await s.scan("/");
  await s.close();
  const s2 = open(db, root);
  arm(s2, realNow());
  await sleep(5);
  const r = await s2.scanRead("/");
  assert.equal(r.read, 0, "nothing re-read");
  assert.equal(await s2.freshTree("/", 0, false), null, "but nothing vouched for either: the watcher was not there while those rows aged");
  assert.ok((await s2.scanRead("/", undefined, true)).read > 0);
  assert.ok(await s2.freshTree("/", 0, false), "an explicit rescan does");
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
  await sleep(5);
  await s2.scan("/", undefined, true);
  for (let i = 0; i < 200 && !rows(db, "SELECT name FROM sqlite_master WHERE name = 'pending_live'").length; i++) await sleep(50);
  assert.ok(rows(db, "SELECT name FROM sqlite_master WHERE name = 'pending_live'").length, "the partial index was built in the background");
  const t0 = performance.now();
  const t = await s2.freshTree("/", 0, false);
  const ms = performance.now() - t0;
  console.log(`# freshTree / with 400k idle pending rows: ${ms.toFixed(1)} ms`);
  assert.equal(bytes(t), 15);
  assert.ok(ms < 40, `took ${ms} ms`);
  // the periodic housekeeping statements use the partial index too, not a scan of every idle row
  const d2 = new DatabaseSync(db, { readOnly: true });
  const plan = (q: string) => (d2.prepare("EXPLAIN QUERY PLAN " + q).all(1, 2) as { detail: string }[]).map((r) => r.detail).join(" | ");
  const live = plan("SELECT 1 FROM pending WHERE due_at < 8640000000000000 AND (path IN (?1) OR (path > ?1 AND path < ?2)) LIMIT 1");
  const taken = plan("SELECT path FROM pending WHERE taker IS NOT NULL LIMIT ?2 AND ?1");
  d2.close();
  assert.match(live, /pending_live/);
  assert.match(taken, /pending_taker/);
});

test("P1b an old version's canceled walk zeroes the subtree and rewrote children without a ver: the chain above and the folder itself are refused", async () => {
  const { s, db } = fixture("p1b");
  await s.scan("/");
  await validate(s);
  const d = new DatabaseSync(db);
  d.exec("PRAGMA busy_timeout=2000");
  d.exec("UPDATE sizes SET scanned_at = 0 WHERE path = '/a' OR (path > '/a/' AND path < '/a0')");
  d.close();
  assert.equal(await s.freshTree("/", 0, false), null);
  assert.equal(await s.freshTree("/a", 0, false), null);
  assert.equal(await s.freshTree("/a/x", 0, false), null, "the chain above it is zeroed");
  assert.ok(await s.freshTree("/b", 0, false));
});

test("U1 a store of the previous version (no ver, no taker, none of the new tables) opens at once, as the writer, and its rows are read again once", async () => {
  const root = path.join(tmp, "u1-root");
  fs.mkdirSync(path.join(root, "a/x"), { recursive: true });
  fs.writeFileSync(path.join(root, "a/x/f"), "12345");
  const dbf = path.join(tmp, "u1.db");
  // the schema of 0.3.31 and a scan it made
  const cols = ["bytes", "disk", "files", "symlinks", "other", "dirs", "mounts", "errors"];
  const metrics = [...cols.map((m) => `own_${m} INTEGER NOT NULL`), ...cols.map((m) => `tot_${m} INTEGER NOT NULL`)].join(", ");
  const o = new DatabaseSync(dbf);
  o.exec(`PRAGMA journal_mode=WAL; CREATE TABLE sizes (path TEXT PRIMARY KEY, parent TEXT NOT NULL, ino REAL, dev REAL, mtime_ms REAL, scanned_at INTEGER, seen_at INTEGER NOT NULL DEFAULT 0, ${metrics}) WITHOUT ROWID; CREATE INDEX sizes_parent ON sizes(parent); CREATE TABLE pending (path TEXT PRIMARY KEY, due_at INTEGER NOT NULL, last_run INTEGER) WITHOUT ROWID; CREATE INDEX pending_due ON pending(due_at); CREATE INDEX pending_idle_run ON pending(due_at, last_run);`);
  const st = fs.statSync(root);
  o.prepare(`INSERT INTO sizes VALUES ('/', '', ?, ?, ?, ?, 1, 0,0,0,0,0,1,0,0, 5,5,1,0,0,1,0,0)`).run(st.ino, st.dev, st.mtimeMs, realNow());
  o.close();
  const errs: string[] = [];
  const quiet = console.error;
  console.error = (...a: unknown[]) => void errs.push(a.join(" "));
  let s: SizeStore;
  try {
    s = new SizeStore(dbf, { root, ttlMs: 3_600_000, maxEntries: 1000 });
    stores.push(s);
    await s.mayScan();
  } finally {
    console.error = quiet;
  }
  assert.equal(s.persistent, true, "usable right after the upgrade: " + errs.join(" | "));
  assert.equal(s.isWriter, true);
  assert.equal(rows(dbf, "SELECT ver FROM sizes WHERE path = '/'")[0].ver, 0, "the old row is not trusted");
  const w = await s.scanRead("/", undefined, true);
  assert.equal(w.res.bytes, 5);
  assert.ok(rows(dbf, "SELECT ver FROM sizes WHERE path = '/'")[0].ver > 0, "and is rewritten under the lease");
});

test("T1 a change made in the restart gap is answered with stale:true or with its real size, never as if current", async () => {
  const root = path.join(tmp, "t1-root");
  fs.mkdirSync(path.join(root, "t/sub"), { recursive: true });
  fs.writeFileSync(path.join(root, "t/sub/f"), "abc");
  const aux = path.join(tmp, "t1-aux");
  fs.mkdirSync(aux);
  const h = path.join(aux, "helper.sh");
  fs.writeFileSync(h, "#!/bin/sh\necho '#ready 1'\nexec sleep 3600\n", { mode: 0o755 });
  const mounts = path.join(aux, "mounts");
  fs.writeFileSync(mounts, "/dev/x / ext4 rw 0 0\n");
  const mk = () => {
    const a = createAgent(loadConfig({ FILEDECK_ROOT: root, FILEDECK_NODE: "t", FILEDECK_INDEX_DIR: aux, FILEDECK_FANWATCH: h, FILEDECK_PROC_MOUNTS: mounts, FILEDECK_HANDOVER_MS: "100" } as never)) as Any;
    agents.push(a);
    a.startWatcher();
    return a;
  };
  const A = mk();
  await sleep(300);
  assert.equal((await A.request("/api/du?path=/t&depth=1&fresh=1")).status, 200);
  const a1 = (await (await A.request("/api/du?path=/t&depth=1")).json()) as Any;
  assert.deepEqual([a1.watched, a1.stale, a1.entries[0].bytes], [true, undefined, 3]);
  await A.close();
  fs.writeFileSync(path.join(root, "t/sub/f"), "abcdefghij"); // in place: no folder mtime changes; nobody is watching
  const B = mk();
  for (let i = 0; i < 100; i++) {
    const r = (await (await B.request("/api/du?path=/t&depth=1")).json()) as Any;
    if (r.watched) break;
    await sleep(50);
  }
  await sleep(200);
  const b = (await (await B.request("/api/du?path=/t&depth=1")).json()) as Any;
  assert.ok(b.stale === true || b.entries[0].bytes === 10, `answered ${b.entries[0].bytes} with no stale flag`);
});

test("T2 the repeat of a detached du, after the folder changed and the watcher reported it, is flagged stale", async () => {
  const root = path.join(tmp, "t2-root");
  fs.mkdirSync(path.join(root, "t/sub"), { recursive: true });
  fs.writeFileSync(path.join(root, "t/sub/f"), "abc");
  const aux = path.join(tmp, "t2-aux");
  fs.mkdirSync(aux);
  const ev = path.join(aux, "ev");
  const h = path.join(aux, "helper.sh");
  fs.writeFileSync(h, `#!/bin/sh\necho '#ready 1'\nwhile sleep 0.02; do if [ -f ${ev} ]; then cat ${ev}; rm -f ${ev}; fi; done\n`, { mode: 0o755 });
  const mounts = path.join(aux, "mounts");
  fs.writeFileSync(mounts, "/dev/x / ext4 rw 0 0\n");
  const app = createAgent(loadConfig({ FILEDECK_ROOT: root, FILEDECK_NODE: "t", FILEDECK_INDEX_DIR: aux, FILEDECK_FANWATCH: h, FILEDECK_PROC_MOUNTS: mounts, FILEDECK_DU_WAIT_MS: "0", FILEDECK_HANDOVER_MS: "100" } as never)) as Any;
  agents.push(app);
  app.startWatcher();
  await sleep(300);
  const first = await app.request("/api/du?path=/t&depth=1");
  assert.equal(first.status, 202);
  const { jobId } = (await first.json()) as Any;
  for (let i = 0; i < 200; i++) {
    const j = (await (await app.request(`/api/jobs/${jobId}`)).json()) as Any;
    if (j.state === "done") break;
    await sleep(20);
  }
  fs.writeFileSync(path.join(root, "t/sub/f"), "abcdefghij");
  fs.writeFileSync(ev, `x ${root}/t/sub\n`);
  await sleep(150); // the watcher has it (settle 1 s: not applied yet)
  const r = await app.request("/api/du?path=/t&depth=1");
  const b = (await r.json()) as Any;
  assert.ok(r.status !== 200 || b.stale === true || b.entries[0].bytes === 10, "old size with no stale flag");
});

test("A-empty a failed read of the dead writer's takes at acquire does not switch the fast path on over them", async () => {
  const { root, s: A, db } = fixture("aempty", { leaseMs: 300 });
  await A.scan("/");
  await validate(A);
  fs.writeFileSync(path.join(root, "a/x/f"), "1234567890");
  await A.notePending([dueNow("/a/x")], 300);
  assert.deepEqual(await A.takeDue(realNow(), 10, { modifyMs: 300, settleMs: 1 }), ["/a/x"]);
  crash(A);
  const B = open(db, root, { leaseMs: 300 });
  const rd = (B as Any).read.bind(B);
  let failures = 2;
  (B as Any).read = async (q: string, sql: string, p: Any, d: Any) => (q === "taken" && failures-- > 0 ? d : rd(q, sql, p, d)); // a busy reader answers its default
  for (let i = 0; i < 300 && !(B as Any).idxReady; i++) await sleep(20);
  assert.ok(B.isWriter);
  arm(B, 0);
  await sleep(50);
  assert.deepEqual(rows(db, "SELECT path FROM dirty").map((r) => r.path), ["/a/x"], "the take of the dead writer was recorded after the retry");
  assert.equal(await B.freshTree("/a/x", 0, false), null);
});

test("A-return an acquire whose write fails once is tried again: the fast path comes on and adopted jobs wake", async () => {
  const { root, s: A, db } = fixture("areturn", { leaseMs: 300 });
  await A.scan("/");
  await validate(A);
  await A.notePending([dueNow("/a/x")], 300);
  await A.takeDue(realNow(), 10, { modifyMs: 300, settleMs: 1 });
  crash(A);
  const B = open(db, root, { leaseMs: 300 });
  const tx = (B as Any).txn.bind(B);
  let n = 0;
  (B as Any).txn = async (p: Any) => (n++ === 0 ? false : tx(p));
  for (let i = 0; i < 300 && !(B as Any).idxReady; i++) await sleep(20);
  assert.ok((B as Any).idxReady, "the second try went through");
  let woke = false;
  void B.whenWriter().then(() => (woke = true));
  await sleep(50);
  assert.equal(woke, true);
  assert.equal(rows(db, "SELECT COUNT(*) n FROM pending WHERE taker IS NOT NULL")[0].n, 0);
  assert.equal(rows(db, "SELECT COUNT(*) n FROM dirty")[0].n, 1);
});

test("L11a a walk whose root commit fails busy leaves no walking row behind; L11b a missed beat does not lose the lease or turn later rows into ver 0", async () => {
  const { s, db } = fixture("l11", { leaseMs: 600 });
  await s.scan("/");
  const a = s as Any;
  const orig = a.send.bind(s);
  let fail = true;
  a.send = async (m: Any) => {
    if (m.op === "commit" && m.last && !m.last.up && fail) {
      fail = false;
      throw Object.assign(new Error("database is locked"), { busy: true });
    }
    return orig(m);
  };
  const quiet = console.error;
  console.error = () => undefined;
  try {
    await s.scan("/", undefined, true);
  } finally {
    console.error = quiet;
  }
  await sleep(50);
  assert.equal(rows(db, "SELECT COUNT(*) n FROM walking")[0].n, 0, "the walking row was removed (the tree is marked stale instead)");
  assert.ok(rows(db, "SELECT COUNT(*) n FROM stale_trees")[0].n >= 1);
  // a beat that cannot get the database
  const post = a.post.bind(s);
  a.post = async (m: Any, r: boolean) => {
    if (m.op === "beat") throw Object.assign(new Error("database is locked"), { busy: true });
    return post(m, r);
  };
  await a.tryLease();
  assert.equal(s.isWriter, true, "still the writer");
  a.post = post;
  await s.scan("/", undefined, true);
  assert.equal(rows(db, "SELECT COUNT(*) n FROM sizes WHERE ver = 0")[0].n, 0);
});

test("L10 a committing writer keeps its lease alive: the commit's fence check refreshes the beat", async () => {
  const { s, db } = fixture("l10", { leaseMs: 60_000 });
  await s.scan("/");
  const before = rows(db, "SELECT beat FROM writer")[0].beat;
  crash(s); // no heartbeat messages
  await sleep(20);
  await s.scan("/", undefined, true);
  assert.ok(rows(db, "SELECT beat FROM writer")[0].beat > before);
});

test("N5' a change applied while the same writer's whole walk runs is not served stale-as-fresh", async () => {
  const { root, s: A, db } = fixture("n5s", { leaseMs: 300 });
  await A.scan("/");
  await validate(A);
  const h = hold(A, (m) => m.last);
  const w = A.scan("/");
  while (!h.held()) await sleep(5);
  fs.writeFileSync(path.join(root, "a/x/f"), "1234567890");
  await A.notePending([dueNow("/a/x")], T.modifyMs);
  const got = (await A.takeDue(realNow(), 10, T))!;
  const ap = Promise.all(got.map((p) => A.applyChanged(p)));
  h.release();
  await w;
  await ap;
  await A.noteRan(got.map((p) => ({ path: p, endedAt: realNow(), hold: true })), T.modifyMs);
  const t = await A.freshTree("/", 0, false);
  assert.ok(t === null || bytes(t) === 20, `served ${bytes(t)}; stored ${rows(db, "SELECT tot_bytes b FROM sizes WHERE path = '/'")[0].b}`);
});

test("P5' a second event while the first take of the same folder runs ends with the newer size", async () => {
  const { root, s: A } = fixture("p5s", { leaseMs: 300 });
  await A.scan("/");
  await validate(A);
  fs.writeFileSync(path.join(root, "a/x/f"), "1234567");
  await A.notePending([dueNow("/a/x")], T.modifyMs);
  await A.takeDue(realNow(), 10, T);
  const h = hold(A, (m) => m.last);
  const wa = A.applyChanged("/a/x");
  while (!h.held()) await sleep(5);
  fs.writeFileSync(path.join(root, "a/x/f"), "1234567890AB");
  await A.notePending([dueNow("/a/x")], T.modifyMs);
  h.release();
  await wa;
  await A.noteRan([{ path: "/a/x", endedAt: realNow(), hold: true }], T.modifyMs);
  const t = await A.freshTree("/a/x", 0, false);
  assert.ok(t === null || bytes(t) === 12, `served ${bytes(t)}`);
});
