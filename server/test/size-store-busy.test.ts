import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { loadConfig } from "../src/config.ts";
import { createAgent, SizeStore, tmp, at, sleep, mk, rows, fileStore } from "./size-store-support.ts";

// ---- a busy database is a cache miss ----

type Priv = { q: { get: { get(p: string): unknown } }; send(m: unknown): Promise<void>; walks: Map<string, unknown>[]; db: { close(): void } | null; giveUp(e: unknown): void; retryAt: number; persistent: boolean };

test("a locked database is a cache miss on read and on write: the store is not given up and the next call works", async () => {
  fs.mkdirSync(at("bz/a"), { recursive: true });
  const s = fileStore();
  const p = s as unknown as Priv;
  const quiet = console.error;
  console.error = () => undefined;
  try {
    const real = p.q.get;
    p.q.get = { get: () => { throw Object.assign(new Error("database is locked"), { errcode: 5 }); } };
    assert.equal((await s.scan("/bz")).dirs, 1); // every lookup misses: the walk reads from disk
    p.q.get = real;
    const send = p.send;
    p.send = () => Promise.reject(Object.assign(new Error("database is locked"), { busy: true }));
    assert.equal((await s.scan("/bz", undefined, true)).dirs, 1); // the commit is lost, not the store
    p.send = send;
    assert.equal(s.persistent, true);
    assert.equal((await s.scan("/bz", undefined, true)).dirs, 1);
    assert.equal((await s.scanRead("/bz")).read, 0); // stored by the last scan
  } finally {
    console.error = quiet;
  }
  s.close();
});

test("with the database unusable the in-memory fallback holds at most 20 000 rows", async () => {
  const dir = at("fb");
  for (let i = 0; i < 30_000; i++) fs.mkdirSync(path.join(dir, `d${i}`), { recursive: true });
  const s = new SizeStore(path.join(tmp, "no-such-dir", "x", "sizes.db"), { root: tmp, ttlMs: 60_000, maxEntries: 1_000_000 });
  const p = s as unknown as Priv;
  // force the store unusable
  const quiet = console.error;
  console.error = () => undefined;
  try {
    if (s.persistent) p.giveUp(new Error("forced"));
    const r = await s.scan("/fb");
    assert.equal(r.dirs, 30_000);
    assert.equal(s.persistent, false);
    assert.ok(p.walks.reduce((n, w) => n + w.size, 0) <= 20_001);
  } finally {
    console.error = quiet;
  }
  s.close();
});

test("after a real failure the store is opened again once the backoff has passed", async () => {
  fs.mkdirSync(at("ro/a"), { recursive: true });
  const s = fileStore();
  const p = s as unknown as Priv;
  const quiet = console.error;
  console.error = () => undefined;
  try {
    await s.scan("/ro");
    p.giveUp(new Error("disk I/O error"));
    assert.equal(s.persistent, false);
    assert.equal((await s.scan("/ro")).dirs, 1); // uncached, before the backoff has passed
    assert.equal(s.persistent, false);
    p.retryAt = Date.now() - 1;
    assert.equal((await s.scan("/ro")).dirs, 1);
    assert.equal(s.persistent, true);
    assert.equal((await s.scanRead("/ro")).read, 0);
  } finally {
    console.error = quiet;
  }
  s.close();
});

// ---- review fixes: busy reads never give wrong totals ----

const failOnce = (obj: { all?: (...a: unknown[]) => unknown; get?: (...a: unknown[]) => unknown }, fn: "all" | "get", nth: number) => {
  const orig = obj[fn]!;
  let n = 0;
  obj[fn] = (...a: unknown[]) => {
    if (n++ === nth) throw Object.assign(new Error("database is locked"), { errcode: 5 });
    return orig.call(obj, ...a);
  };
  return () => (obj[fn] = orig);
};

test("a busy read of the stored children never gives a folder without its children", async () => {
  for (const [n, nth] of [[3, 0], [1300, 6]] as const) {
    const dir = at(`bk${n}`);
    for (let i = 0; i < n; i++) {
      fs.mkdirSync(path.join(dir, `k${String(i).padStart(4, "0")}`), { recursive: true });
      fs.writeFileSync(path.join(dir, `k${String(i).padStart(4, "0")}`, "f"), "x".repeat(10));
    }
    const s = mk();
    const quiet = console.error;
    console.error = () => undefined;
    try {
      const first = await s.scan(`/bk${n}`);
      const restore = failOnce((s as unknown as { q: { kidPage: never } }).q.kidPage, "all", nth);
      const second = await s.scan(`/bk${n}`);
      restore();
      if (nth === 0) assert.equal(second.bytes, first.bytes); // the reuse check failed: the folder was read again
      else assert.ok(second.errors >= 1); // the walk ran short of children and says so
      // either way the next scan re-reads the stale subtree and is exact
      assert.deepEqual(await s.scan(`/bk${n}`), first);
    } finally {
      console.error = quiet;
    }
    s.close();
  }
});

test("a scan of a child alone does not leave a ghost: the parent scan purges rows it has no stored row for", async () => {
  fs.mkdirSync(at("gh/a/b"), { recursive: true });
  fs.mkdirSync(at("gh/a/c"));
  const s = mk();
  await s.scan("/gh/a/b");
  await s.scan("/gh/a/c");
  fs.rmSync(at("gh/a/c"), { recursive: true });
  await s.scan("/gh/a");
  assert.deepEqual((await rows(s, "/gh/a")).map((e) => e.path), ["/gh/a", "/gh/a/b"]);
  s.close();
});

test("a folder that reports size 0 is streamed with opendir, not trusted to be small", async () => {
  fs.mkdirSync(at("z0/a"), { recursive: true });
  const olst = fsp.lstat;
  const oopen = fsp.opendir;
  let opened = 0;
  (fsp as { lstat: unknown }).lstat = async (p: string, ...a: unknown[]) => {
    const st = (await (olst as (...x: unknown[]) => Promise<object>)(p, ...a)) as { isDirectory(): boolean };
    return String(p) === at("z0/a") ? Object.assign(Object.create(Object.getPrototypeOf(st)), st, { size: 0 }) : st;
  };
  (fsp as { opendir: unknown }).opendir = (...a: unknown[]) => (opened++, (oopen as (...x: unknown[]) => unknown)(...a));
  const s = mk();
  try {
    assert.equal((await s.scan("/z0")).dirs, 1);
  } finally {
    (fsp as { lstat: unknown }).lstat = olst;
    (fsp as { opendir: unknown }).opendir = oopen;
  }
  assert.equal(opened, 1);
  s.close();
});

test("a busy read in applyChanged marks the folder stale instead of dropping the event", async () => {
  fs.mkdirSync(at("ac/a"), { recursive: true });
  const s = mk();
  await s.scan("/ac");
  const restore = failOnce((s as unknown as { q: { get: never } }).q.get, "get", 0);
  const quiet = console.error;
  console.error = () => undefined;
  try {
    await s.applyChanged("/ac/a");
  } finally {
    restore();
    console.error = quiet;
  }
  await (s as unknown as { tail: Promise<void> }).tail;
  assert.equal((await s.scanRead("/ac")).read, 2); // stale: read again
  s.close();
});

test("reopening the store never lowers the walk stamp", async () => {
  fs.mkdirSync(at("st/a"), { recursive: true });
  const s = fileStore();
  const p = s as unknown as Priv & { stamp: number };
  const quiet = console.error;
  console.error = () => undefined;
  try {
    await s.scan("/st");
    p.stamp += 1_000_000; // as if an uncached walk handed out later stamps
    const before = p.stamp;
    p.giveUp(new Error("disk I/O error"));
    p.retryAt = Date.now() - 1;
    await s.scan("/st");
    assert.ok(p.stamp >= before);
  } finally {
    console.error = quiet;
  }
  s.close();
});

test("opening a store with many rows runs no statement that scans the sizes table", () => {
  const file = at("big.db");
  new SizeStore(file, { root: tmp, ttlMs: 60_000, maxEntries: 100_000 }).close(); // creates the schema
  const db = new DatabaseSync(file);
  const names = (db.prepare("PRAGMA table_info(sizes)").all() as { name: string }[]).map((c) => c.name);
  const ins = db.prepare(`INSERT INTO sizes (${names.join(",")}) VALUES (?${",0".repeat(names.length - 1)})`);
  db.exec("BEGIN");
  for (let i = 0; i < 200_000; i++) ins.run("/p" + i);
  db.exec("COMMIT");
  db.close();
  const seen: string[] = [];
  const orig = DatabaseSync.prototype.prepare;
  DatabaseSync.prototype.prepare = function (this: DatabaseSync, sql: string) {
    seen.push(sql);
    return orig.call(this, sql);
  } as typeof orig;
  try {
    new SizeStore(file, { root: tmp, ttlMs: 60_000, maxEntries: 100_000 }).close();
  } finally {
    DatabaseSync.prototype.prepare = orig;
  }
  assert.deepEqual(seen.filter((q) => /FROM sizes\b/i.test(q) && !/WHERE/i.test(q)), []);
});

function seedPending(file: string, n: number, due = 1, lastRun: number | null = null) {
  new SizeStore(file, { root: tmp, ttlMs: 60_000, maxEntries: 100_000 }).close(); // creates the schema
  const db = new DatabaseSync(file);
  const ins = db.prepare("INSERT INTO pending (path, due_at, last_run) VALUES (?, ?, ?)");
  db.exec("BEGIN");
  for (let i = 0; i < n; i++) ins.run("/p" + i, due, lastRun);
  db.exec("COMMIT");
  db.close();
}
const spyPrepare = (seen: string[]) => {
  const orig = DatabaseSync.prototype.prepare;
  DatabaseSync.prototype.prepare = function (this: DatabaseSync, sql: string) {
    seen.push(sql);
    return orig.call(this, sql);
  } as typeof orig;
  return () => void (DatabaseSync.prototype.prepare = orig);
};

test("starting an agent and its watcher runs no statement over a large pending table except bounded reads", () => {
  const idx = fs.mkdtempSync(path.join(tmp, "idx-"));
  seedPending(path.join(idx, "sizes-t.db"), 200_000);
  const seen: string[] = [];
  const restore = spyPrepare(seen);
  try {
    const app = createAgent(loadConfig({ FILEDECK_ROOT: tmp, FILEDECK_NODE: "t", FILEDECK_INDEX_DIR: idx, FILEDECK_FANWATCH: "/nonexistent-helper" } as never));
    (app as unknown as { startWatcher: () => void }).startWatcher();
  } finally {
    restore();
  }
  assert.deepEqual(seen.filter((q) => /\bpending\b/i.test(q) && !/LIMIT/i.test(q)), []);
});

test("200k idle pending rows: start and first drain read them only by index, the prune is an indexed batch", async () => {
  const idx = fs.mkdtempSync(path.join(tmp, "idx-"));
  const file = path.join(idx, "sizes-t.db");
  seedPending(file, 200_000, Number.MAX_SAFE_INTEGER, Date.now());
  const seen: string[] = [];
  const restore = spyPrepare(seen);
  try {
    const app = createAgent(loadConfig({ FILEDECK_ROOT: tmp, FILEDECK_NODE: "t", FILEDECK_INDEX_DIR: idx, FILEDECK_FANWATCH: "/nonexistent-helper" } as never));
    (app as unknown as { startWatcher: () => void }).startWatcher();
    await sleep(800); // past the first drain tick
  } finally {
    restore();
  }
  assert.deepEqual(seen.filter((q) => /\bpending\b/i.test(q) && !/LIMIT|MIN\(due_at\)/i.test(q)), []);
  // the writer's statements cannot be spied on: check their plans instead
  const db = new DatabaseSync(file);
  const plan = (q: string, ...a: number[]) => (db.prepare("EXPLAIN QUERY PLAN " + q).all(...a) as { detail: string }[]).map((r) => r.detail).join(" | ");
  const prune = plan("DELETE FROM pending WHERE path IN (SELECT path FROM pending WHERE due_at = ? AND taker IS NULL AND (last_run < ? OR last_run > ?) LIMIT ?)", 1, 2, 3, 4);
  const recent = plan("SELECT path FROM pending WHERE due_at = ? AND last_run >= ? LIMIT ?", 1, 2, 3);
  db.close();
  assert.doesNotMatch(prune, /SCAN pending(?! USING)/);
  assert.match(recent, /USING (COVERING )?INDEX pending_idle_run/);
});

test("clearPending deletes in bounded batches", async () => {
  const s = new SizeStore(":memory:", { root: tmp, ttlMs: 60_000, maxEntries: 100_000 });
  await s.notePending(Array.from({ length: 25_000 }, (_, i) => ({ path: "/p" + i, dueAt: 1, modify: false })), 1000);
  const seen: string[] = [];
  const restore = spyPrepare(seen);
  try {
    await s.clearPending();
  } finally {
    restore();
  }
  assert.deepEqual(seen.filter((q) => /DELETE/i.test(q) && !/LIMIT/i.test(q)), []);
  assert.equal(seen.filter((q) => /DELETE/i.test(q)).length, 3);
  assert.equal(((s as unknown as { db: DatabaseSync }).db.prepare("SELECT COUNT(*) n FROM pending").get() as { n: number }).n, 0);
  s.close();
});
