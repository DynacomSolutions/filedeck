import fs from "node:fs/promises";
import { rmSync, type Dir, type Stats } from "node:fs";
import path from "node:path";
import type { DatabaseSync, StatementSync } from "node:sqlite";
import { Worker } from "node:worker_threads";
import { openDb } from "./index-cache.ts";
import { FsError } from "./fsops.ts";
import { TRASH_DIR, resolveRead, virtualJoin } from "./paths.ts";
import type { JobCtl } from "./jobs.ts";
import type { SizeResult } from "./props.ts";

/**
 * Persistent per-node store of folder sizes: one row per folder (never per file) holding the
 * folder's own stats (direct children that are not folders) and the rolled-up totals of its subtree,
 * so a `du` of an unchanged tree is a few lookups instead of a walk.
 *
 * Freshness rules (the same as the compare index, see index-cache.ts):
 *  - a stored folder is reused while its inode and mtime match a fresh `stat` and it was scanned less
 *    than `ttlMs` ago: entries added, removed or renamed change the folder mtime, an in-place edit of a
 *    file does not. Without the change watcher (fanwatch.ts) the own stats can therefore be stale up to `ttlMs`;
 *  - everything else is re-read (opendir + lstat) and its row replaced; the stored child folders it no longer has are dropped
 *    (every row a walk writes or confirms is stamped `seen_at` = the walk's stamp (strictly increasing per store), so stale children are the ones with another stamp;
 *    `scanned_at` is left alone on a reused row, it is what the TTL counts from);
 *  - a scan is never cut short and never partial; its memory use follows the depth of the tree, not its size (see `walk`).
 *
 * Like `folderSize` before it: symlinks are not followed, other devices are not entered, the trash
 * store is skipped. Hard links are counted once per link (unlike du).
 */

const METRICS = ["bytes", "disk", "files", "symlinks", "other", "dirs", "mounts", "errors"] as const;
type Metric = (typeof METRICS)[number];
type Sums = Record<Metric, number>;
const zero = (): Sums => ({ bytes: 0, disk: 0, files: 0, symlinks: 0, other: 0, dirs: 0, mounts: 0, errors: 0 });
const addTo = (a: Sums, b: Sums, sign = 1) => {
  for (const m of METRICS) a[m] += sign * b[m];
};

interface Row {
  path: string;
  parent: string;
  ino: number;
  dev: number;
  mtime_ms: number;
  scanned_at: number;
  /** start of the latest walk that wrote or confirmed this row (0 = unknown, rows of older versions) */
  seen_at: number;
  own: Sums;
  tot: Sums;
  /** number of stored child folders on its own device, when the read that gave this row counted them */
  kids?: number;
}

/** One folder of an in-flight walk. `fixed` = a stored row taken as-is (its subtree is not walked). */
interface Node extends Row {
  reused: boolean;
  /** a re-read folder that had stored child rows: its commit drops the ones this walk did not see (none stored: nothing to look for) */
  purge?: boolean;
  /** only `seen_at` is refreshed (a stored child taken as-is); the row is not rewritten */
  touch?: boolean;
  /** the folder this one rolls up into */
  up?: Node;
}

/** A child folder handed out by a frame; `stored` = its row when the frame already read it (null = not stored), undefined = not read yet. */
interface Child {
  virtual: string;
  real: string;
  s: Stats;
  stored?: Row | null;
}

/** One level of the walk: the folder and a cursor over its children (an open Dir, or pages of stored rows). */
interface Frame {
  node: Node;
  /** the next child folder to walk, null when there are no more */
  next(): Promise<Child | null>;
  close(): Promise<void>;
}

interface Walk {
  root: Row;
  /** folders read from disk (not reused from the store) */
  read: number;
}

export interface DuEntry {
  path: string;
  type: "dir" | "file" | "symlink" | "other";
  bytes: number;
  diskBytes: number;
  files: number;
  dirs: number;
  /** folders only */
  scannedAt?: number;
}

/** folders written per transaction when a scan is stored */
/** rows kept in memory in total (all remembered walks) while the database is unusable, whatever `maxEntries` says: a big scan must not fill the heap */
const FALLBACK_ROWS = 20_000;
const COMMIT_CHUNK = 5000;
/** the writer truncates its WAL file once it is bigger than this */
const WAL_LIMIT = 64 << 20;
/** child entries lstat-ed at once, and stored child rows fetched at once */
const BATCH = 32;
const PAGE = 256;
/** deepest folder a size walk enters (one open Dir per level); deeper folders count as an error */
const DU_MAX_DEPTH = 256;
/** directory sizes grow with the entry count (ext4, xfs, btrfs, tmpfs), so a small one holds few names */
/** stored child rows (with their stats) kept from the reuse check for the walk that follows it */
const CACHED = 1024;
const STREAM_ABOVE = 256 * 1024;
/** Runs at most `n` async tasks at once (the rest wait in line, `queued` counts them). */
export function limiter(n: number) {
  let run = 0;
  const line: (() => void)[] = [];
  const pump = () => {
    while (run < n && line.length) {
      run++;
      line.shift()!();
    }
  };
  const lim = <T,>(f: () => Promise<T>) =>
    new Promise<T>((res, rej) => {
      line.push(() =>
        f().then(res, rej).finally(() => {
          run--;
          pump();
        }),
      );
      pump();
    });
  return Object.assign(lim, { get queued() { return line.length; } });
}
/** folders read ahead at once, and how many may wait before further read-ahead is dropped */
const AHEAD = 32;
const AHEAD_QUEUE = 256;
const AHEAD_NAMES = 64;
/** taken at load: read-ahead listings are not the walk's own reads (tests count those on `fs.readdir`) */
const listAhead = fs.readdir;
const tick = () => new Promise<void>((r) => setImmediate(r));
/** commits that may be in flight while the walk goes on (the walk waits for the oldest one only when this many are queued) */
const COMMITS_IN_FLIGHT = 2;
const SLOW_SEND_MS = 1000;
const SLOW_READ_MS = 200;
let lastSlowLog = 0;
/** One structured line for a slow store call, at most one every 5 s; no file names but the scan's own path. */
function slowLog(what: string, ms: number, path: string) {
  if (Date.now() - lastSlowLog < 5000) return;
  lastSlowLog = Date.now();
  console.error(JSON.stringify({ slow: what, ms: Math.round(ms), path }));
}
const KIDS = "(SELECT COUNT(*) FROM sizes k WHERE k.parent = s.path AND k.dev = s.dev) AS kids";
const SQL = {
  get: "SELECT * FROM sizes WHERE path = ?",
  kidPage: `SELECT s.*, ${KIDS} FROM sizes s WHERE s.parent = ? AND s.dev = ? AND s.path > ? ORDER BY s.path LIMIT ?`,
  getKids: `SELECT s.*, ${KIDS} FROM sizes s WHERE s.path = ?`,
  getMany: (n: number) => `SELECT s.*, ${KIDS} FROM sizes s WHERE s.path IN (${Array(n).fill("?").join(",")})`,
};
const SCHEMA = `
  CREATE TABLE IF NOT EXISTS sizes (
    path TEXT PRIMARY KEY, parent TEXT NOT NULL, ino REAL, dev REAL, mtime_ms REAL, scanned_at INTEGER, seen_at INTEGER NOT NULL DEFAULT 0,
    ${METRICS.map((m) => `own_${m} INTEGER NOT NULL`).join(", ")}, ${METRICS.map((m) => `tot_${m} INTEGER NOT NULL`).join(", ")}
  ) WITHOUT ROWID;
  CREATE INDEX IF NOT EXISTS sizes_parent ON sizes(parent);
  CREATE TABLE IF NOT EXISTS pending (path TEXT PRIMARY KEY, due_at INTEGER NOT NULL, last_run INTEGER) WITHOUT ROWID;
  CREATE INDEX IF NOT EXISTS pending_due ON pending(due_at);
  CREATE INDEX IF NOT EXISTS pending_idle_run ON pending(due_at, last_run);
`;
const ADD_SEEN_AT = "ALTER TABLE sizes ADD COLUMN seen_at INTEGER NOT NULL DEFAULT 0";
const noCtl = (): JobCtl => ({ signal: new AbortController().signal, progress: { bytes: 0, totalBytes: 0, entries: 0, totalEntries: 0, current: "" } });
const parentOf = (p: string) => (p === "/" ? "" : path.posix.dirname(p));
/** Exclusive bounds of every path below `p` (the character after "/" is "0"). */
const below = (p: string) => {
  const pre = p === "/" ? "/" : p + "/";
  return [pre, pre.slice(0, -1) + "0"] as const;
};

const COLS = ["path", "parent", "ino", "dev", "mtime_ms", "scanned_at", "seen_at", ...METRICS.map((m) => `own_${m}`), ...METRICS.map((m) => `tot_${m}`)];

/**
 * Body of the writer worker (plain JavaScript, evaluated as a worker like index-cache.ts's trim worker). Stores of a
 * scan are synchronous SQLite work; on a busy disk one chunk blocks for seconds, which on the main thread starved
 * /healthz and got the agent killed by its liveness probe. Messages: {id, op: "commit", items, last} writes folder rows
 * (see SizeStore.commitInline for the same logic on an in-memory store) and {id, op: "exec", sql, params} runs one statement.
 */
const WRITER_WORKER = `
process.emitWarning = () => {};
const { workerData, parentPort } = require("node:worker_threads");
const { DatabaseSync } = require("node:sqlite");
const { file, COLS, METRICS, walLimit, reader, readDelayMs, schema, addSeenAt } = workerData;
const fs = require("node:fs");
const db = new DatabaseSync(file);
db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=OFF; PRAGMA busy_timeout=10000; PRAGMA cache_size=-8192; PRAGMA journal_size_limit=" + walLimit);
// the reader worker only runs "read" ops: a second connection, so a read never waits behind a commit (WAL) and the main thread never waits for the disk
// A reader holding a snapshot stops the automatic (passive) checkpoint from restarting the WAL, which then grows without bound and slows every read and commit.
// Past the limit, wait briefly for readers and truncate; a busy attempt is skipped and tried again 2 s later, so a pinned snapshot costs the writer at most 0.5 s in 2.5.
let lastTrim = 0;
const trim = () => {
  if (Date.now() - lastTrim < 2000) return;
  try { if (fs.statSync(file + "-wal").size <= walLimit) return; } catch { return; }
  lastTrim = Date.now();
  try { db.exec("PRAGMA busy_timeout=500"); db.exec("PRAGMA wal_checkpoint(TRUNCATE)"); } catch {} finally { db.exec("PRAGMA busy_timeout=10000"); }
};
const put = db.prepare("INSERT OR REPLACE INTO sizes (" + COLS.join(",") + ") VALUES (" + COLS.map(() => "?").join(",") + ")");
const stale = db.prepare("SELECT path FROM sizes WHERE parent = ? AND dev = ? AND seen_at <> ? AND path > ? ORDER BY path LIMIT 256");
const touch = db.prepare("UPDATE sizes SET seen_at = ? WHERE path = ?");
const get = db.prepare("SELECT * FROM sizes WHERE path = ?");
const delTree = db.prepare("DELETE FROM sizes WHERE path = ? OR (path > ? AND path < ?)");
const parentOf = (p) => (p === "/" ? "" : p.slice(0, p.lastIndexOf("/")) || "/");
const below = (p) => { const pre = p === "/" ? "/" : p + "/"; return [pre, pre.slice(0, -1) + "0"]; };
const commit = ({ items, last }) => {
  db.exec("BEGIN");
  try {
    const old = last ? get.get(last.path) : undefined;
    for (const it of items) {
      if (it.touch != null) { touch.run(it.touch, it.path); continue; }
      if (it.purge != null) for (let after = "";;) { const r = stale.all(it.path, it.dev, it.purge, after); if (!r.length) break; for (const k of r) delTree.run(k.path, ...below(k.path)); after = r[r.length - 1].path; }
      put.run(...it.row);
    }
    if (old) {
      const anc = [];
      for (let a = parentOf(last.path); a; a = parentOf(a)) { const r = get.get(a); if (!r) continue; if (Number(r.dev) !== last.dev) break; anc.push(a); }
      if (anc.length) {
        const set = METRICS.map((m) => "tot_" + m + " = tot_" + m + " + " + Math.trunc(last.tot[m] - Number(old["tot_" + m]))).join(", ");
        db.prepare("UPDATE sizes SET " + set + " WHERE path IN (" + anc.map(() => "?").join(",") + ")").run(...anc);
      }
    }
    db.exec("COMMIT");
  } catch (e) { try { db.exec("ROLLBACK"); } catch {} throw e; }
};
const prepared = new Map();
const isBusy = (e) => !!e && (e.errcode === 5 || e.errcode === 6 || /database (table )?is locked/i.test(String(e.message)));
const nap = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
parentPort.on("message", (m) => {
  // a busy database (another connection holds a lock past busy_timeout) is retried a few times with backoff; every op rolls back on failure, so a retry is safe
  for (let attempt = 0; ; attempt++) {
    try {
      if (m.op === "schema") { db.exec(schema); if (!db.prepare("PRAGMA table_info(sizes)").all().some((c) => c.name === "seen_at")) db.exec(addSeenAt); }
      else if (m.op === "read") { if (readDelayMs) nap(readDelayMs); let st = prepared.get(m.sql); if (!st) prepared.set(m.sql, st = db.prepare(m.sql)); parentPort.postMessage({ id: m.id, rows: st.all(...m.params) }); return; }
      else if (m.op === "commit") commit(m);
      else if (m.op === "many") { const st = db.prepare(m.sql); db.exec("BEGIN"); try { for (const r of m.rows) st.run(...r); db.exec("COMMIT"); } catch (e) { try { db.exec("ROLLBACK"); } catch {} throw e; } }
      else db.prepare(m.sql).run(...m.params);
      if (!reader) trim();
      parentPort.postMessage({ id: m.id });
      return;
    } catch (e) {
      if (isBusy(e) && attempt < 3) { console.error(JSON.stringify({ slow: "size-writer-busy", op: m.op, attempt, retryMs: 250 << attempt })); nap(250 << attempt); continue; }
      parentPort.postMessage({ id: m.id, err: String(e && e.message || e), busy: isBusy(e) });
      return;
    }
  }
});
`;

/** `pending.due_at` of a folder that is not waiting but remembers its `last_run` */
const PENDING_IDLE = Number.MAX_SAFE_INTEGER;
const PENDING_BATCH = 10_000;

export class SizeStore {
  /** null once the store is unusable: scans then walk without caching (same results, never `cached`) */
  private db: DatabaseSync | null = null;
  private q!: Record<"get" | "put" | "kidPage" | "getKids" | "touch" | "delTree", StatementSync>;
  /** deepest frame stack of the latest walk (tests: memory follows depth, not width) */
  lastWalkFrames = 0;
  private held: { path: string; done: Promise<void> }[] = [];
  private file = ":memory:";
  private writer?: Worker;
  private reader?: Worker;
  private io = limiter(AHEAD);
  private pending = new Map<number, { w: Worker; res: (rows?: Record<string, unknown>[]) => void; rej: (e: Error) => void }>();
  private seq = 0;
  /** the latest `write`: a walk waits for it so it never reads rows a stale mark is about to change */
  private tail: Promise<void> = Promise.resolve();
  private warned = false;
  /** last `seen_at` stamp handed to a walk: strictly increasing, so a clock step back or two walks in one millisecond never share one */
  private stamp = 0;
  /** nodes of the latest walks (up to maxEntries rows in total), kept only while the database is unusable so `tree` can still answer */
  private walks: Map<string, Row>[] = [];

  constructor(
    file: string,
    private o: { root: string; ttlMs: number; /** cap on rows `tree` returns and on rows remembered while uncached */ maxEntries: number; commitChunk?: number; /** tests: every read on the worker sleeps this long, to show the main thread is not held */ readDelayMs?: number; walLimitBytes?: number; /** folders whose own size is above this are streamed with opendir, smaller ones read with one readdir (tests set it) */ streamAbove?: number },
  ) {
    this.file = file;
    // Like IndexCache: a file that cannot be opened is replaced once, then the store runs uncached.
    for (let attempt = 0; attempt < 2 && !this.db; attempt++) {
      try {
        this.open(file);
      } catch (e) {
        this.db = null;
        try {
          if (attempt === 0 && file !== ":memory:") for (const f of [file, file + "-wal", file + "-shm"]) rmSync(f, { force: true });
        } catch {
          attempt = 1; // cannot clear it: no second try
        }
        if (attempt === 1) this.warn(e);
      }
    }
    if (!this.db) {
      this.warn(new Error("SQLite is unavailable"));
      this.retryAt = Date.now() + this.retryDelay;
    }
  }

  private open(file: string) {
    const db = openDb(file);
    if (!db) throw new Error("SQLite is unavailable");
    try {
      // a long wait here blocks the event loop (and /healthz); a miss only means a re-read from disk
      db.exec("PRAGMA busy_timeout=100");
      db.exec(SCHEMA);
      // stores of older versions have no seen_at
      if (!db.prepare("PRAGMA table_info(sizes)").all().some((c) => c.name === "seen_at")) db.exec(ADD_SEEN_AT);
      // Never MAX(seen_at): that scans the whole table before the server listens. A stamp only has to differ from earlier walks' stamps;
      // a clock stepped back can only make a stale child look current until its next re-read, never purge a live one.
      this.stamp = Math.max(this.stamp, Date.now());
      this.q = {
        get: db.prepare(SQL.get),
        put: db.prepare(`INSERT OR REPLACE INTO sizes (${COLS.join(",")}) VALUES (${COLS.map(() => "?").join(",")})`),
        kidPage: db.prepare(SQL.kidPage),
        getKids: db.prepare(SQL.getKids),
        touch: db.prepare("UPDATE sizes SET seen_at = ? WHERE path = ?"),
        delTree: db.prepare("DELETE FROM sizes WHERE path = ? OR (path > ? AND path < ?)"),
      };
    } catch (e) {
      db.close();
      throw e;
    }
    this.db = db;
  }

  private warn(e: unknown) {
    if (this.warned) return;
    this.warned = true;
    console.error("size store unavailable, folder sizes are not cached:", (e as Error)?.message ?? e);
  }

  /** A locked database ("database is locked", SQLITE_BUSY / SQLITE_LOCKED): another connection holds it for a moment, nothing is broken. */
  private isBusy(e: unknown): boolean {
    const x = e as { busy?: boolean; errcode?: number; message?: string } | null;
    return !!x && (x.busy === true || x.errcode === 5 || x.errcode === 6 || /database (table )?is locked/i.test(String(x.message)));
  }

  private lastBusyNote = 0;
  private busyNote(e: unknown) {
    if (Date.now() - this.lastBusyNote < 60_000) return;
    this.lastBusyNote = Date.now();
    console.error("size store busy, answering without the cache:", (e as Error)?.message ?? e);
  }

  /** A failed database call: a busy database is a cache miss (noted at most once a minute), anything else gives the store up. */
  private failed(e: unknown) {
    if (this.isBusy(e)) this.busyNote(e);
    else this.giveUp(e);
  }

  /** Run a database operation; a busy database answers `dflt` for this call, any other failure gives the database up (logged once) and answers `dflt`. */
  private safe<T>(fn: () => T, dflt: T): T {
    if (!this.db) return dflt;
    try {
      return fn();
    } catch (e) {
      this.failed(e);
      return dflt;
    }
  }

  private retryAt = 0;
  private retryDelay = 30_000;
  /** After a real failure, open the store again (30 s, then doubling to 10 min between tries) so one bad moment does not last until restart. */
  private reopening?: Promise<void>;
  private reopen(): Promise<void> | undefined {
    if (this.db || this.file === ":memory:" || !this.retryAt || Date.now() < this.retryAt) return;
    return (this.reopening ??= (async () => {
      try {
        // the schema is checked on the writer thread; the main handle is then only a liveness flag (an empty in-memory one): every read and write goes to the workers
        await this.post({ op: "schema" }, false);
        if (this.closed) return;
        this.db = openDb(":memory:");
        this.stamp = Math.max(this.stamp, Date.now());
        this.warned = false;
        this.retryDelay = 30_000;
        console.error("size store back");
      } catch {
        this.retryDelay = Math.min(this.retryDelay * 2, 600_000);
        this.retryAt = Date.now() + this.retryDelay;
      } finally {
        this.reopening = undefined;
      }
    })());
  }

  private giveUp(e: unknown) {
    this.retryAt = Date.now() + this.retryDelay;
    this.warn(e);
    try {
      this.db?.close();
    } catch {
      /* already broken */
    }
    this.db = null;
  }

  /** Run one request on the writer worker (started on first use), or on the read worker; a file-backed store only. */
  private send(m: Record<string, unknown>): Promise<void> {
    return this.post(m, false).then(() => undefined);
  }
  private post(m: Record<string, unknown>, read: boolean): Promise<Record<string, unknown>[] | undefined> {
    if (this.closed) return Promise.resolve(undefined);
    let w = read ? this.reader : this.writer;
    if (!w) {
      const nw = (w = new Worker(WRITER_WORKER, { eval: true, workerData: { file: this.file, COLS, METRICS, walLimit: this.o.walLimitBytes ?? WAL_LIMIT, schema: SCHEMA, addSeenAt: ADD_SEEN_AT, reader: read, readDelayMs: this.o.readDelayMs ?? 0 }, resourceLimits: { maxOldGenerationSizeMb: 128 }, stdout: false, stderr: false }));
      const fail = (e: Error) => {
        if (this.writer === nw) this.writer = undefined;
        if (this.reader === nw) this.reader = undefined;
        for (const [id, p] of this.pending) if (p.w === nw) { p.rej(e); this.pending.delete(id); }
      };
      nw.on("message", (r: { id: number; err?: string; busy?: boolean; rows?: Record<string, unknown>[] }) => {
        const p = this.pending.get(r.id);
        this.pending.delete(r.id);
        if (![...this.pending.values()].some((q) => q.w === nw)) nw.unref(); // idle: an idle worker must not keep the process alive
        if (r.err) p?.rej(Object.assign(new Error(r.err), { busy: r.busy }));
        else p?.res(r.rows);
      });
      nw.once("error", fail);
      nw.once("exit", (code) => fail(new Error(`size writer exit ${code}`)));
      nw.unref(); // after the listeners (adding a 'message' listener re-refs the port); a request in flight refs it again, see below
      if (read) this.reader = nw;
      else this.writer = nw;
    }
    const ww = w;
    return new Promise((res, rej) => {
      const id = ++this.seq;
      this.pending.set(id, { w: ww, res, rej });
      ww.ref(); // a request in flight keeps the process alive until it is answered
      ww.postMessage({ ...m, id });
    });
  }

  private closed = false;
  /** The returned promise settles once the worker threads are gone (their connections are closed then). A request still waiting is answered empty, not failed: this is a shutdown, not a fault. */
  close(): Promise<void> {
    this.closed = true;
    this.retryAt = 0;
    for (const p of this.pending.values()) p.res();
    this.pending.clear();
    const ws = [this.writer?.terminate(), this.reader?.terminate()];
    this.writer = this.reader = undefined;
    const db = this.db;
    this.db = null;
    db?.close();
    return Promise.all(ws).then(() => undefined);
  }

  /**
   * Scans and changes of overlapping subtrees run one after the other, in the order they asked; unrelated subtrees do not wait.
   * Arrival order keeps a long scan from starving while small changes keep re-taking an overlapping lock.
   * The returned function releases the lock (more than once is harmless). A wait ends with an error when `signal` aborts.
   */
  async lock(virtual: string, signal?: AbortSignal): Promise<() => void> {
    const overlaps = (h: { path: string }) => h.path === virtual || h.path === "/" || virtual === "/" || h.path.startsWith(virtual + "/") || virtual.startsWith(h.path + "/");
    const canceled = () => new FsError(400, "canceled");
    if (signal?.aborted) throw canceled();
    let release!: () => void;
    const h = { path: virtual, done: new Promise<void>((r) => (release = r)) };
    const ahead = this.held.filter(overlaps);
    this.held.push(h);
    const free = () => {
      const i = this.held.indexOf(h);
      if (i >= 0) this.held.splice(i, 1);
      release();
    };
    if (ahead.length) {
      let off = () => {};
      const aborted = new Promise<never>((_, rej) => {
        const f = () => rej(canceled());
        signal?.addEventListener("abort", f, { once: true });
        off = () => signal?.removeEventListener("abort", f);
      });
      try {
        await Promise.race([Promise.all(ahead.map((a) => a.done)), aborted]);
      } catch (e) {
        free();
        throw e;
      } finally {
        off();
      }
    }
    return free;
  }

  private toRow(r: Record<string, unknown>): Row {
    const own = zero();
    const tot = zero();
    for (const m of METRICS) {
      own[m] = Number(r[`own_${m}`]);
      tot[m] = Number(r[`tot_${m}`]);
    }
    const row: Row = { path: r.path as string, parent: r.parent as string, ino: Number(r.ino), dev: Number(r.dev), mtime_ms: Number(r.mtime_ms), scanned_at: Number(r.scanned_at), seen_at: Number(r.seen_at), own, tot };
    if (r.kids !== undefined) row.kids = Number(r.kids);
    return row;
  }
  /**
   * One read statement: on the read worker for a file-backed store (the main thread never waits for the disk; the request is queued after
   * every commit acknowledged so far, so it sees them), else inline. A busy database answers `dflt`, any other failure gives the store up.
   */
  private async read(q: string, sql: string, params: (string | number)[], dflt: Record<string, unknown>[] | null): Promise<Record<string, unknown>[] | null> {
    if (!this.db) return dflt;
    const t0 = performance.now();
    try {
      return this.file === ":memory:" ? this.inline(q, sql, params) : ((await this.post({ op: "read", sql, params }, true)) ?? []);
    } catch (e) {
      this.failed(e);
      return dflt;
    } finally {
      if (performance.now() - t0 > SLOW_READ_MS) slowLog(`size-read-${q}`, performance.now() - t0, String(params[0]));
    }
  }
  /** The in-memory store reads on the main thread (no file, no disk wait). */
  private inline(q: string, sql: string, params: (string | number)[]): Record<string, unknown>[] {
    const st = (this.q as Record<string, StatementSync | undefined>)[q] ?? this.db!.prepare(sql);
    if (q === "get" || q === "getKids") {
      const r = st.get(...params);
      return r ? [r] : [];
    }
    return st.all(...params) as Record<string, unknown>[];
  }
  /** Same as `get` for the in-memory store only (inside a synchronous transaction). */
  private getInline(p: string): Row | undefined {
    return this.safe(() => {
      const r = this.q.get.get(p);
      return r && this.toRow(r);
    }, undefined);
  }
  private async get(p: string): Promise<Row | undefined> {
    const r = (await this.read("get", SQL.get, [p], []))?.[0];
    return r && this.toRow(r);
  }
  /**
   * Stored child folders (same device as their parent: a row of another device is a scanned mount point, not part of the folder) of the folders `ps`,
   * grouped by parent, at most `max` rows in all: a folder with millions of children is never loaded at once.
   */
  private async levelKids(ps: string[], max: number): Promise<Map<string, Row[]>> {
    const out = new Map<string, Row[]>();
    for (let i = 0; i < ps.length && max > 0; i += 1000) {
      const chunk = ps.slice(i, i + 1000);
      const sql = `SELECT k.* FROM sizes k JOIN sizes p ON p.path = k.parent AND p.dev = k.dev WHERE k.parent IN (${chunk.map(() => "?").join(",")}) ORDER BY k.parent, k.path LIMIT ?`;
      for (const r of (await this.read("levelKids", sql, [...chunk, max], [])) ?? []) {
        const k = this.toRow(r);
        out.get(k.parent)?.push(k) ?? out.set(k.parent, [k]);
        max--;
      }
    }
    return out;
  }
  /** Up to `PAGE` stored child folders on device `dev` after path `after` (keyset paging, so a folder with millions never loads at once). */
  /** null when the read failed (a busy database): not the same as "no more rows" */
  private async kidPage(p: string, dev: number, after: string): Promise<Row[] | null> {
    return (await this.read("kidPage", SQL.kidPage, [p, dev, after, PAGE], null))?.map((r) => this.toRow(r)) ?? null;
  }
  /** Is `p` stored? null when the read failed. */
  private async has(p: string): Promise<boolean | null> {
    const r = await this.read("get", SQL.get, [p], null);
    return r && r.length > 0;
  }
  /** A stored folder with the number of its stored child folders on its own device (one statement: this runs once per folder of every walk). */
  private async getWithKids(p: string): Promise<Row | undefined> {
    const r = (await this.read("getKids", SQL.getKids, [p], []))?.[0];
    return r && this.toRow(r);
  }
  /** Stored rows (with their child counts) of up to BATCH folders in one round trip; a folder that is not stored, or a failed read, has no entry. */
  private async getMany(ps: string[]): Promise<Map<string, Row>> {
    const out = new Map<string, Row>();
    for (const r of (await this.read("getMany", SQL.getMany(ps.length), ps, [])) ?? []) out.set(r.path as string, this.toRow(r));
    return out;
  }
  /** Up to 256 stored child folders (by path, after `after`) whose `seen_at` is not `stamp`; keyset paging keeps a purge linear. */
  private kidStale(p: string, dev: number, stamp: number, after: string): string[] {
    return this.db!.prepare("SELECT path FROM sizes WHERE parent = ? AND dev = ? AND seen_at <> ? AND path > ? ORDER BY path LIMIT 256").all(p, dev, stamp, after).map((r) => r.path as string);
  }
  private put(n: Row) {
    this.q.put.run(n.path, n.parent, n.ino, n.dev, n.mtime_ms, n.scanned_at, n.seen_at, ...METRICS.map((m) => n.own[m]), ...METRICS.map((m) => n.tot[m]));
  }
  private delTree(p: string) {
    this.q.delTree.run(p, ...below(p));
  }
  /** Add `d` to the totals of the stored ancestors of `p`, up to the first one on another device (a mount point's parent does not contain it). */
  private addToAncestors(p: string, d: Sums, dev: number) {
    const anc: string[] = [];
    for (let a = parentOf(p); a; a = parentOf(a)) {
      const row = this.getInline(a);
      if (!row) continue;
      if (row.dev !== dev) break;
      anc.push(a);
    }
    if (!anc.length) return;
    this.db!
      .prepare(`UPDATE sizes SET ${METRICS.map((m) => `tot_${m} = tot_${m} + ${Math.trunc(d[m])}`).join(", ")} WHERE path IN (${anc.map(() => "?").join(",")})`)
      .run(...anc);
  }

  /**
   * Walk `virtual`, reusing stored folders (see the rules above) unless `fresh`, and store the result.
   * `force` re-reads the start folder whatever its row says; `trust` takes the start folder's stored
   * child folders as they are (when their inode and device still match) instead of validating their subtrees (applyChanged).
   *
   * Memory follows the depth of the tree, never its width: the walk keeps one frame per level (the folder and a cursor: an
   * open directory read 64 names at a time, or a page of stored child rows), enters a child folder as soon as it is found,
   * and finishes a folder once its children are (its totals are then final): it is written and forgotten. Neither the names
   * of a folder, nor its pending sibling folders, nor its stored children are ever held in full. Rows go to the store
   * bottom-up in chunks (one transaction each, yielding between them); the start folder and the ancestors go in the last one.
   * A walk that fails after rows were written marks the subtree stale so the next scan re-reads it (parents above would
   * otherwise keep totals from before).
   */
  private async walk(virtual: string, real: string, st: Stats, ctl: JobCtl, mode: { fresh: boolean; /** a rescan resumed: rows written at or after this time are kept */ since?: number; force?: boolean; trust?: boolean }): Promise<Walk> {
    await this.reopen();
    const dev = Number(st.dev);
    const now = Date.now();
    const stamp = (this.stamp = Math.max(now, this.stamp + 1));
    const chunk = this.o.commitChunk ?? COMMIT_CHUNK;
    let seen = 0;
    let bytes = 0;
    let read = 0;
    let root: Node | undefined;
    let buf: Node[] = [];
    let written = false;
    let dirty = false;
    /** commits sent to the writer and not yet answered; it runs them in order, so the walk need not wait for each one */
    const inflight: Promise<void>[] = [];
    const drain = async () => {
      while (inflight.length) await inflight.shift();
    };
    const frames: Frame[] = [];
    this.lastWalkFrames = 0;
    /** rows kept for `tree` while the database is unusable (bounded) */
    const rows = new Map<string, Row>();
    const canceled = () => {
      if (ctl.signal.aborted) throw new FsError(400, "canceled");
    };

    const flush = async (last: Node | null) => {
      const part = buf;
      buf = [];
      if (this.db) {
        if (this.file === ":memory:") this.safe(() => this.commitInline(last, part), false);
        else {
          // a file-backed store writes on the worker thread: the main thread only reads, so a stalled disk cannot hold the event loop
          const items = part.map((n) =>
            n.touch
              ? { path: n.path, dev: n.dev, touch: n.seen_at }
              : { path: n.path, dev: n.dev, purge: n.purge ? n.seen_at : null, row: [n.path, n.parent, n.ino, n.dev, n.mtime_ms, n.scanned_at, n.seen_at, ...METRICS.map((m) => n.own[m]), ...METRICS.map((m) => n.tot[m])] },
          );
          const t0 = performance.now();
          inflight.push(
            this.send({ op: "commit", items, last: last ? { path: last.path, dev: last.dev, tot: last.tot } : null }).then(
              () => {
                if (performance.now() - t0 > SLOW_SEND_MS) slowLog("size-commit", performance.now() - t0, virtual);
              },
              (e) => {
                if (this.isBusy(e)) dirty = true; // not stored: the subtree is marked stale at the end
                this.failed(e);
              },
            ),
          );
          const w0 = performance.now();
          if (last) await drain();
          else if (inflight.length >= COMMITS_IN_FLIGHT) await inflight.shift();
          if (performance.now() - w0 > SLOW_SEND_MS) slowLog("size-flush-wait", performance.now() - w0, virtual);
        }
        written = true;
      }
      if (!this.db) for (const n of part) if (!n.touch && (rows.size < Math.min(this.o.maxEntries, FALLBACK_ROWS) || n === last)) rows.set(n.path, { path: n.path, parent: n.parent, ino: n.ino, dev: n.dev, mtime_ms: n.mtime_ms, scanned_at: n.scanned_at, seen_at: n.seen_at, own: n.own, tot: n.tot });
    };

    /**
     * Read-ahead: a walk of many small folders would otherwise wait for the disk twice per folder (read, then stat) one folder after
     * the other. Folders we are about to enter get their names read and their children stat-ed now, a few at a time, so the walk's
     * own calls find them in the kernel's cache. Dropped when the line is long; results are never kept, so memory stays flat.
     */
    /** first pages of stored children read ahead, taken (once) by the walk when it reaches the folder; cleared when it grows past a bound */
    const firstPages = new Map<string, Promise<Row[] | null>>();
    const ahead = (v: string, r: string, stored: Row | null | undefined) => {
      if (this.io.queued >= AHEAD_QUEUE) return;
      const row = mode.fresh ? undefined : stored;
      if (row && row.own.dirs - row.own.mounts === 0) return; // reused leaf: nothing under it is stat-ed
      void this.io(async () => {
        let kids: Row[] | null = null;
        if (row) {
          // the walk reads these children's first page itself a moment later: share the read
          if (firstPages.size >= 128) firstPages.clear();
          const p = this.kidPage(v, dev, "");
          firstPages.set(v, p);
          kids = await p;
        }
        const names = kids?.length ? kids.map((k) => path.posix.basename(k.path)) : ((await listAhead(r)) as string[]).slice(0, AHEAD_NAMES);
        await Promise.all(names.map((n) => fs.lstat(path.join(r, n)).catch(() => undefined)));
      }).catch(() => undefined);
    };

    /** `n` has all its children: its totals are final. Store it and roll it into its parent. */
    const finish = async (n: Node) => {
      buf.push(n);
      const up = n.up;
      if (up) addTo(up.tot, n.tot);
      else root = n;
      if (!up || buf.length >= chunk) {
        await flush(up ? null : n);
        if (up) await tick();
      }
    };

    /** Cursor over a folder read from disk: up to BATCH entries are lstat-ed at a time, files are tallied at once, child folders are handed out one by one. */
    const readFrame = (node: Node, src: { next(): Promise<string | null>; close(): Promise<void> }, vpath: string, rpath: string, isRoot: boolean): Frame => {
      let batch: Child[] = [];
      let i = 0;
      let ended = false;
      let closed = false;
      const getRow = (v: string) => this.get(v);
      const getMany = (ps: string[]) => this.getMany(ps);
      const close = async () => {
        if (closed) return;
        closed = true;
        await src.close();
      };
      const end = async () => {
        ended = true;
        addTo(node.tot, node.own);
        await close();
      };
      return {
        node,
        close,
        async next() {
          while (i >= batch.length) {
            if (ended) return null;
            canceled();
            // each entry is lstat-ed as soon as it is read, so the read that finds the end and the close overlap with the lstats
            const pend: Promise<{ n: string; r: string; s: Stats } | null>[] = [];
            const stat1 = async (n: string) => {
              if (n === TRASH_DIR) return null;
              const r = path.join(rpath, n);
              try {
                return { n, r, s: await fs.lstat(r) };
              } catch {
                node.own.errors++;
                return null;
              }
            };
            let eof = false;
            try {
              for (let e; pend.length < BATCH && (e = await src.next()) !== null; ) pend.push(stat1(e));
              eof = pend.length < BATCH;
            } catch {
              node.own.errors++;
              eof = true;
            }
            const closing = eof ? close() : undefined;
            const got = await Promise.all(pend);
            await closing;
            batch = [];
            i = 0;
            for (const g of got) {
              if (!g) continue;
              seen++;
              const disk = Number(g.s.blocks) * 512;
              if (g.s.isDirectory()) {
                node.own.dirs++;
                node.own.disk += disk;
                if (Number(g.s.dev) !== dev) node.own.mounts++;
                else {
                  const v = virtualJoin(vpath, g.n);
                  const prior = mode.trust && isRoot ? await getRow(v) : undefined;
                  // a folder deleted and recreated under the same name is not the stored one, even with the same inode number (freed inodes are reused at once); its mtime tells
                  if (prior && prior.parent === vpath && prior.ino === Number(g.s.ino) && prior.dev === Number(g.s.dev) && prior.mtime_ms === g.s.mtimeMs) {
                    addTo(node.tot, prior.tot);
                    buf.push({ ...prior, seen_at: stamp, reused: true, touch: true });
                  } else batch.push({ virtual: v, real: g.r, s: g.s });
                }
              } else if (g.s.isSymbolicLink()) {
                node.own.symlinks++;
                node.own.disk += disk;
              } else if (g.s.isFile()) {
                node.own.files++;
                node.own.bytes += Number(g.s.size);
                bytes += Number(g.s.size);
                node.own.disk += disk;
              } else node.own.other++;
            }
            if (batch.length) {
              const rows = await getMany(batch.map((b) => b.virtual));
              for (const b of batch) b.stored = rows.get(b.virtual) ?? null;
            }
            for (const b of batch) ahead(b.virtual, b.real, b.stored);
            ctl.progress.entries = seen;
            ctl.progress.bytes = bytes;
            if (eof) await end(); // after the tally: the folder's totals are final
            if (buf.length >= chunk) await flush(null);
            await tick();
          }
          return batch[i++]!;
        },
      };
    };

    /** Cursor over the stored child rows of an unchanged folder, a page at a time; each child is lstat-ed again as it is handed out. */
    const storedFrame = (node: Node, rpath: string, first?: { page: Row[]; ks: (Stats | null)[]; complete: boolean }): Frame => {
      // the first pages (up to CACHED rows) were lstat-ed by the reuse check a moment ago: their stats are taken as they are, later pages are lstat-ed when handed out
      let page: Row[] = first?.page ?? [];
      let stats = first?.ks;
      let at = 0;
      let after = page.length ? page[page.length - 1]!.path : "";
      let done = node.own.dirs - node.own.mounts === 0 || (!!first && first.complete); // no stored children, or the cached pages were all of them
      const fetch = (a: string) => this.kidPage(node.path, dev, a);
      const want = node.own.dirs - node.own.mounts;
      let handed = 0;
      /** the end of the children: rows the store did not give (a busy read) are errors, and the subtree is marked stale */
      const end = () => {
        if (handed < want) {
          node.tot.errors += want - handed;
          dirty = true;
        }
        return null;
      };
      return {
        node,
        close: async () => undefined,
        async next() {
          for (;;) {
            if (at >= page.length) {
              if (done) return end();
              canceled();
              page = (await fetch(after)) ?? [];
              at = 0;
              if (page.length < PAGE) done = true;
              if (!page.length) return end();
              after = page[page.length - 1]!.path;
              // the whole page at once: one lstat after the other would make the walk wait for the disk once per child
              stats = await Promise.all(page.map((k) => fs.lstat(path.join(rpath, path.posix.basename(k.path))).catch(() => null)));
              page.forEach((k, j) => stats![j] && ahead(k.path, path.join(rpath, path.posix.basename(k.path)), k));
            }
            const k = page[at++]!;
            handed++;
            const real = path.join(rpath, path.posix.basename(k.path));
            const s = stats![at - 1];
            if (s?.isDirectory() && Number(s.dev) === dev) return { virtual: k.path, real, s, stored: k };
            // gone since the check: counted as an unreadable folder, and the next scan re-reads this one
            node.own.errors++;
            node.tot.errors++;
          }
        },
      };
    };

    /** Decide reuse or re-read for one folder; null when it is finished already (a folder that cannot be read). */
    const open = async (t: Child & { root: boolean; up?: Node }): Promise<Frame | null> => {
      canceled();
      ctl.progress.current = t.virtual;
      const s = t.s;
      const ino = Number(s.ino);
      const stored = t.stored === undefined ? await this.getWithKids(t.virtual) : t.stored ?? undefined;
      const storedKids = stored?.kids ?? 0;
      let reusable = (!mode.fresh || (!!stored && stored.scanned_at >= (mode.since ?? Infinity))) && !(t.root && mode.force) && !!stored && stored.ino === ino && stored.dev === dev && stored.mtime_ms === s.mtimeMs && stored.scanned_at > 0 && (now - stored.scanned_at < this.o.ttlMs || (stored.scanned_at >= this.watchedSince() && this.covers(t.virtual))) && storedKids === stored.own.dirs - stored.own.mounts;
      let first: { page: Row[]; ks: (Stats | null)[]; complete: boolean } | undefined;
      if (reusable) {
        // every stored child folder must still be a folder on this device, otherwise this folder's counts are stale
        let total = 0;
        for (let after = "", more = stored!.own.dirs - stored!.own.mounts > 0; reusable && more; ) {
          canceled();
          const early = after === "" ? firstPages.get(t.virtual) : undefined;
          firstPages.delete(t.virtual);
          const page = (early && (await early)) || (await this.kidPage(t.virtual, dev, after));
          if (!page) {
            reusable = false; // could not read the stored children: re-read the folder
            break;
          }
          more = page.length === PAGE;
          if (page.length) after = page[page.length - 1]!.path;
          const ks = await Promise.all(page.map((k) => fs.lstat(path.join(t.real, path.posix.basename(k.path))).catch(() => null)));
          reusable = ks.every((k) => k && k.isDirectory() && Number(k.dev) === dev);
          if (reusable) page.forEach((k) => ahead(k.path, path.join(t.real, path.posix.basename(k.path)), k));
          first ??= { page: [], ks: [], complete: false };
          if (first.page.length < CACHED) {
            first.page.push(...page);
            first.ks.push(...ks);
          }
          first.complete = !more && first.page.length === total + page.length; // every row so far was kept
          total += page.length;
        }
        reusable &&= total === storedKids;
      }
      if (reusable) {
        const node: Node = { ...stored!, tot: { ...stored!.own }, seen_at: stamp, reused: true, up: t.up };
        seen += node.own.files + node.own.symlinks + node.own.other + node.own.dirs;
        bytes += node.own.bytes;
        ctl.progress.entries = seen;
        ctl.progress.bytes = bytes;
        return storedFrame(node, t.real, first);
      }
      const node: Node = { path: t.virtual, parent: parentOf(t.virtual), ino, dev, mtime_ms: s.mtimeMs, scanned_at: now, seen_at: stamp, own: zero(), tot: zero(), reused: false, up: t.up };
      read++;
      node.purge = storedKids > 0 || !stored || stored.dev !== dev; // no stored row: children may still be stored (a scan of a child alone)
      let src: { next(): Promise<string | null>; close(): Promise<void> };
      try {
        // a folder whose own size says it is small is read at once (one call instead of open, read, read, close); only big ones are streamed
        // shortcut: a size of 0 (CIFS, FUSE) says nothing and is streamed; overlayfs reports the upper layer's size, so a merged folder can be bigger than it looks
        if (s.size > 0 && s.size <= (this.o.streamAbove ?? STREAM_ABOVE)) {
          const names = (await fs.readdir(t.real)) as string[];
          let i = 0;
          src = { next: async () => names[i++] ?? null, close: async () => undefined };
        } else {
          const dir = await fs.opendir(t.real, { bufferSize: 64 });
          src = { next: async () => (await dir.read())?.name ?? null, close: () => dir.close().catch(() => undefined) };
        }
      } catch {
        node.own.errors++;
        node.tot = { ...node.own };
        await finish(node);
        return null;
      }
      return readFrame(node, src, t.virtual, t.real, t.root);
    };

    try {
      const first = await open({ virtual, real, root: true, s: st });
      if (first) frames.push(first);
      while (frames.length) {
        canceled();
        const f = frames[frames.length - 1]!;
        const c = await f.next();
        if (c) {
          if (frames.length >= DU_MAX_DEPTH) {
            // too deep to enter: counted, not walked. A reused node's stored `own` must not carry it (it would pile up on every scan; the folder is read again anyway as the child has no row)
            if (!f.node.reused) f.node.own.errors++;
            f.node.tot.errors++;
            continue;
          }
          const nf = await open({ ...c, root: false, up: f.node });
          if (nf) frames.push(nf);
          this.lastWalkFrames = Math.max(this.lastWalkFrames, frames.length);
        } else {
          frames.pop();
          await f.close();
          await finish(f.node);
        }
      }
    } catch (e) {
      await drain();
      // A resumable rescan keeps the folders it finished (rows stamped since it began are final); everything older is marked stale.
      if (written) await this.write("UPDATE sizes SET scanned_at = 0 WHERE (path = ? OR (path > ? AND path < ?)) AND scanned_at < ?", [virtual, ...below(virtual), mode.since ?? Infinity]);
      throw e;
    } finally {
      for (const f of frames) await f.close();
    }
    await drain();
    if (dirty && this.db) await this.write("UPDATE sizes SET scanned_at = 0 WHERE path = ? OR (path > ? AND path < ?)", [virtual, ...below(virtual)]);
    if (!this.db) this.keep(rows);
    return { root: root!, read };
  }

  /** The writer worker's `commit` (WRITER_WORKER) for a store that has no file: one transaction. `last` = the start folder, whose change is added to the ancestors. */
  private commitInline(last: Row | null, part: Node[]): boolean {
    const db = this.db!;
    db.exec("BEGIN");
    try {
      const old = last ? this.getInline(last.path) : undefined;
      for (const n of part) {
        if (n.touch) {
          this.q.touch.run(n.seen_at, n.path);
          continue;
        }
        if (n.purge) {
          // drop the stored child folders this walk did not see (same as the worker's `purge`)
          for (let after = "", r = this.kidStale(n.path, n.dev, n.seen_at, after); r.length; r = this.kidStale(n.path, n.dev, n.seen_at, after)) {
            for (const k of r) this.delTree(k);
            after = r[r.length - 1]!;
          }
        }
        this.put(n);
      }
      if (last && old) {
        const d = { ...last.tot };
        addTo(d, old.tot, -1);
        this.addToAncestors(last.path, d, last.dev);
      }
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
    return true;
  }

  private keep(nodes: Map<string, Row>) {
    this.walks.push(nodes);
    // bounded by rows in total, oldest first; the newest walk is always kept
    let rows = 0;
    for (const w of this.walks) rows += w.size;
    while (this.walks.length > 1 && rows > Math.min(this.o.maxEntries, FALLBACK_ROWS)) rows -= this.walks.shift()!.size;
  }

  /** Set by the agent when a change watcher is running: true when it keeps the stored sizes of `virtual` current. */
  covers: (virtual: string) => boolean = () => false;
  /** Rows older than this were not watched all their life (the watcher started later): they keep the TTL rule. */
  watchedSince: () => number = () => Infinity;

  /** false once the database is unusable: nothing is cached any more */
  get persistent(): boolean {
    return this.db !== null;
  }

  private result(n: Row): SizeResult {
    const t = n.tot;
    return { path: n.path, files: t.files, dirs: t.dirs, symlinks: t.symlinks, other: t.other, bytes: t.bytes, diskBytes: t.disk, truncated: false, mountsSkipped: t.mounts, errors: t.errors };
  }

  /** `du` of one folder through the store. A single file is answered directly and not stored. */
  async scan(virtual: string, ctl: JobCtl = noCtl(), fresh = false, release?: () => void): Promise<SizeResult> {
    return (await this.scanRead(virtual, ctl, fresh, release)).res;
  }

  /**
   * Like `scan`, also telling how many folders were read from disk (0 = answered from the store, only validated).
   * `release` is a lock from `lock(virtual)` the caller already holds; it is released when the scan ends.
   * `after` runs once the scan is stored, still under the lock, so it never sees a half-written scan.
   */
  async scanRead<T = undefined>(virtual: string, ctl: JobCtl = noCtl(), fresh: boolean | number = false, release?: () => void, after?: () => Promise<T>): Promise<{ res: SizeResult; read: number; extra?: T }> {
    release ??= await this.lock(resolveRead(this.o.root, virtual).virtual);
    try {
      const r = resolveRead(this.o.root, virtual);
      let st: Stats;
      try {
        st = await fs.stat(r.real);
      } catch (e) {
        // The start folder is gone: its rows (and its share of the parent) are trimmed after this lock is released,
        // never while holding it, because that takes another lock and a job slot must not wait on one.
        release();
        if ((e as NodeJS.ErrnoException).code === "ENOENT") void this.applyChanged(r.virtual).catch(() => undefined);
        throw e;
      }
      if (!st.isDirectory()) return { res: { path: r.virtual, files: 1, dirs: 0, symlinks: 0, other: 0, bytes: st.size, diskBytes: Number(st.blocks) * 512, truncated: false, mountsSkipped: 0, errors: 0 }, read: 0 };
      await this.tail;
      // The previous scan is the expected total (progress and ETA); read before the walk replaces it.
      const prev = await this.get(r.virtual);
      if (prev && !ctl.progress.totalEntries) {
        ctl.progress.totalEntries = prev.tot.files + prev.tot.dirs + prev.tot.symlinks + prev.tot.other;
        ctl.progress.totalBytes = prev.tot.bytes;
      }
      const w = await this.walk(r.virtual, r.real, st, ctl, { fresh: !!fresh, since: typeof fresh === "number" ? fresh : undefined });
      return { res: this.result(w.root), read: w.read, ...(after ? { extra: await after() } : {}) };
    } finally {
      release();
    }
  }

  /**
   * Re-read one folder after a change inside it (for the file watcher): own stats are recomputed, new
   * child folders are walked, vanished ones are dropped with their subtrees, and the difference is added to
   * every ancestor. Other stored child folders are trusted. An unknown folder re-reads its parent when that is stored.
   */
  async applyChanged(virtual: string, ctl: JobCtl = noCtl()): Promise<void> {
    let v = resolveRead(this.o.root, virtual).virtual;
    let release = await this.lock(parentOf(v) || v);
    try {
      const known = await this.has(v);
      if (known === null) return this.markStale(parentOf(v) || v); // busy: the event must not be lost, the next scan re-reads
      if (!known) {
        const p = parentOf(v);
        const pk = p ? await this.has(p) : false;
        if (pk === null) return this.markStale(p);
        if (!pk) return;
        v = p;
      }
      // a folder that is gone re-reads its parent: climb one level at a time, taking the lock of the level we climb to
      for (let up = await this.changed(v, ctl); up; up = await this.changed(v, ctl)) {
        release();
        v = up;
        release = await this.lock(parentOf(v) || v);
      }
    } finally {
      release();
    }
  }

  /** One write statement: on the worker for a file-backed store (one writer connection, never the main thread), else inline. */
  private write(sql: string, params: (string | number)[]): Promise<void> {
    return (this.tail = this.write1(sql, params));
  }
  private async write1(sql: string, params: (string | number)[]): Promise<void> {
    if (!this.db) return;
    if (this.file === ":memory:") return this.safe(() => void this.db!.prepare(sql).run(...params), undefined);
    try {
      await this.send({ op: "exec", sql, params });
    } catch (e) {
      this.failed(e);
    }
  }

  /** Forget how fresh the rows of `virtual` and below are (the watcher lost events): the next scan re-reads them. */
  markStale(virtual: string): void {
    const [lo, hi] = below(virtual);
    void this.write("UPDATE sizes SET scanned_at = 0 WHERE path = ? OR (path > ? AND path < ?)", [virtual, lo, hi]);
  }

  /** Many rows of one statement in one transaction: on the writer worker for a file-backed store, else inline. False when the store is unusable. */
  private async writeMany(sql: string, rows: (string | number)[][]): Promise<boolean> {
    if (!this.db) return false;
    if (this.file === ":memory:") {
      return this.safe(() => {
        const st = this.db!.prepare(sql);
        this.db!.exec("BEGIN");
        try {
          for (const r of rows) st.run(...r);
          this.db!.exec("COMMIT");
        } catch (e) {
          this.db!.exec("ROLLBACK");
          throw e;
        }
        return true;
      }, false);
    }
    try {
      await this.send({ op: "many", sql, rows });
      return true;
    } catch (e) {
      this.failed(e);
      return false;
    }
  }

  /**
   * Remember changed folders for the watcher (fanwatch.ts) on disk instead of in memory. A folder already waiting keeps its earlier
   * due time; a `modify` event is held back until `modifyMs` after the folder's last run. False when the store is unusable.
   */
  async notePending(items: { path: string; dueAt: number; modify: boolean }[], modifyMs: number): Promise<boolean> {
    const keep = (idle: string) => `ON CONFLICT(path) DO UPDATE SET due_at = CASE WHEN due_at = ${idle} THEN excluded.due_at ELSE MIN(due_at, excluded.due_at) END`;
    const ok = await this.writeMany(
      `INSERT INTO pending (path, due_at) VALUES (?1, ?2) ${keep("?3")}`,
      items.filter((i) => !i.modify).map((i) => [i.path, i.dueAt, PENDING_IDLE]),
    );
    // a modify event on a folder that ran lately waits for last_run + modifyMs (the SELECT is the new row's due time)
    const mod = items.filter((i) => i.modify);
    if (!mod.length) return ok;
    return (
      (await this.writeMany(
        `INSERT INTO pending (path, due_at) SELECT ?1, MAX(?2, COALESCE((SELECT last_run FROM pending WHERE path = ?1), 0) + ?3) WHERE true ${keep("?4")}`,
        mod.map((i) => [i.path, i.dueAt, modifyMs, PENDING_IDLE]),
      )) && ok
    );
  }

  private lastPrune = 0;
  /**
   * Up to `limit` folders whose due time has come, oldest first; they are marked run at `now` and not returned again until noted again.
   * Null when the oldest due time is more than 10 x modifyMs ago (the backlog would take too long to apply): the pending rows are then
   * dropped and the caller marks the watched trees stale instead. Due times far in the future (the clock stepped back) count as due.
   */
  async takeDue(now: number, limit: number, t: { modifyMs: number; settleMs: number }): Promise<string[] | null> {
    if (!this.db) return [];
    const far = now + t.modifyMs + t.settleMs;
    const col = async (sql: string, ...a: number[]) => (await this.read("pending", sql, a, null))?.map((r) => r.path as string);
    const min = await this.read("pending", "SELECT MIN(due_at) d FROM pending", [], null);
    if (!min) return [];
    const oldest = min[0]?.d as number | null | undefined;
    if (oldest != null && oldest < PENDING_IDLE && oldest < now - 10 * t.modifyMs) {
      await this.clearPending();
      return null;
    }
    let got = await col("SELECT path FROM pending WHERE due_at <= ? ORDER BY due_at LIMIT ?", now, limit);
    if (!got) return [];
    if (got.length < limit) {
      const idle = await col("SELECT path FROM pending WHERE due_at > ? AND due_at < ? LIMIT ?", far, PENDING_IDLE, limit - got.length);
      if (!idle) return [];
      got = [...got, ...idle];
    }
    // the run starts after the reads above (slow on a loaded disk), so stamp it now: a modify row then waits modifyMs from the run, not from before the reads
    const ran = Math.max(now, Date.now());
    if (got.length) await this.writeMany("UPDATE pending SET last_run = ?, due_at = ? WHERE path = ?", got.map((p) => [ran, PENDING_IDLE, p]));
    // idle rows only remember the last run: drop them once it is older than the modify interval (or lies in the future), one bounded batch per call
    if (ran - this.lastPrune > 1000) {
      this.lastPrune = ran;
      await this.write1("DELETE FROM pending WHERE path IN (SELECT path FROM pending WHERE due_at = ? AND (last_run < ? OR last_run > ?) LIMIT ?)", [PENDING_IDLE, ran - t.modifyMs, ran + t.modifyMs, PENDING_BATCH]);
    }
    return got;
  }

  /** Folders that ran within the last `withinMs` (their run may not have finished when the process stopped), at most `limit`. */
  async recentRuns(now: number, withinMs: number, limit: number): Promise<string[]> {
    return ((await this.read("pending", "SELECT path FROM pending WHERE due_at = ? AND last_run >= ? LIMIT ?", [PENDING_IDLE, now - withinMs, limit], [])) ?? []).map((r) => r.path as string);
  }

  /** The watcher lost events: nothing pending is worth keeping, the stale marks cover it. */
  async clearPending(): Promise<void> {
    // bounded batches (the writer never holds one huge transaction), a pause between them; not `write`: size walks wait on its tail
    while (this.db && (await this.read("pending", "SELECT 1 FROM pending LIMIT 1", [], null))?.length) {
      await this.write1("DELETE FROM pending WHERE path IN (SELECT path FROM pending LIMIT ?)", [PENDING_BATCH]);
      await new Promise((r) => setTimeout(r, 5));
    }
  }

  /** Re-read `v`; when it is gone, the stored parent to re-read instead (undefined when done). */
  private async changed(v: string, ctl: JobCtl): Promise<string | undefined> {
    let real: string;
    let st: Stats;
    try {
      real = resolveRead(this.o.root, v).real;
      st = await fs.stat(real);
      if (!st.isDirectory()) throw new Error("gone");
    } catch {
      // The folder itself is gone: its parent's own counts change too, so re-read the parent when it is stored.
      const p = parentOf(v);
      const pk = p ? await this.has(p) : false;
      if (pk === null) {
        this.markStale(p);
        return undefined;
      }
      if (pk) return p;
      await this.write("DELETE FROM sizes WHERE path = ? OR (path > ? AND path < ?)", [v, ...below(v)]);
      return undefined;
    }
    await this.tail;
    await this.walk(v, real, st, ctl, { fresh: false, force: true, trust: true });
    return undefined;
  }

  /** The folder and its folder descendants down to `depth`; with `all`, also the files of the folders above that depth. */
  async tree(virtual: string, depth: number, all: boolean): Promise<{ entries: DuEntry[]; truncated: boolean }> {
    await this.reopen();
    const entries: DuEntry[] = [];
    let budget = this.o.maxEntries;
    let truncated = false;
    const asEntry = (r: Row): DuEntry => ({ path: r.path, type: "dir", bytes: r.tot.bytes, diskBytes: r.tot.disk, files: r.tot.files, dirs: r.tot.dirs, scannedAt: r.scanned_at });
    const walk = this.db ? undefined : [...this.walks].reverse().find((w) => w.has(virtual));
    const top = this.db ? await this.get(virtual) : walk?.get(virtual);
    if (!top) return { entries, truncated };
    let level = [top];
    for (let d = 0; level.length; d++) {
      const next: Row[] = [];
      // children beyond what the budget still allows (plus one, to see the cut) are never read
      const kids = walk || d >= depth ? undefined : await this.levelKids(level.map((r) => r.path), budget - level.length + 1);
      for (const r of level) {
        if (budget-- <= 0) {
          truncated = true;
          return { entries, truncated };
        }
        entries.push(asEntry(r));
        if (d >= depth) continue;
        for (const k of walk ? walk.values() : kids!.get(r.path) ?? []) if (!walk || (k.parent === r.path && k.dev === r.dev)) next.push(k);
        if (all) {
          const left = await this.filesOf(r.path, budget);
          budget -= left.entries.length;
          truncated ||= left.truncated;
          for (const e of left.entries) entries.push(e);
        }
      }
      level = next;
    }
    return { entries, truncated };
  }

  /** Non-folder children of one folder, straight from disk (rows are per folder, not per file). */
  private async filesOf(virtual: string, max: number): Promise<{ entries: DuEntry[]; truncated: boolean }> {
    const out: DuEntry[] = [];
    const real = resolveRead(this.o.root, virtual).real;
    let dir: Dir;
    try {
      dir = await fs.opendir(real, { bufferSize: 64 });
    } catch {
      return { entries: out, truncated: false };
    }
    try {
      for (let e = await dir.read().catch(() => null); e; e = await dir.read().catch(() => null)) {
        const n = e.name;
        if (n === TRASH_DIR) continue;
        let s;
        try {
          s = await fs.lstat(path.join(real, n));
        } catch {
          continue;
        }
        if (s.isDirectory()) continue;
        if (out.length >= max) return { entries: out, truncated: true };
        const type = s.isSymbolicLink() ? "symlink" : s.isFile() ? "file" : "other";
        out.push({ path: virtualJoin(virtual, n), type, bytes: type === "file" ? Number(s.size) : 0, diskBytes: Number(s.blocks) * 512, files: type === "file" ? 1 : 0, dirs: 0 });
      }
    } finally {
      await dir.close().catch(() => undefined);
    }
    return { entries: out, truncated: false };
  }
}
