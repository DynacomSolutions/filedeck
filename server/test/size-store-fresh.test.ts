import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SizeStore } from "../src/size-store.ts";
import fsp from "node:fs/promises";
import { FanWatch } from "../src/fanwatch.ts";
import { createAgent } from "../src/agent.ts";
import { loadConfig } from "../src/config.ts";

let tmp: string;
const stores: SizeStore[] = [];
const agents: { close(): Promise<void> }[] = [];
before(() => void (tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "filedeck-fresh-")))));
after(async () => {
  for (const s of stores) await s.close();
  for (const a of agents) await a.close().catch(() => {});
  fs.rmSync(tmp, { recursive: true, force: true });
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (f: () => boolean | Promise<boolean>, ms = 20_000) => {
  for (const t0 = Date.now(); !(await f()) && Date.now() - t0 < ms; ) await sleep(20);
};
function fixture(name: string) {
  const root = path.join(tmp, name);
  for (const d of ["a/x", "a/y", "b/z"]) fs.mkdirSync(path.join(root, d), { recursive: true });
  for (const f of ["a/x/f", "a/y/f", "b/z/f"]) fs.writeFileSync(path.join(root, f), "12345");
  const db = path.join(tmp, `${name}.db`); // beside the tree, not in it
  const s = new SizeStore(db, { root, ttlMs: 3_600_000, maxEntries: 100_000 });
  stores.push(s);
  return { root, s, db };
}
const scannedAt = (db: string, p: string) => {
  const d = new DatabaseSync(db, { readOnly: true });
  try {
    return (d.prepare("SELECT scanned_at s FROM sizes WHERE path = ?").get(p) as { s: number } | undefined)?.s;
  } finally {
    d.close();
  }
};


type Any = any; // the tests reach into private state on purpose
/** a store as a running watcher leaves it: ready at once and covering everything, then one full walk (rows re-read after the ready time are trusted) */
async function validate(s: SizeStore, p = "/") {
  const ready = Date.now();
  const a = s as Any;
  a.covers = () => true;
  a.quiet = () => true;
  a.watchedSince = () => ready;
  await sleep(5);
  await s.scan(p, undefined, true);
}
const bytes = (t: { entries: { bytes: number }[] } | null) => t?.entries?.[0]?.bytes ?? null;
const backlog = async (s: SizeStore, ps: string[]) => {
  await s.notePending(ps.map((path) => ({ path, dueAt: Date.now() - 10_000, modify: false })), 100);
  return s.takeDue(Date.now(), 10, { modifyMs: 100, settleMs: 1 });
};
/** hold back the commit sends the picker chooses until released */
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
/** the watcher applied what is pending: take it and report the re-reads ended */
async function settlePending(s: SizeStore) {
  const got = (await s.takeDue(Date.now(), 100, { modifyMs: 100, settleMs: 1 })) ?? [];
  await s.noteRan(got.map((p) => ({ path: p, endedAt: Date.now(), hold: false })), 100);
}
const rowsOf = (db: string, sql: string) => {
  const d = new DatabaseSync(db, { readOnly: true });
  try {
    return d.prepare(sql).all() as Any[];
  } finally {
    d.close();
  }
};

test("overflow: only the pending folders become dirty, nothing is zeroed, and an in-place change in one is seen by the next walk", async () => {
  const { root, s, db } = fixture("overflow");
  await s.scan("/");
  await sleep(20);
  // an in-place edit changes no folder mtime: only the dirty mark can make the store notice it
  fs.writeFileSync(path.join(root, "a/x/f"), "1234567890");
  await s.notePending([{ path: "/a/x", dueAt: Date.now() - 10_000, modify: false }], 100);
  assert.equal(await s.takeDue(Date.now(), 10, { modifyMs: 100, settleMs: 1 }), null, "backlog too old");
  assert.deepEqual(rowsOf(db, "SELECT path FROM dirty").map((r) => r.path), ["/a/x"]);
  assert.equal(rowsOf(db, "SELECT COUNT(*) n FROM sizes WHERE scanned_at = 0")[0].n, 0, "no row rewritten");
  assert.equal((s as Any).marks.size, 0, "no tree mark");
  assert.equal(rowsOf(db, "SELECT COUNT(*) n FROM pending WHERE due_at < ?".replace("?", String(Number.MAX_SAFE_INTEGER)))[0].n, 0, "nothing left pending");
  const r = await s.scanRead("/");
  assert.equal(r.read, 1, "only the dirty folder is re-read");
  assert.equal(r.res.bytes, 10 + 5 + 5, "the unseen in-place change is counted");
  assert.equal(rowsOf(db, "SELECT COUNT(*) n FROM dirty")[0].n, 0, "cleared by the walk that re-read it");
  assert.equal((await s.scanRead("/")).read, 0);
});

test("overflow: a pending folder that is not stored makes its stored parent dirty", async () => {
  const { s, db } = fixture("overflow-parent");
  await s.scan("/");
  assert.equal(await backlog(s, ["/a/new"]), null);
  assert.deepEqual(rowsOf(db, "SELECT path FROM dirty").map((r) => r.path), ["/a"]);
});

test("overflow: the dirty marks and the pending rows change in one transaction (a failure loses nothing)", async () => {
  const { s, db } = fixture("overflow-tx");
  await s.scan("/");
  const a = s as Any;
  const orig = a.txn.bind(s);
  a.txn = async () => false;
  assert.equal(await backlog(s, ["/a/x"]), null);
  a.txn = orig;
  assert.equal(rowsOf(db, "SELECT COUNT(*) n FROM dirty")[0].n, 0);
  assert.equal(rowsOf(db, "SELECT COUNT(*) n FROM pending WHERE due_at < 9007199254740991")[0].n, 1, "still pending");
  assert.equal(await s.takeDue(Date.now(), 10, { modifyMs: 100, settleMs: 1 }), null, "next take tries again");
  assert.equal(rowsOf(db, "SELECT COUNT(*) n FROM dirty")[0].n, 1);
});

test("a dirty mark survives a walk that read the folder before it was written (the walk does not clear what it did not see)", async () => {
  const { root, s, db } = fixture("dirty-race");
  await s.scan("/");
  await validate(s);
  const h = hold(s, () => true);
  const w = s.scan("/", undefined, true);
  while (!h.held()) await sleep(5);
  fs.writeFileSync(path.join(root, "a/x/f"), "1234567890");
  await backlog(s, ["/a/x"]);
  h.release();
  await w;
  assert.deepEqual(rowsOf(db, "SELECT path FROM dirty").map((r) => r.path), ["/a/x"], "still dirty: the walk's rows are older than the change");
  assert.equal(await s.freshTree("/", 0, false), null);
  assert.equal((await s.scanRead("/")).res.bytes, 20);
  assert.equal(rowsOf(db, "SELECT COUNT(*) n FROM dirty")[0].n, 0);
});

test("a stale tree mark is O(1), is honoured by the next walk and is spent by it", async () => {
  const { s, db } = fixture("mark");
  await s.scan("/");
  assert.equal((await s.scanRead("/")).read, 0);
  s.markStale("/a");
  assert.equal((await s.scanRead("/")).read, 3, "/a, /a/x and /a/y re-read; /b reused");
  assert.equal((await s.scanRead("/")).read, 0, "the mark is spent");
  assert.equal(rowsOf(db, "SELECT COUNT(*) n FROM stale_trees")[0].n, 0);
});

test("a mark survives a restart and is seen by a second store on the same file", async () => {
  const { root, s, db } = fixture("mark-restart");
  await s.scan("/");
  s.markStale("/b");
  await s.close();
  const s2 = new SizeStore(db, { root, ttlMs: 3_600_000, maxEntries: 1000 });
  stores.push(s2);
  assert.equal((await s2.scanRead("/")).read, 2, "/b and /b/z");
  // another process: its marks reach this one through the file
  const s3 = new SizeStore(db, { root, ttlMs: 3_600_000, maxEntries: 1000 });
  stores.push(s3);
  await validate(s3);
  assert.ok(await s3.freshTree("/a", 0, false));
  s2.markStale("/a");
  await until(async () => (await s3.freshTree("/a", 0, false)) === null, 5000);
  assert.equal(await s3.freshTree("/a", 0, false), null, "the other store's mark is honoured");
});

test("marks past the cap collapse into one on / in one transaction, later than every mark", async () => {
  const { s, db } = fixture("mark-cap");
  await s.scan("/");
  for (let i = 0; i < 300; i++) s.markStale(`/m${i}`);
  await s.scan("/b"); // a read after the writes: the writer ran them in order
  await until(() => rowsOf(db, "SELECT COUNT(*) n FROM stale_trees")[0].n <= 256);
  const rows = rowsOf(db, "SELECT path, at FROM stale_trees");
  assert.ok(rows.length < 256 && rows.some((r) => r.path === "/"), JSON.stringify(rows.length));
});

test("a persisted mark ahead of the clock does not make a newer mark look older", async () => {
  const { s } = fixture("mark-clock");
  const a = s as Any;
  a.marks.set("/a", Date.now() + 3_600_000);
  s.markStale("/a/x");
  assert.ok(a.marks.get("/a/x") > a.marks.get("/a"), "the new mark is later than the persisted one");
});

test("freshTree: needs a validating walk after the watcher was ready, and nothing pending, dirty, marked or being applied", async () => {
  const { s } = fixture("fresh");
  await s.scan("/");
  const a = s as Any;
  a.covers = () => true;
  a.quiet = () => true;
  a.watchedSince = () => Date.now();
  assert.equal(await s.freshTree("/", 1, false), null, "nothing validated since the watcher was ready");
  await validate(s);
  const t = await s.freshTree("/", 1, false);
  assert.equal(bytes(t), 15);
  assert.equal(await s.freshTree("/", 1, true), null, "all=1 lists files from disk: never here");
  a.covers = () => false;
  assert.equal(await s.freshTree("/", 1, false), null, "not watched");
  a.covers = () => true;
  a.quiet = () => false;
  assert.equal(await s.freshTree("/", 1, false), null, "a change is waiting in the watcher");
  a.quiet = () => true;
  await s.notePending([{ path: "/b/z", dueAt: Date.now() - 10, modify: false }], 100);
  assert.equal(await s.freshTree("/", 1, false), null, "pending below");
  assert.equal(await s.freshTree("/b/z", 1, false), null, "pending on the folder");
  assert.ok(await s.freshTree("/a", 1, false), "an unrelated folder is still fresh");
  await settlePending(s);
  assert.ok(await s.freshTree("/", 1, false));
  s.markStale("/b");
  assert.equal(await s.freshTree("/", 1, false), null, "a mark below");
  assert.equal(await s.freshTree("/b/z", 1, false), null, "a mark above");
  assert.ok(await s.freshTree("/a", 1, false), "a mark elsewhere does not matter");
  await s.scan("/");
  assert.ok(await s.freshTree("/", 1, false), "a walk that began after the mark and reused only trusted rows validates the tree again");
});

test("freshTree: a validated walk of an ancestor covers a folder below it; a pending ancestor does not let the folder through", async () => {
  const { root, s } = fixture("fresh-chain");
  await s.scan("/");
  await validate(s);
  assert.ok(await s.freshTree("/a/x", 0, false));
  // a swapped folder: the helper reports the parent (and the old and new names); the child below must not be served from before
  fs.renameSync(path.join(root, "a/x"), path.join(root, "a/x.old"));
  fs.mkdirSync(path.join(root, "a/x"));
  fs.writeFileSync(path.join(root, "a/x/big"), "z".repeat(1000));
  await s.notePending([{ path: "/a", dueAt: Date.now() - 10, modify: false }], 100);
  assert.equal(await s.freshTree("/a/x", 0, false), null, "pending parent");
  await settlePending(s);
  await s.notePending([{ path: "/", dueAt: Date.now() - 10, modify: false }], 100);
  assert.equal(await s.freshTree("/a/x", 0, false), null, "pending grandparent");
  await settlePending(s);
  // the same after an overflow: dirty marks on the ancestors
  assert.equal(await backlog(s, ["/", "/a", "/a/x.old"]), null);
  assert.equal(await s.freshTree("/a/x", 0, false), null, "dirty ancestors");
  assert.equal(await s.freshTree("/a/y", 0, false), null);
  assert.equal((await s.scanRead("/a/x")).res.bytes, 1000);
});

test("freshTree: not while a walk is half done (its repaired child is stored, the total above is not yet)", async () => {
  const { root, s } = fixture("fresh-midwalk", );
  await s.scan("/");
  await validate(s);
  fs.writeFileSync(path.join(root, "a/x/f"), "1234567890");
  assert.equal(await backlog(s, ["/a/x"]), null);
  const h = hold(s, (m) => m.last);
  (s as Any).o.commitChunk = 1;
  const w = s.scan("/", undefined, true);
  while (!h.held()) await sleep(5);
  assert.equal(await s.freshTree("/", 0, false), null, "the walk holds the lock, and the folder is still dirty");
  h.release();
  await w;
});

test("freshTree after a killed walk: the dirty mark stays until a walk ends cleanly", async () => {
  const { root, s, db } = fixture("fresh-killed");
  await s.scan("/");
  await validate(s);
  fs.writeFileSync(path.join(root, "a/x/f"), "1234567890");
  assert.equal(await backlog(s, ["/a/x"]), null);
  const ac = new AbortController();
  const ctl = { signal: ac.signal, progress: { bytes: 0, totalBytes: 0, entries: 0, totalEntries: 0, current: "" } };
  (s as Any).o.commitChunk = 1;
  const timer = setInterval(() => ctl.progress.entries > 2 && ac.abort(), 1);
  await assert.rejects(s.scan("/", ctl, true), /canceled/);
  clearInterval(timer);
  assert.equal(rowsOf(db, "SELECT COUNT(*) n FROM dirty")[0].n, 1);
  assert.equal(await s.freshTree("/", 0, false), null);
});

test("freshTree: a change in the restart gap is not served, rows within the TTL notwithstanding", async () => {
  const { root, s, db } = fixture("fresh-gap");
  await s.scan("/");
  await s.close();
  fs.rmSync(path.join(root, "a/y"), { recursive: true });
  const s2 = new SizeStore(db, { root, ttlMs: 3_600_000, maxEntries: 1000 });
  stores.push(s2);
  const a = s2 as Any;
  const ready = Date.now();
  a.covers = () => true;
  a.quiet = () => true;
  a.watchedSince = () => ready;
  assert.equal(await s2.freshTree("/", 0, false), null);
  // a plain walk under the running watcher re-reads the rows that predate it, so it can vouch for the tree when it ends (liveness right after a restart)
  await sleep(5);
  const w = await s2.scanRead("/");
  assert.ok(w.read > 0, "the old rows were re-read, not reused on their age");
  assert.equal(bytes(await s2.freshTree("/", 0, false)), 10);
  assert.equal((await s2.scanRead("/")).read, 0, "and the next walk reuses them");
});

test("freshTree: an old row of another device, or a mark above a mount point, does not block a validated folder", async () => {
  const { s, db } = fixture("fresh-mount");
  await s.scan("/");
  const d = new DatabaseSync(db);
  d.prepare("INSERT INTO sizes (path,parent,ino,dev,mtime_ms,scanned_at,seen_at,own_bytes,own_disk,own_files,own_symlinks,own_other,own_dirs,own_mounts,own_errors,tot_bytes,tot_disk,tot_files,tot_symlinks,tot_other,tot_dirs,tot_mounts,tot_errors) VALUES ('/a/mnt','/a',1,999,1,?,1,7,7,1,0,0,0,0,0,7,7,1,0,0,0,0,0)").run(Date.now() - 10 * 3_600_000);
  d.close();
  s.markStale("/a");
  await validate(s);
  assert.equal(bytes(await s.freshTree("/", 0, false)), 15);
  assert.ok(await s.freshTree("/a", 0, false));
  assert.equal((s as Any).marks.size, 0, "the mark above the mount point was spent by the walk of /");
});

test("freshTree: no change is served while it is being taken for apply (rows already idle, prune still in flight)", async () => {
  const { root, s } = fixture("fresh-take");
  await s.scan("/");
  await validate(s);
  fs.writeFileSync(path.join(root, "a/x/f"), "1234567890");
  await s.notePending([{ path: "/a/x", dueAt: Date.now() - 10, modify: false }], 100_000);
  const a = s as Any;
  const orig = a.write1.bind(s);
  let go!: () => void;
  const g = new Promise<void>((r) => (go = r));
  let held = false;
  a.write1 = async (q: string, p: unknown[]) => {
    held = true;
    await g;
    return orig(q, p);
  };
  const t = s.takeDue(Date.now(), 10, { modifyMs: 100_000, settleMs: 1 });
  while (!held) await sleep(5);
  assert.equal(await s.freshTree("/", 0, false), null, "taken, not yet applied");
  go();
  assert.deepEqual(await t, ["/a/x"]);
  assert.equal(await s.freshTree("/", 0, false), null, "still being applied");
  await s.applyChanged("/a/x");
  await s.noteRan([{ path: "/a/x", endedAt: Date.now(), hold: false }], 100_000);
  assert.equal(bytes(await s.freshTree("/", 0, false)), 20);
});

test("freshTree is a handful of lookups: 500k other rows do not slow it", async () => {
  const { s, db } = fixture("fresh-cost");
  await s.scan("/");
  const d = new DatabaseSync(db);
  d.exec("PRAGMA synchronous=OFF; BEGIN");
  const ins = d.prepare("INSERT INTO sizes (path,parent,ino,dev,mtime_ms,scanned_at,seen_at,own_bytes,own_disk,own_files,own_symlinks,own_other,own_dirs,own_mounts,own_errors,tot_bytes,tot_disk,tot_files,tot_symlinks,tot_other,tot_dirs,tot_mounts,tot_errors) VALUES (?,?,1,1,1,1,1,1,1,1,0,0,0,0,0,1,1,1,0,0,0,0,0)");
  for (let i = 0; i < 500_000; i++) ins.run(`/w/t${i % 50}/d${i}`, `/w/t${i % 50}`);
  d.exec("COMMIT");
  d.close();
  await validate(s, "/a");
  const t0 = performance.now();
  const t = await s.freshTree("/a", 1, false);
  const ms = performance.now() - t0;
  console.log(`# freshTree with 500k old rows elsewhere: ${ms.toFixed(1)} ms`);
  assert.ok(t);
  assert.ok(ms < 150, `took ${ms} ms`);
});

test("a first open that finds the file locked is not a corrupt store: nothing is deleted and it opens once the lock is gone", async () => {
  const dbf = path.join(tmp, "locked.db");
  const root = path.join(tmp, "locked-root");
  fs.mkdirSync(path.join(root, "a"), { recursive: true });
  const o = new DatabaseSync(dbf);
  // a store of the previous version: no dirty/validated/stale_trees tables
  const cols = ["bytes", "disk", "files", "symlinks", "other", "dirs", "mounts", "errors"];
  const metrics = [...cols.map((m) => `own_${m} INTEGER NOT NULL DEFAULT 0`), ...cols.map((m) => `tot_${m} INTEGER NOT NULL DEFAULT 0`)].join(", ");
  o.exec(`PRAGMA journal_mode=WAL; CREATE TABLE sizes (path TEXT PRIMARY KEY, parent TEXT NOT NULL, ino REAL, dev REAL, mtime_ms REAL, scanned_at INTEGER, seen_at INTEGER NOT NULL DEFAULT 0, ${metrics}) WITHOUT ROWID; CREATE INDEX sizes_parent ON sizes(parent); CREATE TABLE pending (path TEXT PRIMARY KEY, due_at INTEGER NOT NULL, last_run INTEGER) WITHOUT ROWID; INSERT INTO sizes (path,parent) VALUES ('/keep','/')`);
  const ino = fs.statSync(dbf).ino;
  o.exec("BEGIN IMMEDIATE");
  const quiet = console.error;
  console.error = () => undefined;
  let s: SizeStore;
  try {
    s = new SizeStore(dbf, { root, ttlMs: 1000, maxEntries: 1000 });
  } finally {
    console.error = quiet;
  }
  stores.push(s);
  o.exec("COMMIT");
  o.close();
  assert.equal(fs.statSync(dbf).ino, ino, "same file");
  (s as Any).retryAt = 1; // do not wait out the retry delay
  assert.equal((await s.scan("/a")).dirs, 0);
  await until(() => s.persistent, 5000);
  assert.equal(s.persistent, true, "usable after the lock was released");
  assert.equal(rowsOf(dbf, "SELECT COUNT(*) n FROM sizes WHERE path = '/keep'")[0].n, 1, "the old rows are still there");
  assert.ok(rowsOf(dbf, "SELECT name FROM sqlite_master WHERE name = 'dirty'").length);
});

test("a corrupt file is still replaced", async () => {
  const dbf = path.join(tmp, "corrupt.db");
  fs.writeFileSync(dbf, "this is not a database ".repeat(200));
  const root = path.join(tmp, "corrupt-root");
  fs.mkdirSync(path.join(root, "a"), { recursive: true });
  const quiet = console.error;
  console.error = () => undefined;
  try {
    const s = new SizeStore(dbf, { root, ttlMs: 1000, maxEntries: 1000 });
    stores.push(s);
    assert.equal((await s.scan("/a")).dirs, 0);
    assert.equal(s.persistent, true);
  } finally {
    console.error = quiet;
  }
});

test("FanWatch.settled: false while a flush is in the store's hands, while output is paused, and for ancestors and descendants", async () => {
  let go!: () => void;
  const g = new Promise<void>((r) => (go = r));
  const sink = { applyChanged: async () => {}, markStale() {}, notePending: async () => (await g, true), takeDue: async () => [] as string[] };
  const w = new FanWatch(sink, { helper: "x", root: "/", procMounts: "/proc/mounts" });
  const a = w as Any;
  assert.equal(w.settled("/a"), true);
  w.line("x /a/x/y");
  assert.equal(w.settled("/a"), false, "buffered, below");
  assert.equal(w.settled("/a/x/y/z"), false, "buffered, above");
  assert.equal(w.settled("/b"), true);
  const p = a.flush();
  assert.equal(w.settled("/a"), false, "swapped out of the buffer, not stored yet");
  go();
  await p;
  assert.equal(w.settled("/a"), true, "stored: the store's pending table answers from here");
  a.resume = () => {};
  assert.equal(w.settled("/b"), false, "events may sit in the pipe");
  w.stop();
});

test("the store tells a folder it handed out is still being applied until noteRan", async () => {
  const { s } = fixture("taken");
  await s.scan("/");
  await s.notePending([{ path: "/a/x", dueAt: Date.now() - 10, modify: false }], 100);
  assert.deepEqual(await s.takeDue(Date.now(), 10, { modifyMs: 100, settleMs: 1 }), ["/a/x"]);
  assert.ok((s as Any).taken.has("/a/x"));
  await s.noteRan([{ path: "/a/x", endedAt: Date.now(), hold: false }], 100);
  assert.ok(!(s as Any).taken.has("/a/x"));
});

/** a helper that is ready at once and reports nothing: the watcher covers the whole root without a kernel */
function readyHelper(dir: string) {
  const f = path.join(dir, "helper.sh");
  fs.writeFileSync(f, "#!/bin/sh\necho '#ready 1'\nexec sleep 3600\n", { mode: 0o755 });
  const mounts = path.join(dir, "mounts");
  fs.writeFileSync(mounts, "/dev/x / ext4 rw 0 0\n");
  return { f, mounts };
}

test("GET /api/du: a watched tree whose rows are fresh is answered without a job", async () => {
  const root = path.join(tmp, "api");
  fs.mkdirSync(path.join(root, "t/sub"), { recursive: true });
  fs.writeFileSync(path.join(root, "t/sub/f"), "abc");
  const aux = path.join(tmp, "api-aux");
  fs.mkdirSync(aux);
  const h = readyHelper(aux);
  const app = createAgent(loadConfig({ FILEDECK_ROOT: root, FILEDECK_NODE: "t", FILEDECK_INDEX_DIR: aux, FILEDECK_FANWATCH: h.f, FILEDECK_PROC_MOUNTS: h.mounts } as never));
  agents.push(app as unknown as { close(): Promise<void> });
  (app as unknown as { startWatcher(): void }).startWatcher();
  const jobs = async () => ((await (await app.request("/api/jobs")).json()) as { jobs: { kind: string }[] }).jobs.length;
  // no stored rows yet and not covered yet: a job runs
  const first = await app.request("/api/du?path=/t&depth=1");
  assert.equal(first.status, 200);
  assert.equal(await jobs(), 1);
  let ans: { cached: boolean; watched: boolean } = { cached: false, watched: false };
  for (let i = 0; i < 100; i++) {
    ans = (await (await app.request("/api/du?path=/t&depth=1")).json()) as typeof ans;
    if (ans.watched) break;
    await sleep(50);
  }
  assert.equal(ans.watched, true, "watcher ready");
  // rows stored before the watcher was ready are not vouched for: one rescan after it, then the fast path
  assert.equal((await app.request("/api/du?path=/t&depth=1&fresh=1")).status, 200);
  const before = await jobs();
  for (let i = 0; i < 3; i++) {
    const r = await app.request("/api/du?path=/t&depth=1");
    const b = (await r.json()) as { cached: boolean; watched: boolean; entries: { path: string; bytes: number }[]; stale?: boolean };
    assert.equal(r.status, 200);
    assert.deepEqual([b.cached, b.watched, b.stale], [true, true, undefined]);
    assert.equal(b.entries[0]!.bytes, 3);
  }
  assert.equal(await jobs(), before, "no job for fresh watched data");
});

test("GET /api/du: a live scan of an overlapping folder is not waited for: stored rows answer with stale:true, and no job is started", async () => {
  const root = path.join(tmp, "api2");
  fs.mkdirSync(path.join(root, "p/child"), { recursive: true });
  fs.writeFileSync(path.join(root, "p/child/f"), "abc");
  const app = createAgent(loadConfig({ FILEDECK_ROOT: root, FILEDECK_NODE: "t", FILEDECK_DU_WAIT_MS: "300" } as never));
  agents.push(app as unknown as { close(): Promise<void> });
  assert.equal((await app.request("/api/du?path=/p&depth=1")).status, 200); // stores /p
  // the child rescan is held inside its first directory read
  const orig = fsp.readdir;
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let reading = false;
  (fsp as { readdir: unknown }).readdir = async (p: string, ...a: unknown[]) => {
    if (String(p).endsWith("/p/child")) {
      reading = true;
      await gate;
    }
    return (orig as (...x: unknown[]) => unknown)(p, ...a);
  };
  try {
    const post = await app.request("/api/jobs/size", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: "/p/child", fresh: true }) });
    assert.equal(post.status, 202);
    const job = (await post.json()) as { id: string };
    while (!reading) await sleep(5);
    const jobsBefore = ((await (await app.request("/api/jobs")).json()) as { jobs: unknown[] }).jobs.length;
    const t0 = Date.now();
    const r = await app.request("/api/du?path=/p&depth=1");
    assert.equal(r.status, 200, "answered at once");
    const body = (await r.json()) as { stale?: boolean; entries: { path: string }[] };
    assert.equal(body.stale, true);
    assert.equal(body.entries[0]!.path, "/p");
    assert.ok(Date.now() - t0 < 250, `${Date.now() - t0} ms`);
    assert.equal(((await (await app.request("/api/jobs")).json()) as { jobs: unknown[] }).jobs.length, jobsBefore, "no job was started");
    release();
    for (let i = 0; i < 200; i++) {
      if (((await (await app.request(`/api/jobs/${job.id}`)).json()) as { state: string }).state === "done") break;
      await sleep(20);
    }
  } finally {
    release();
    (fsp as { readdir: unknown }).readdir = orig;
  }
});

test("commit stall regression: stale marks on a huge store do not rewrite rows or hold the writer; a scan queued behind them is not delayed", async () => {
  // Before: markStale was `UPDATE sizes SET scanned_at = 0 WHERE path = ? OR (path > ? AND path < ?)` over the whole subtree, on the one writer
  // thread: ~1.9 s per mark at 1M rows, ~28 s for 6 marks at 3M, and every scan commit queued behind them (size-commit stalls). Now one mark row each.
  const { root, s, db } = fixture("stall");
  await s.scan("/");
  await sleep(50);
  const d = new DatabaseSync(db);
  d.exec("PRAGMA synchronous=OFF; BEGIN");
  const ins = d.prepare("INSERT INTO sizes (path,parent,ino,dev,mtime_ms,scanned_at,seen_at,own_bytes,own_disk,own_files,own_symlinks,own_other,own_dirs,own_mounts,own_errors,tot_bytes,tot_disk,tot_files,tot_symlinks,tot_other,tot_dirs,tot_mounts,tot_errors) VALUES (?,?,1,1,1,?,1,1,1,1,0,0,0,0,0,1,1,1,0,0,0,0,0)");
  const N = 500_000;
  for (let i = 0; i < N; i++) ins.run(`/w/t${i % 50}/d${i}`, `/w/t${i % 50}`, Date.now());
  d.exec("COMMIT");
  d.close();
  const t0 = performance.now();
  for (let i = 0; i < 6; i++) s.markStale(i % 2 ? "/" : "/w");
  fs.writeFileSync(path.join(root, "a/x/g"), "z");
  const r = await s.scan("/a/x", undefined, true);
  const ms = performance.now() - t0;
  assert.equal(r.files, 2);
  console.log(`# stall bench: ${N} rows, 6 marks + small scan: ${ms.toFixed(0)} ms`);
  assert.ok(ms < 1500, `took ${ms} ms`);
  const q = new DatabaseSync(db, { readOnly: true });
  assert.equal((q.prepare("SELECT COUNT(*) n FROM sizes WHERE scanned_at = 0").get() as { n: number }).n, 0, "rows were not rewritten");
  assert.ok((q.prepare("SELECT COUNT(*) n FROM stale_trees").get() as { n: number }).n <= 2);
  q.close();
});
