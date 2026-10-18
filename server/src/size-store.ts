import fs from "node:fs/promises";
import { rmSync, type Stats } from "node:fs";
import path from "node:path";
import type { DatabaseSync, StatementSync } from "node:sqlite";
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
 *    file does not. Without the watcher (3.FD-10) the own stats can therefore be stale up to `ttlMs`;
 *  - everything else is re-read (readdir + lstat) and its row replaced;
 *  - a scan that hits the entry cap is returned but never stored, so stored totals are always complete.
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
}

interface Walk {
  root: Node;
  nodes: Map<string, Node>;
  truncated: boolean;
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

const tick = () => new Promise<void>((r) => setImmediate(r));
const noCtl = (): JobCtl => ({ signal: new AbortController().signal, progress: { bytes: 0, totalBytes: 0, entries: 0, totalEntries: 0, current: "" } });
const parentOf = (p: string) => (p === "/" ? "" : path.posix.dirname(p));
/** Exclusive bounds of every path below `p` (the character after "/" is "0"). */
const below = (p: string) => {
  const pre = p === "/" ? "/" : p + "/";
  return [pre, pre.slice(0, -1) + "0"] as const;
};

const COLS = ["path", "parent", "ino", "mtime_ms", "scanned_at", ...METRICS.map((m) => `own_${m}`), ...METRICS.map((m) => `tot_${m}`)];

export class SizeStore {
  /** null once the store is unusable: scans then walk without caching (same results, never `cached`) */
  private db: DatabaseSync | null = null;
  private q!: Record<"get" | "put" | "kids" | "delTree" | "minAge", StatementSync>;
  private chain: Promise<unknown> = Promise.resolve();
  private warned = false;
  /** nodes of the latest walk, kept only while the database is unusable so the route can still answer */
  private last = new Map<string, Row>();

  constructor(
    file: string,
    private o: { root: string; ttlMs: number; maxEntries: number },
  ) {
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
          path TEXT PRIMARY KEY, parent TEXT NOT NULL, ino INTEGER, mtime_ms REAL, scanned_at INTEGER,
          ${METRICS.map((m) => `own_${m} INTEGER NOT NULL`).join(", ")}, ${METRICS.map((m) => `tot_${m} INTEGER NOT NULL`).join(", ")}
        ) WITHOUT ROWID;
        CREATE INDEX IF NOT EXISTS sizes_parent ON sizes(parent);
      `);
      this.q = {
        get: db.prepare("SELECT * FROM sizes WHERE path = ?"),
        put: db.prepare(`INSERT OR REPLACE INTO sizes (${COLS.join(",")}) VALUES (${COLS.map(() => "?").join(",")})`),
        kids: db.prepare("SELECT * FROM sizes WHERE parent = ? ORDER BY path"),
        delTree: db.prepare("DELETE FROM sizes WHERE path = ? OR (path > ? AND path < ?)"),
        minAge: db.prepare("SELECT min(scanned_at) AS t FROM sizes WHERE path = ? OR (path > ? AND path < ?)"),
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
      this.warn(e);
      try {
        this.db.close();
      } catch {
        /* already broken */
      }
      this.db = null;
      return dflt;
    }
  }

  close() {
    this.db?.close();
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => undefined);
    return run;
  }

  private toRow(r: Record<string, unknown>): Row {
    const own = zero();
    const tot = zero();
    for (const m of METRICS) {
      own[m] = Number(r[`own_${m}`]);
      tot[m] = Number(r[`tot_${m}`]);
    }
    return { path: r.path as string, parent: r.parent as string, ino: Number(r.ino), mtime_ms: Number(r.mtime_ms), scanned_at: Number(r.scanned_at), own, tot };
  }
  private get(p: string): Row | undefined {
    return this.safe(() => {
      const r = this.q.get.get(p);
      return r && this.toRow(r);
    }, undefined);
  }
  private kidsOf(p: string): Row[] {
    return this.safe(() => this.q.kids.all(p).map((r) => this.toRow(r)), []);
  }
  private put(n: Row) {
    this.q.put.run(n.path, n.parent, n.ino, n.mtime_ms, n.scanned_at, ...METRICS.map((m) => n.own[m]), ...METRICS.map((m) => n.tot[m]));
  }
  private delTree(p: string) {
    this.q.delTree.run(p, ...below(p));
  }
  /** Add `d` to the totals of every stored ancestor of `p`. */
  private addToAncestors(p: string, d: Sums) {
    const anc: string[] = [];
    for (let a = parentOf(p); a; a = parentOf(a)) anc.push(a);
    if (!anc.length) return;
    this.db!
      .prepare(`UPDATE sizes SET ${METRICS.map((m) => `tot_${m} = tot_${m} + ${Math.trunc(d[m])}`).join(", ")} WHERE path IN (${anc.map(() => "?").join(",")})`)
      .run(...anc);
  }

  /** Whole stored subtree is younger than the TTL and the folder itself is unchanged: answerable without a walk. */
  async isFresh(virtual: string): Promise<boolean> {
    const row = this.get(virtual);
    if (!row) return false;
    let st;
    try {
      st = await fs.stat(resolveRead(this.o.root, virtual).real);
    } catch {
      return false;
    }
    if (!st.isDirectory() || Number(st.ino) !== row.ino || st.mtimeMs !== row.mtime_ms) return false;
    const t = this.safe(() => (this.q.minAge.get(virtual, ...below(virtual)) as { t: number | null }).t, null);
    return t !== null && Date.now() - t < this.o.ttlMs;
  }

  /**
   * Walk `virtual`, reusing stored folders (see the rules above) unless `fresh`, and store the result.
   * `force` re-reads the start folder whatever its row says; `trust` takes the start folder's stored
   * child folders as they are instead of validating their subtrees (applyChanged).
   */
  private async walk(virtual: string, real: string, st: Stats, ctl: JobCtl, mode: { fresh: boolean; force?: boolean; trust?: boolean }): Promise<Walk> {
    const dev = st.dev;
    const nodes = new Map<string, Node>();
    const order: Node[] = [];
    const stack = [{ virtual, real, root: true }];
    const now = Date.now();
    let seen = 0;
    let truncated = false;
    while (stack.length && !truncated) {
      if (ctl.signal.aborted) throw new FsError(400, "canceled");
      const t = stack.pop()!;
      let s = st;
      if (!t.root) {
        try {
          s = await fs.lstat(t.real);
        } catch {
          continue;
        }
        if (!s.isDirectory() || s.dev !== dev) continue;
      }
      ctl.progress.current = t.virtual;
      const ino = Number(s.ino);
      const stored = this.get(t.virtual);
      const kids = stored ? this.kidsOf(t.virtual) : [];
      const reusable =
        !mode.fresh && !(t.root && mode.force) && stored && stored.ino === ino && stored.mtime_ms === s.mtimeMs && now - stored.scanned_at < this.o.ttlMs && kids.length === stored.own.dirs - stored.own.mounts;
      const node: Node = reusable
        ? { ...stored, kids: kids.map((k) => k.path), fixed: false, reused: true }
        : { path: t.virtual, parent: parentOf(t.virtual), ino, mtime_ms: s.mtimeMs, scanned_at: now, own: zero(), tot: zero(), kids: [], fixed: false, reused: false };
      nodes.set(node.path, node);
      order.push(node);
      if (node.reused) {
        seen += node.own.files + node.own.symlinks + node.own.other + node.own.dirs;
        for (const k of kids) stack.push({ virtual: k.path, real: path.join(t.real, path.posix.basename(k.path)), root: false });
        if (seen >= this.o.maxEntries) truncated = true;
        continue;
      }
      let names: string[];
      try {
        names = await fs.readdir(t.real);
      } catch {
        node.own.errors++;
        continue;
      }
      const byPath = new Map(kids.map((k) => [k.path, k]));
      for (let i = 0; i < names.length && !truncated; i += 32) {
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
          if (seen >= this.o.maxEntries) {
            truncated = true;
            break;
          }
          seen++;
          const disk = Number(g.s.blocks) * 512;
          if (g.s.isDirectory()) {
            node.own.dirs++;
            node.own.disk += disk;
            if (g.s.dev !== dev) node.own.mounts++;
            else {
              const v = virtualJoin(t.virtual, g.n);
              node.kids.push(v);
              const prior = mode.trust ? byPath.get(v) : undefined;
              if (prior) {
                const fixed: Node = { ...prior, kids: [], fixed: true, reused: true };
                nodes.set(v, fixed);
              } else stack.push({ virtual: v, real: g.r, root: false });
            }
          } else if (g.s.isSymbolicLink()) {
            node.own.symlinks++;
            node.own.disk += disk;
          } else if (g.s.isFile()) {
            node.own.files++;
            node.own.bytes += Number(g.s.size);
            node.own.disk += disk;
          } else node.own.other++;
        }
        ctl.progress.entries = seen;
        await tick();
      }
    }
    // Children are always after their parent in `order`, so a reverse pass rolls totals up.
    const rootNode = order[0]!;
    for (let i = order.length - 1; i >= 0; i--) {
      const n = order[i]!;
      n.tot = { ...n.own };
      for (const k of n.kids) {
        const kn = nodes.get(k);
        if (kn) addTo(n.tot, kn.tot);
      }
    }
    ctl.progress.bytes = rootNode.tot.bytes;
    ctl.progress.entries = seen;
    return { root: rootNode, nodes, truncated };
  }

  /** Store a complete walk in one transaction: replace rescanned rows, drop vanished child folders, fix the ancestors. */
  private commit({ root, nodes }: Walk) {
    if (!this.db) return void (this.last = nodes);
    const old = this.get(root.path);
    const ok = this.safe(() => {
      const db = this.db!;
      db.exec("BEGIN");
      try {
        for (const n of nodes.values()) {
          if (n.fixed) continue;
          if (!n.reused) {
            const keep = new Set(n.kids);
            for (const k of this.kidsOf(n.path)) if (!keep.has(k.path)) this.delTree(k.path);
          }
          this.put(n);
        }
        if (old) {
          const d = { ...root.tot };
          addTo(d, old.tot, -1);
          this.addToAncestors(root.path, d);
        }
        db.exec("COMMIT");
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
      return true;
    }, false);
    if (!ok) this.last = nodes;
  }

  private result(n: Node, truncated: boolean): SizeResult {
    const t = n.tot;
    return { path: n.path, files: t.files, dirs: t.dirs, symlinks: t.symlinks, other: t.other, bytes: t.bytes, diskBytes: t.disk, truncated, mountsSkipped: t.mounts, errors: t.errors };
  }

  /** `du` of one folder through the store. A single file is answered directly and not stored. */
  scan(virtual: string, ctl: JobCtl = noCtl(), fresh = false): Promise<SizeResult> {
    return this.serial(async () => {
      const r = resolveRead(this.o.root, virtual);
      const st = await fs.stat(r.real);
      if (!st.isDirectory()) return { path: r.virtual, files: 1, dirs: 0, symlinks: 0, other: 0, bytes: st.size, diskBytes: Number(st.blocks) * 512, truncated: false, mountsSkipped: 0, errors: 0 };
      const w = await this.walk(r.virtual, r.real, st, ctl, { fresh });
      if (!w.truncated) this.commit(w);
      return this.result(w.root, w.truncated);
    });
  }

  /**
   * Re-read one folder after a change inside it (for the file watcher): own stats are recomputed, new
   * child folders are walked, vanished ones are dropped with their subtrees, and the difference is added to
   * every ancestor. Other stored child folders are trusted. An unknown folder re-reads its parent when that is stored.
   */
  applyChanged(virtual: string, ctl: JobCtl = noCtl()): Promise<void> {
    return this.serial(async () => {
      const v = resolveRead(this.o.root, virtual).virtual;
      if (!this.get(v)) {
        const p = parentOf(v);
        if (p && this.get(p)) await this.changed(p, ctl);
        return;
      }
      await this.changed(v, ctl);
    });
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
      this.safe(() => this.delTree(v), undefined);
      return;
    }
    const w = await this.walk(v, real, st, ctl, { fresh: false, force: true, trust: true });
    if (!w.truncated) this.commit(w);
  }

  /** The folder and its folder descendants down to `depth`; with `all`, also the files of the folders above that depth. */
  async tree(virtual: string, depth: number, all: boolean): Promise<{ entries: DuEntry[]; truncated: boolean }> {
    const entries: DuEntry[] = [];
    let budget = this.o.maxEntries;
    let truncated = false;
    const asEntry = (r: Row): DuEntry => ({ path: r.path, type: "dir", bytes: r.tot.bytes, diskBytes: r.tot.disk, files: r.tot.files, dirs: r.tot.dirs, scannedAt: r.scanned_at });
    const top = this.db ? this.get(virtual) : this.last.get(virtual);
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
        next.push(...(this.db ? this.kidsOf(r.path) : [...this.last.values()].filter((k) => k.parent === r.path)));
        if (all) {
          const left = await this.filesOf(r.path, budget);
          budget -= left.entries.length;
          truncated ||= left.truncated;
          entries.push(...left.entries);
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
