import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync, StatementSync } from "node:sqlite";
import { createRequire } from "node:module";
import { Worker } from "node:worker_threads";

/**
 * Persistent per-node index of directory listings and content hashes, kept in
 * SQLite so a second compare of the same trees is served mostly from disk.
 *
 * Freshness rules:
 *  - a listing is trusted as-is while an inotify watch on that directory has
 *    been live since it was read (any event marks it dirty);
 *  - without a live watch (beyond the watch budget, after a restart, network
 *    sources) it is trusted while the directory's inode and mtime are
 *    unchanged and the listing is younger than `ttlMs`: entries added, removed
 *    or renamed change the directory mtime, an in-place edit of a file does
 *    not, so a full re-read every `ttlMs` bounds that staleness (hashes are
 *    always checked against a fresh stat of the file);
 *  - everything else, and any directory a watch saw change, is re-read
 *    (readdir + lstat) and its stored rows are replaced;
 *  - a stored hash is reused only while (inode, size, mtime) of the file match
 *    what was hashed, so any change to size or mtime invalidates it.
 *
 * Watches are bounded (`maxWatches`, LRU) and never survive a restart, so after
 * a restart listings are revalidated once while hashes stay valid.
 */

export interface IdxEntry {
  n: string;
  t: "file" | "dir" | "symlink" | "other";
  s: number;
  m: number;
  /** inode (0 when the backend has none) */
  i: number;
  l?: string;
}

export interface DirReader {
  /** stat of the directory itself: inode (0 = unknown) and mtime in ms */
  statDir(p: string): Promise<{ ino: number; mtime: number }>;
  readDir(p: string): Promise<IdxEntry[]>;
  /** start watching a directory; returns a closer, or null when not supported */
  watch?(p: string, onChange: (name: string | null) => void): (() => void) | null;
}

export interface IndexStats {
  hits: number;
  misses: number;
  hashHits: number;
  hashMisses: number;
  watches: number;
}

let sqlite: typeof import("node:sqlite") | null | undefined;
function loadSqlite(): typeof import("node:sqlite") | null {
  if (sqlite !== undefined) return sqlite;
  try {
    // Loaded lazily (and without the ExperimentalWarning on stderr) so processes that never index never pay for it.
    const emit = process.emitWarning;
    process.emitWarning = ((w: string | Error, ...rest: unknown[]) => {
      if (String(typeof w === "string" ? w : w.message).includes("SQLite")) return;
      (emit as (...a: unknown[]) => void).call(process, w, ...rest);
    }) as typeof process.emitWarning;
    try {
      sqlite = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
    } finally {
      process.emitWarning = emit;
    }
  } catch {
    sqlite = null;
  }
  return sqlite;
}

/** Open a SQLite database tuned for a cache (WAL, relaxed sync, small page cache). Null when SQLite is unavailable. */
export function openDb(file: string, cacheKiB = 8192, scratch = false): DatabaseSync | null {
  const s = loadSqlite();
  if (!s) return null;
  if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new s.DatabaseSync(file);
  // A scratch file (compare spill) is thrown away on restart: no journal, no syncs. A cache keeps WAL (a process crash cannot
  // corrupt it) without syncs (an OS crash might; IndexCache then starts a fresh file).
  db.exec(scratch ? `PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF; PRAGMA locking_mode=EXCLUSIVE;` : `PRAGMA journal_mode=WAL; PRAGMA synchronous=OFF; PRAGMA busy_timeout=2000;`);
  db.exec(`PRAGMA temp_store=FILE; PRAGMA cache_size=-${cacheKiB};`);
  return db;
}

export interface ChangeEvent {
  seq: number;
  /** directory path that changed */
  dir: string;
}

export class IndexCache {
  readonly stats: IndexStats = { hits: 0, misses: 0, hashHits: 0, hashMisses: 0, watches: 0 };
  private db: DatabaseSync | null = null;
  private q!: {
    dirGet: StatementSync;
    dirPut: StatementSync;
    entList: StatementSync;
    entDel: StatementSync;
    dirDel: StatementSync;
    entPut: StatementSync;
    hashGet: StatementSync;
    hashPut: StatementSync;
    touch: StatementSync;
  };
  /** directories with a live watch, in LRU order; value = closer */
  private watched = new Map<string, () => void>();
  /** directories whose watch fired since they were last read */
  private dirty = new Set<string>();
  private journal: ChangeEvent[] = [];
  private seq = 0;
  private listeners = new Set<(e: ChangeEvent) => void>();
  private timer: NodeJS.Timeout | undefined;
  private flushTimer: NodeJS.Timeout | undefined;
  private touched = new Set<string>();
  private file: string;
  private trimming: Promise<{ removed: number }> | null = null;
  /** per-directory write chain: two reads of one directory never interleave their batches */
  private dirWrites = new Map<string, Promise<void>>();

  constructor(
    file: string,
    private reader: DirReader,
    private o: { maxWatches?: number; ttlMs?: number; maxEntries?: number; trimMs?: number } = {},
  ) {
    const schema = `
      CREATE TABLE IF NOT EXISTS dirs (path TEXT PRIMARY KEY, ino INTEGER, mtime REAL, listed_at INTEGER, used_at INTEGER) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS ents (dir TEXT, name TEXT, t TEXT, s INTEGER, m INTEGER, ino INTEGER, l TEXT, hash TEXT, PRIMARY KEY (dir, name)) WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS dirs_used ON dirs(used_at);
    `;
    this.file = file;
    for (let attempt = 0; attempt < 2 && !this.db; attempt++) {
      try {
        const db = openDb(file);
        if (!db) break;
        db.exec(schema);
        db.prepare("SELECT count(*) FROM dirs WHERE path = ''").get();
        this.db = db;
      } catch (e) {
        // A damaged cache is only a cache: start over with an empty one.
        console.error("index cache reset:", (e as Error).message);
        if (file !== ":memory:") for (const f of [file, file + "-wal", file + "-shm"]) fs.rmSync(f, { force: true });
      }
    }
    if (!this.db) return;
    const p = (s: string) => (this.db as DatabaseSync).prepare(s);
    this.q = {
      dirGet: p("SELECT ino, mtime, listed_at FROM dirs WHERE path = ?"),
      dirPut: p("INSERT INTO dirs (path, ino, mtime, listed_at, used_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(path) DO UPDATE SET ino = excluded.ino, mtime = excluded.mtime, listed_at = excluded.listed_at, used_at = excluded.used_at"),
      entList: p("SELECT name, t, s, m, ino, l, hash FROM ents WHERE dir = ?"),
      entDel: p("DELETE FROM ents WHERE dir = ?"),
      dirDel: p("DELETE FROM dirs WHERE path = ?"),
      // Upsert: the listing is written in batches (see list()), so a hash stored meanwhile may already hold the row.
      entPut: p("INSERT INTO ents (dir, name, t, s, m, ino, l, hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(dir, name) DO UPDATE SET t = excluded.t, s = excluded.s, m = excluded.m, ino = excluded.ino, l = excluded.l, hash = excluded.hash"),
      hashGet: p("SELECT hash FROM ents WHERE dir = ? AND name = ? AND s = ? AND m = ? AND ino = ? AND hash IS NOT NULL"),
      hashPut: p("INSERT INTO ents (dir, name, t, s, m, ino, l, hash) VALUES (?, ?, 'file', ?, ?, ?, NULL, ?) ON CONFLICT(dir, name) DO UPDATE SET s = excluded.s, m = excluded.m, ino = excluded.ino, hash = excluded.hash"),
      touch: p("UPDATE dirs SET used_at = ? WHERE path = ?"),
    };
    // Trimming scans the whole index (hundreds of MB on a busy node): rare, and never on the event loop (see trimAsync).
    this.timer = setInterval(() => void this.trimAsync(), this.o.trimMs ?? 60 * 60_000);
    this.timer.unref?.();
    this.flushTimer = setInterval(() => this.flushTouched(), 30_000);
    this.flushTimer.unref?.();
  }

  get enabled() {
    return this.db !== null;
  }

  /** List one directory, from the index when it is provably fresh, else from the backend (and store it). */
  async list(dir: string): Promise<{ entries: IdxEntry[]; cached: boolean }> {
    const db = this.db;
    if (!db) {
      this.stats.misses++;
      return { entries: await this.reader.readDir(dir), cached: false };
    }
    const now = Date.now();
    const row = this.q.dirGet.get(dir) as { ino: number; mtime: number; listed_at: number } | undefined;
    if (row) {
      let fresh = false;
      if (this.watched.has(dir) && !this.dirty.has(dir)) fresh = true;
      else if (this.o.ttlMs && !this.dirty.has(dir) && now - row.listed_at < this.o.ttlMs) {
        const st = await this.reader.statDir(dir);
        fresh = st.mtime === row.mtime && st.ino === row.ino && st.mtime > 0;
      }
      if (fresh) {
        this.stats.hits++;
        this.touched.add(dir); // written in one batch later: a hit must not wait for a disk write
        this.bumpWatch(dir);
        const rows = this.q.entList.all(dir) as { name: string; t: IdxEntry["t"]; s: number; m: number; ino: number; l: string | null }[];
        return { entries: rows.map((r) => ({ n: r.name, t: r.t, s: r.s, m: r.m, i: r.ino, ...(r.l !== null ? { l: r.l } : {}) })), cached: true };
      }
    }
    this.stats.misses++;
    // Watch before reading so a change during the read marks the fresh listing dirty again.
    this.dirty.delete(dir);
    this.ensureWatch(dir);
    const st = await this.reader.statDir(dir);
    let entries: IdxEntry[];
    try {
      entries = await this.reader.readDir(dir);
    } catch (e) {
      this.unwatch(dir);
      throw e;
    }
    // Keep hashes whose file did not change (same inode, size and mtime).
    const old = new Map<string, { s: number; m: number; ino: number; hash: string | null }>();
    for (const r of this.q.entList.all(dir) as { name: string; s: number; m: number; ino: number; hash: string | null }[]) if (r.hash) old.set(r.name, r);
    await this.store(dir, entries, old, st, now);
    return { entries, cached: false };
  }

  /**
   * Replace a directory's stored rows. Written in bounded batches with a yield between them, so a directory of tens of
   * thousands of entries never holds the event loop (and /healthz) for the whole write. The directory's own row is
   * dropped first and written last: a crash or a failure midway leaves a listing nobody trusts, never a half one.
   */
  private async store(dir: string, entries: IdxEntry[], old: Map<string, { s: number; m: number; ino: number; hash: string | null }>, st: { ino: number; mtime: number }, now: number) {
    const db = this.db;
    if (!db) return;
    const prev = this.dirWrites.get(dir);
    const mine = (async () => {
      await prev?.catch(() => undefined);
      const tx = (fn: () => void) => {
        db.exec("BEGIN");
        try {
          fn();
          db.exec("COMMIT");
        } catch (e) {
          try {
            db.exec("ROLLBACK");
          } catch {
            /* nothing open */
          }
          throw e;
        }
      };
      tx(() => {
        this.q.dirDel.run(dir);
        this.q.entDel.run(dir);
      });
      const BATCH = 500;
      for (let i = 0; i < entries.length; i += BATCH) {
        if (i > 0) await new Promise<void>((r) => setImmediate(r));
        if (!this.db) return; // closed meanwhile
        tx(() => {
          for (const e of entries.slice(i, i + BATCH)) {
            const o = old.get(e.n);
            const hash = o && o.s === e.s && o.m === e.m && o.ino === e.i && e.t === "file" ? o.hash : null;
            this.q.entPut.run(dir, e.n, e.t, e.s, e.m, e.i, e.l ?? null, hash);
          }
        });
      }
      tx(() => void this.q.dirPut.run(dir, st.ino, st.mtime, now, now));
    })();
    this.dirWrites.set(dir, mine);
    try {
      await mine;
    } finally {
      if (this.dirWrites.get(dir) === mine) this.dirWrites.delete(dir);
    }
  }

  /** Stored hash for a file whose (size, mtime, inode) still match, else compute it with `compute` and store it. */
  async hash(file: string, st: { size: number; mtime: number; ino: number }, compute: () => Promise<string>): Promise<{ sha256: string; cached: boolean }> {
    const dir = path.posix.dirname(file);
    const name = path.posix.basename(file);
    if (this.db) {
      const r = this.q.hashGet.get(dir, name, st.size, st.mtime, st.ino) as { hash: string } | undefined;
      if (r) {
        this.stats.hashHits++;
        return { sha256: r.hash, cached: true };
      }
    }
    this.stats.hashMisses++;
    const sha256 = await compute();
    try {
      this.q?.hashPut.run(dir, name, st.size, st.mtime, st.ino, sha256);
    } catch {
      /* cache only */
    }
    return { sha256, cached: false };
  }

  /** Change feed: every watch event since `since` (bounded journal), or a reset flag when the journal moved on. */
  changes(since: number): { seq: number; dirs: string[]; reset: boolean } {
    const first = this.journal[0]?.seq ?? this.seq + 1;
    const reset = since > 0 && since < first - 1;
    const dirs = [...new Set(this.journal.filter((e) => e.seq > since).map((e) => e.dir))];
    return { seq: this.seq, dirs, reset };
  }
  onChange(fn: (e: ChangeEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  /** Distrust every stored listing (and optionally every hash, for backends whose mtimes are too coarse to key on). Used after writes through this process. */
  invalidateListings(hashesToo = false) {
    try {
      this.db?.exec("UPDATE dirs SET listed_at = 0");
      if (hashesToo) this.db?.exec("UPDATE ents SET hash = NULL WHERE hash IS NOT NULL");
    } catch {
      /* cache only */
    }
    for (const d of this.watched.keys()) this.dirty.add(d);
  }
  /** Keep a directory watched (used by live compares for directories they show). */
  watchDir(dir: string) {
    this.ensureWatch(dir);
  }

  private ensureWatch(dir: string) {
    if (!this.reader.watch) return;
    if (this.watched.has(dir)) return this.bumpWatch(dir);
    const max = this.o.maxWatches ?? 4096;
    while (this.watched.size >= max) {
      const oldest = this.watched.keys().next().value as string;
      this.unwatch(oldest);
    }
    let close: (() => void) | null = null;
    try {
      close = this.reader.watch(dir, () => this.fire(dir));
    } catch {
      close = null;
    }
    if (close) {
      this.watched.set(dir, close);
      this.stats.watches = this.watched.size;
    }
  }
  private bumpWatch(dir: string) {
    const c = this.watched.get(dir);
    if (!c) return;
    this.watched.delete(dir);
    this.watched.set(dir, c);
  }
  private unwatch(dir: string) {
    const c = this.watched.get(dir);
    if (!c) return;
    this.watched.delete(dir);
    this.stats.watches = this.watched.size;
    try {
      c();
    } catch {
      /* already gone */
    }
  }
  private fire(dir: string) {
    this.dirty.add(dir);
    const e = { seq: ++this.seq, dir };
    this.journal.push(e);
    if (this.journal.length > 4096) this.journal.splice(0, this.journal.length - 4096);
    for (const l of this.listeners) l(e);
  }

  private flushTouched() {
    if (!this.db || !this.touched.size) return;
    const now = Date.now();
    try {
      this.db.exec("BEGIN");
      for (const d of this.touched) this.q.touch.run(now, d);
      this.db.exec("COMMIT");
    } catch {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        /* nothing open */
      }
    }
    this.touched.clear();
  }

  /**
   * Drop the least recently used directories beyond the entry ceiling, and anything unused for 30 days.
   * On a file-backed index this runs in a worker thread with its own connection (WAL lets it read and delete next to the
   * main one): counting and deleting millions of rows is synchronous SQLite work that, on the event loop, froze /healthz
   * for minutes on a loaded disk and got the agent killed by its liveness probe every ten minutes. The worker deletes in
   * small transactions with pauses, so the main connection's busy wait (writes) stays short. An in-memory index (tests)
   * is small and is trimmed in place.
   */
  trimAsync(): Promise<{ removed: number }> {
    if (!this.db) return Promise.resolve({ removed: 0 });
    if (this.trimming) return this.trimming;
    const max = this.o.maxEntries ?? 5_000_000;
    const old = Date.now() - 30 * 86400_000;
    const run = this.file === ":memory:" ? Promise.resolve({ removed: this.trim() }) : runTrimWorker(this.file, old, max);
    const p = run
      .catch((e: Error) => {
        console.error("index trim failed:", e.message);
        return { removed: 0 };
      })
      .finally(() => {
        this.trimming = null;
      });
    this.trimming = p;
    return p;
  }

  /** Synchronous trim (in-memory index and tests only: it scans the whole table). Returns the number of directories dropped. */
  trim(): number {
    const db = this.db;
    if (!db) return 0;
    let dropped = 0;
    try {
      const old = Date.now() - 30 * 86400_000;
      db.prepare("DELETE FROM ents WHERE dir IN (SELECT path FROM dirs WHERE used_at < ?)").run(old);
      dropped += Number(db.prepare("DELETE FROM dirs WHERE used_at < ?").run(old).changes);
      const max = this.o.maxEntries ?? 5_000_000;
      const n = (db.prepare("SELECT count(*) AS n FROM ents").get() as { n: number }).n;
      if (n > max) {
        const victims = db.prepare("SELECT path FROM dirs ORDER BY used_at LIMIT ?").all(Math.max(100, Math.ceil(((n - max) / Math.max(1, n)) * 1.2 * this.dirCount()))) as { path: string }[];
        db.exec("BEGIN");
        for (const v of victims) {
          this.q.entDel.run(v.path);
          this.q.dirDel.run(v.path);
          dropped++;
        }
        db.exec("COMMIT");
      }
      db.exec("PRAGMA wal_checkpoint(PASSIVE)");
    } catch (e) {
      console.error("index trim failed:", (e as Error).message);
    }
    return dropped;
  }
  private dirCount() {
    return (this.db?.prepare("SELECT count(*) AS n FROM dirs").get() as { n: number } | undefined)?.n ?? 0;
  }

  close() {
    clearInterval(this.timer);
    clearInterval(this.flushTimer);
    this.flushTouched();
    for (const d of [...this.watched.keys()]) this.unwatch(d);
    try {
      this.db?.close();
    } catch {
      /* closed */
    }
    this.db = null;
  }
}

/**
 * Body of the trim worker: plain JavaScript (it is evaluated as a worker, so it works the same from the compiled output
 * and from tsx). Deletes in small transactions with pauses; never checkpoints more than PASSIVE.
 */
const TRIM_WORKER = `
process.emitWarning = () => {};
const { workerData, parentPort } = require("node:worker_threads");
const { DatabaseSync } = require("node:sqlite");
const { file, old, max } = workerData;
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const db = new DatabaseSync(file);
db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=OFF; PRAGMA busy_timeout=2000; PRAGMA cache_size=-4096");
const entDel = db.prepare("DELETE FROM ents WHERE dir = ?");
const dirDel = db.prepare("DELETE FROM dirs WHERE path = ?");
let removed = 0;
const drop = (rows) => {
  db.exec("BEGIN");
  try {
    let n = 0;
    for (const r of rows) { n += Number(entDel.run(r.path).changes); dirDel.run(r.path); removed++; }
    db.exec("COMMIT");
    return n;
  } catch (e) { try { db.exec("ROLLBACK"); } catch {} throw e; }
};
const stale = db.prepare("SELECT path FROM dirs WHERE used_at < ? LIMIT 20");
for (;;) { const rows = stale.all(old); if (!rows.length) break; drop(rows); sleep(20); }
const n = db.prepare("SELECT count(*) AS n FROM ents").get().n;
if (n > max) {
  let excess = n - Math.floor(max * 0.9);
  const lru = db.prepare("SELECT path FROM dirs ORDER BY used_at LIMIT 20");
  while (excess > 0) { const rows = lru.all(); if (!rows.length) break; excess -= drop(rows); sleep(20); }
}
db.exec("PRAGMA wal_checkpoint(PASSIVE)");
db.close();
parentPort.postMessage({ removed });
`;

function runTrimWorker(file: string, old: number, max: number): Promise<{ removed: number }> {
  return new Promise((resolve, reject) => {
    const w = new Worker(TRIM_WORKER, { eval: true, workerData: { file, old, max }, resourceLimits: { maxOldGenerationSizeMb: 64 }, stdout: false, stderr: false });
    w.unref();
    w.once("message", (m: { removed: number }) => resolve(m));
    w.once("error", reject);
    w.once("exit", (code) => (code === 0 ? resolve({ removed: 0 }) : reject(new Error(`trim worker exit ${code}`))));
  });
}
