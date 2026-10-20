import fs from "node:fs/promises";
import { rmSync, type Stats } from "node:fs";
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
 *  - everything else is re-read (readdir + lstat) and its row replaced;
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
  own: Sums;
  tot: Sums;
}

/** One folder of an in-flight walk. `fixed` = a stored row taken as-is (its subtree is not walked). */
interface Node extends Row {
  kids: string[];
  fixed: boolean;
  reused: boolean;
  /** the folder this one rolls up into */
  up?: Node;
  /** child folders not finished yet; the folder is stored and dropped from memory when this reaches 0 */
  pending: number;
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
const COMMIT_CHUNK = 5000;
const tick = () => new Promise<void>((r) => setImmediate(r));
const noCtl = (): JobCtl => ({ signal: new AbortController().signal, progress: { bytes: 0, totalBytes: 0, entries: 0, totalEntries: 0, current: "" } });
const parentOf = (p: string) => (p === "/" ? "" : path.posix.dirname(p));
/** Exclusive bounds of every path below `p` (the character after "/" is "0"). */
const below = (p: string) => {
  const pre = p === "/" ? "/" : p + "/";
  return [pre, pre.slice(0, -1) + "0"] as const;
};

const COLS = ["path", "parent", "ino", "dev", "mtime_ms", "scanned_at", ...METRICS.map((m) => `own_${m}`), ...METRICS.map((m) => `tot_${m}`)];

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
const { file, COLS, METRICS } = workerData;
const db = new DatabaseSync(file);
db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=OFF; PRAGMA busy_timeout=10000; PRAGMA cache_size=-8192");
const put = db.prepare("INSERT OR REPLACE INTO sizes (" + COLS.join(",") + ") VALUES (" + COLS.map(() => "?").join(",") + ")");
const kids = db.prepare("SELECT path, dev FROM sizes WHERE parent = ?");
const get = db.prepare("SELECT * FROM sizes WHERE path = ?");
const delTree = db.prepare("DELETE FROM sizes WHERE path = ? OR (path > ? AND path < ?)");
const parentOf = (p) => (p === "/" ? "" : p.slice(0, p.lastIndexOf("/")) || "/");
const below = (p) => { const pre = p === "/" ? "/" : p + "/"; return [pre, pre.slice(0, -1) + "0"]; };
const commit = ({ items, last }) => {
  db.exec("BEGIN");
  try {
    const old = last ? get.get(last.path) : undefined;
    for (const it of items) {
      if (it.keep) { const keep = new Set(it.keep); for (const k of kids.all(it.path)) if (Number(k.dev) === it.dev && !keep.has(k.path)) delTree.run(k.path, ...below(k.path)); }
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
parentPort.on("message", (m) => {
  try {
    if (m.op === "commit") commit(m); else db.prepare(m.sql).run(...m.params);
    parentPort.postMessage({ id: m.id });
  } catch (e) { parentPort.postMessage({ id: m.id, err: String(e && e.message || e) }); }
});
`;

export class SizeStore {
  /** null once the store is unusable: scans then walk without caching (same results, never `cached`) */
  private db: DatabaseSync | null = null;
  private q!: Record<"get" | "put" | "kids" | "delTree", StatementSync>;
  private held: { path: string; done: Promise<void> }[] = [];
  private file = ":memory:";
  private writer?: Worker;
  private pending = new Map<number, { res: () => void; rej: (e: Error) => void }>();
  private seq = 0;
  /** the latest `write`: a walk waits for it so it never reads rows a stale mark is about to change */
  private tail: Promise<void> = Promise.resolve();
  private warned = false;
  /** nodes of the latest walks (up to maxEntries rows in total), kept only while the database is unusable so `tree` can still answer */
  private walks: Map<string, Row>[] = [];

  constructor(
    file: string,
    private o: { root: string; ttlMs: number; /** cap on rows `tree` returns and on rows remembered while uncached */ maxEntries: number; commitChunk?: number },
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
    if (!this.db) this.warn(new Error("SQLite is unavailable"));
  }

  private open(file: string) {
    const db = openDb(file);
    if (!db) throw new Error("SQLite is unavailable");
    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS sizes (
          path TEXT PRIMARY KEY, parent TEXT NOT NULL, ino REAL, dev REAL, mtime_ms REAL, scanned_at INTEGER,
          ${METRICS.map((m) => `own_${m} INTEGER NOT NULL`).join(", ")}, ${METRICS.map((m) => `tot_${m} INTEGER NOT NULL`).join(", ")}
        ) WITHOUT ROWID;
        CREATE INDEX IF NOT EXISTS sizes_parent ON sizes(parent);
      `);
      this.q = {
        get: db.prepare("SELECT * FROM sizes WHERE path = ?"),
        put: db.prepare(`INSERT OR REPLACE INTO sizes (${COLS.join(",")}) VALUES (${COLS.map(() => "?").join(",")})`),
        kids: db.prepare("SELECT * FROM sizes WHERE parent = ? ORDER BY path"),
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

  /** Run a database operation; on failure give the database up (logged once) and answer `dflt`. */
  private safe<T>(fn: () => T, dflt: T): T {
    if (!this.db) return dflt;
    try {
      return fn();
    } catch (e) {
      this.giveUp(e);
      return dflt;
    }
  }

  private giveUp(e: unknown) {
    this.warn(e);
    try {
      this.db?.close();
    } catch {
      /* already broken */
    }
    this.db = null;
  }

  /** Run one request on the writer worker (started on first use); a file-backed store only. */
  private send(m: Record<string, unknown>): Promise<void> {
    if (!this.writer) {
      const w = new Worker(WRITER_WORKER, { eval: true, workerData: { file: this.file, COLS, METRICS }, resourceLimits: { maxOldGenerationSizeMb: 128 }, stdout: false, stderr: false });
      w.unref();
      const fail = (e: Error) => {
        if (this.writer === w) this.writer = undefined;
        for (const p of this.pending.values()) p.rej(e);
        this.pending.clear();
      };
      w.on("message", (r: { id: number; err?: string }) => {
        const p = this.pending.get(r.id);
        this.pending.delete(r.id);
        if (r.err) p?.rej(new Error(r.err));
        else p?.res();
      });
      w.once("error", fail);
      w.once("exit", (code) => fail(new Error(`size writer exit ${code}`)));
      this.writer = w;
    }
    return new Promise((res, rej) => {
      const id = ++this.seq;
      this.pending.set(id, { res, rej });
      this.writer!.postMessage({ ...m, id });
    });
  }

  close() {
    void this.writer?.terminate();
    this.writer = undefined;
    this.db?.close();
  }

  /**
   * Scans and changes of overlapping subtrees run one after the other; unrelated subtrees do not wait.
   * The returned function releases the lock (more than once is harmless). A wait ends with an error when `signal` aborts.
   */
  async lock(virtual: string, signal?: AbortSignal): Promise<() => void> {
    const overlaps = (h: { path: string }) => h.path === virtual || h.path === "/" || virtual === "/" || h.path.startsWith(virtual + "/") || virtual.startsWith(h.path + "/");
    const canceled = () => new FsError(400, "canceled");
    for (let h; (h = this.held.find(overlaps)); ) {
      if (signal?.aborted) throw canceled();
      let off = () => {};
      const aborted = new Promise<never>((_, rej) => {
        const f = () => rej(canceled());
        signal?.addEventListener("abort", f, { once: true });
        off = () => signal?.removeEventListener("abort", f);
      });
      try {
        await Promise.race([h.done, aborted]);
      } finally {
        off();
      }
    }
    if (signal?.aborted) throw canceled();
    let release!: () => void;
    const h = { path: virtual, done: new Promise<void>((r) => (release = r)) };
    this.held.push(h);
    return () => {
      const i = this.held.indexOf(h);
      if (i >= 0) this.held.splice(i, 1);
      release();
    };
  }

  private toRow(r: Record<string, unknown>): Row {
    const own = zero();
    const tot = zero();
    for (const m of METRICS) {
      own[m] = Number(r[`own_${m}`]);
      tot[m] = Number(r[`tot_${m}`]);
    }
    return { path: r.path as string, parent: r.parent as string, ino: Number(r.ino), dev: Number(r.dev), mtime_ms: Number(r.mtime_ms), scanned_at: Number(r.scanned_at), own, tot };
  }
  private get(p: string): Row | undefined {
    return this.safe(() => {
      const r = this.q.get.get(p);
      return r && this.toRow(r);
    }, undefined);
  }
  /** Stored child folders on device `dev` (a row of another device is a scanned mount point, not part of this folder). */
  private kidsOf(p: string, dev: number): Row[] {
    return this.safe(() => this.q.kids.all(p).map((r) => this.toRow(r)).filter((k) => k.dev === dev), []);
  }
  private put(n: Row) {
    this.q.put.run(n.path, n.parent, n.ino, n.dev, n.mtime_ms, n.scanned_at, ...METRICS.map((m) => n.own[m]), ...METRICS.map((m) => n.tot[m]));
  }
  private delTree(p: string) {
    this.q.delTree.run(p, ...below(p));
  }
  /** Add `d` to the totals of the stored ancestors of `p`, up to the first one on another device (a mount point's parent does not contain it). */
  private addToAncestors(p: string, d: Sums, dev: number) {
    const anc: string[] = [];
    for (let a = parentOf(p); a; a = parentOf(a)) {
      const row = this.get(a);
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
   * Memory does not grow with the tree: a folder is finished once its children are (its totals are then final), written
   * and forgotten, so only the unfinished path from the start folder down is held. Rows go to the store bottom-up in
   * chunks (one transaction each, yielding between them); the start folder and the ancestors go in the last one. A walk
   * that fails after rows were written marks the subtree stale so the next scan re-reads it (parents above would
   * otherwise keep totals from before).
   */
  private async walk(virtual: string, real: string, st: Stats, ctl: JobCtl, mode: { fresh: boolean; force?: boolean; trust?: boolean }): Promise<Walk> {
    const dev = Number(st.dev);
    const stack: { virtual: string; real: string; root: boolean; s: Stats; up?: Node }[] = [{ virtual, real, root: true, s: st }];
    const now = Date.now();
    const chunk = this.o.commitChunk ?? COMMIT_CHUNK;
    let seen = 0;
    let bytes = 0;
    let read = 0;
    let root: Node | undefined;
    let buf: Node[] = [];
    let written = false;
    /** rows kept for `tree` while the database is unusable (bounded) */
    const rows = new Map<string, Row>();

    const flush = async (last: Node | null) => {
      const part = buf;
      buf = [];
      if (this.db) {
        if (this.file === ":memory:") this.safe(() => this.commitInline(last, part), false);
        else {
          // a file-backed store writes on the worker thread: the main thread only reads, so a stalled disk cannot hold the event loop
          const items = part.map((n) => ({ path: n.path, dev: n.dev, keep: n.reused ? null : n.kids, row: [n.path, n.parent, n.ino, n.dev, n.mtime_ms, n.scanned_at, ...METRICS.map((m) => n.own[m]), ...METRICS.map((m) => n.tot[m])] }));
          try {
            await this.send({ op: "commit", items, last: last ? { path: last.path, dev: last.dev, tot: last.tot } : null });
          } catch (e) {
            this.giveUp(e);
          }
        }
        written = true;
      }
      if (!this.db) for (const n of part) if (rows.size < this.o.maxEntries || n === last) rows.set(n.path, { path: n.path, parent: n.parent, ino: n.ino, dev: n.dev, mtime_ms: n.mtime_ms, scanned_at: n.scanned_at, own: n.own, tot: n.tot });
    };

    /** `n` has all its children: its totals are final. Store it, roll it into its parent, and go up while parents complete too. */
    const finish = async (n: Node | undefined) => {
      for (; n; n = n.up) {
        if (!n.fixed) buf.push(n);
        const up = n.up;
        if (up) {
          addTo(up.tot, n.tot);
          up.pending--;
        } else root = n;
        if (!up || buf.length >= chunk) {
          await flush(up ? null : n);
          if (up) await tick();
        }
        if (up && up.pending > 0) return;
      }
    };

    try {
      while (stack.length) {
        if (ctl.signal.aborted) throw new FsError(400, "canceled");
        const t = stack.pop()!;
        const s = t.s;
        ctl.progress.current = t.virtual;
        const ino = Number(s.ino);
        const stored = this.get(t.virtual);
        const kids = stored ? this.kidsOf(t.virtual, dev) : [];
        let kidStats: Stats[] | undefined;
        let reusable = !mode.fresh && !(t.root && mode.force) && !!stored && stored.ino === ino && stored.dev === dev && stored.mtime_ms === s.mtimeMs && now - stored.scanned_at < this.o.ttlMs && kids.length === stored.own.dirs - stored.own.mounts;
        if (reusable) {
          // every stored child folder must still be a folder on this device, otherwise this folder's counts are stale
          kidStats = await Promise.all(kids.map((k) => fs.lstat(path.join(t.real, path.posix.basename(k.path))).catch(() => null))) as Stats[];
          reusable = kidStats.every((k) => k && k.isDirectory() && Number(k.dev) === dev);
        }
        const node: Node = reusable
          ? { ...stored!, tot: { ...stored!.own }, kids: [], fixed: false, reused: true, up: t.up, pending: kids.length }
          : { path: t.virtual, parent: parentOf(t.virtual), ino, dev, mtime_ms: s.mtimeMs, scanned_at: now, own: zero(), tot: zero(), kids: [], fixed: false, reused: false, up: t.up, pending: 0 };
        if (node.reused) {
          seen += node.own.files + node.own.symlinks + node.own.other + node.own.dirs;
          bytes += node.own.bytes;
          kids.forEach((k, i) => stack.push({ virtual: k.path, real: path.join(t.real, path.posix.basename(k.path)), root: false, s: kidStats![i]!, up: node }));
          ctl.progress.entries = seen;
          ctl.progress.bytes = bytes;
          if (!node.pending) await finish(node);
          continue;
        }
        read++;
        let names: string[];
        try {
          names = await fs.readdir(t.real);
        } catch {
          node.own.errors++;
          node.tot = { ...node.own };
          await finish(node);
          continue;
        }
        const byPath = new Map(kids.map((k) => [k.path, k]));
        const fixedKids: Row[] = [];
        for (let i = 0; i < names.length; i += 32) {
          if (ctl.signal.aborted) throw new FsError(400, "canceled");
          const got = await Promise.all(
            names.slice(i, i + 32).map(async (n) => {
              if (n === TRASH_DIR) return null;
              const r = path.join(t.real, n);
              try {
                return { n, r, s: await fs.lstat(r) };
              } catch {
                node.own.errors++;
                return null;
              }
            }),
          );
          for (const g of got) {
            if (!g) continue;
            seen++;
            const disk = Number(g.s.blocks) * 512;
            if (g.s.isDirectory()) {
              node.own.dirs++;
              node.own.disk += disk;
              if (Number(g.s.dev) !== dev) node.own.mounts++;
              else {
                const v = virtualJoin(t.virtual, g.n);
                node.kids.push(v);
                const prior = mode.trust && t.root ? byPath.get(v) : undefined;
                // a folder deleted and recreated under the same name is not the stored one, even with the same inode number (freed inodes are reused at once); its mtime tells
                if (prior && prior.ino === Number(g.s.ino) && prior.dev === Number(g.s.dev) && prior.mtime_ms === g.s.mtimeMs) fixedKids.push(prior);
                else {
                  node.pending++;
                  stack.push({ virtual: v, real: g.r, root: false, s: g.s, up: node });
                }
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
          ctl.progress.entries = seen;
          ctl.progress.bytes = bytes;
          await tick();
        }
        node.tot = { ...node.own };
        for (const k of fixedKids) addTo(node.tot, k.tot);
        if (!node.pending) await finish(node);
      }
    } catch (e) {
      if (written) await this.write("UPDATE sizes SET scanned_at = 0 WHERE path = ? OR (path > ? AND path < ?)", [virtual, ...below(virtual)]);
      throw e;
    }
    if (!this.db) this.keep(rows);
    return { root: root!, read };
  }

  /** The writer worker's `commit` (WRITER_WORKER) for a store that has no file: one transaction. `last` = the start folder, whose change is added to the ancestors. */
  private commitInline(last: Row | null, part: Node[]): boolean {
    const db = this.db!;
    db.exec("BEGIN");
    try {
      const old = last ? this.get(last.path) : undefined;
      for (const n of part) {
        if (!n.reused) {
          const keep = new Set(n.kids);
          for (const k of this.kidsOf(n.path, n.dev)) if (!keep.has(k.path)) this.delTree(k.path);
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
    while (this.walks.length > 1 && rows > this.o.maxEntries) rows -= this.walks.shift()!.size;
  }

  /** Set by the agent when a change watcher is running: true when it keeps the stored sizes of `virtual` current. */
  covers: (virtual: string) => boolean = () => false;

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
  async scanRead<T = undefined>(virtual: string, ctl: JobCtl = noCtl(), fresh = false, release?: () => void, after?: () => Promise<T>): Promise<{ res: SizeResult; read: number; extra?: T }> {
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
      const w = await this.walk(r.virtual, r.real, st, ctl, { fresh });
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
    const v = resolveRead(this.o.root, virtual).virtual;
    const release = await this.lock(parentOf(v) || v);
    try {
      if (!this.get(v)) {
        const p = parentOf(v);
        if (p && this.get(p)) await this.changed(p, ctl);
        return;
      }
      await this.changed(v, ctl);
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
      this.giveUp(e);
    }
  }

  /** Forget how fresh the rows of `virtual` and below are (the watcher lost events): the next scan re-reads them. */
  markStale(virtual: string): void {
    const [lo, hi] = below(virtual);
    void this.write("UPDATE sizes SET scanned_at = 0 WHERE path = ? OR (path > ? AND path < ?)", [virtual, lo, hi]);
  }

  private async changed(v: string, ctl: JobCtl): Promise<void> {
    let real: string;
    let st: Stats;
    try {
      real = resolveRead(this.o.root, v).real;
      st = await fs.stat(real);
      if (!st.isDirectory()) throw new Error("gone");
    } catch {
      // The folder itself is gone: its parent's own counts change too, so re-read the parent when it is stored.
      const p = parentOf(v);
      if (p && this.get(p)) return this.changed(p, ctl);
      await this.write("DELETE FROM sizes WHERE path = ? OR (path > ? AND path < ?)", [v, ...below(v)]);
      return;
    }
    await this.tail;
    await this.walk(v, real, st, ctl, { fresh: false, force: true, trust: true });
  }

  /** The folder and its folder descendants down to `depth`; with `all`, also the files of the folders above that depth. */
  async tree(virtual: string, depth: number, all: boolean): Promise<{ entries: DuEntry[]; truncated: boolean }> {
    const entries: DuEntry[] = [];
    let budget = this.o.maxEntries;
    let truncated = false;
    const asEntry = (r: Row): DuEntry => ({ path: r.path, type: "dir", bytes: r.tot.bytes, diskBytes: r.tot.disk, files: r.tot.files, dirs: r.tot.dirs, scannedAt: r.scanned_at });
    const walk = this.db ? undefined : [...this.walks].reverse().find((w) => w.has(virtual));
    const top = this.db ? this.get(virtual) : walk?.get(virtual);
    if (!top) return { entries, truncated };
    let level = [top];
    for (let d = 0; level.length; d++) {
      const next: Row[] = [];
      for (const r of level) {
        if (budget-- <= 0) {
          truncated = true;
          return { entries, truncated };
        }
        entries.push(asEntry(r));
        if (d >= depth) continue;
        for (const k of walk ? walk.values() : this.kidsOf(r.path, r.dev)) if (!walk || (k.parent === r.path && k.dev === r.dev)) next.push(k);
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
    let names: string[];
    try {
      names = await fs.readdir(resolveRead(this.o.root, virtual).real);
    } catch {
      return { entries: out, truncated: false };
    }
    for (const n of names) {
      if (n === TRASH_DIR) continue;
      let s;
      try {
        s = await fs.lstat(path.join(resolveRead(this.o.root, virtual).real, n));
      } catch {
        continue;
      }
      if (s.isDirectory()) continue;
      if (out.length >= max) return { entries: out, truncated: true };
      const type = s.isSymbolicLink() ? "symlink" : s.isFile() ? "file" : "other";
      out.push({ path: virtualJoin(virtual, n), type, bytes: type === "file" ? Number(s.size) : 0, diskBytes: Number(s.blocks) * 512, files: type === "file" ? 1 : 0, dirs: 0 });
    }
    return { entries: out, truncated: false };
  }
}
