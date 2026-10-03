import fs from "node:fs";
import type { DatabaseSync, StatementSync } from "node:sqlite";
import { FsError } from "./fsops.ts";
import { compileGlobs } from "./glob.ts";
import { openDb } from "./index-cache.ts";
import { TRASH_DIR } from "./paths.ts";
import type { Progress } from "./jobs.ts";
import { classify, type DiffOptions, type Row, type Side, type Status, type Counts } from "./folderdiff.ts";

/**
 * Lazy, level-by-level folder compare. Nothing is walked up front: the root is
 * listed on both sides, every child pair is classified at once, and folders
 * present on both sides are queued for their own listing. Listings and hashes
 * run in parallel with bounded concurrency, folders the UI is looking at go
 * first, and every row lives in a per-session SQLite file (not in the heap), so
 * the size of the trees is bounded by disk, not by memory or an entry cap.
 *
 * A folder present on both sides is final once all of its children are: it is
 * identical when nothing below differs. `pend` counts the children still open,
 * `mask` collects the statuses found below (for "show folders containing...").
 */

/** One directory entry as an agent's /api/fs/lsdir reports it. */
export interface LsEntry {
  n: string;
  t: "file" | "dir" | "symlink" | "other";
  s: number;
  m: number;
  l?: string;
}
export interface DirSource {
  list(rel: string, signal: AbortSignal): Promise<{ entries: LsEntry[]; cached?: boolean }>;
  hash(rel: string, signal: AbortSignal): Promise<string>;
  /** live compare: directories (relative to this side's root) changed since `since` */
  changes?(since: number, signal: AbortSignal): Promise<{ seq: number; dirs: string[]; reset: boolean }>;
}

export const BIT: Record<Status, number> = { identical: 1, different: 2, "left-only": 4, "right-only": 8, error: 16 };
const NAME: Record<number, Status> = { 1: "identical", 2: "different", 4: "left-only", 8: "right-only", 16: "error" };
const NOT_IDENTICAL = 2 | 4 | 8 | 16;
/** job column: 1 listing queued, 2 listing running, 3 hash queued, 4 hash running, 5 nothing left to do */
const J = { LIST: 1, LISTING: 2, HASH: 3, HASHING: 4, DONE: 5 } as const;

export interface SessionStats {
  dirsScanned: number;
  dirsQueued: number;
  entries: number;
  hashed: number;
  hashQueued: number;
  hashedBytes: number;
  cacheHits: number;
  cacheMisses: number;
  startedAt: number;
  finishedAt?: number;
  /** bumped whenever any row changes; the UI refetches visible folders when it moves */
  rev: number;
  /** relative folders whose rows changed since the counter was last read (bounded; overflow = refetch all) */
  live: boolean;
}

/** A row as the UI receives it: `status` is "pending" until it is final. */
export type ViewRow = Omit<Row, "status"> & { status: Status | "pending"; mask?: number; listed?: boolean };
export interface FolderView {
  rel: string;
  /** false until this folder has been listed on both sides */
  listed: boolean;
  status: Status | "pending";
  rows: ViewRow[];
  rev: number;
}

interface DbRow {
  id: number;
  parent: number;
  p: string;
  rp: string | null;
  depth: number;
  d: number;
  lt: string | null;
  ls: number | null;
  lm: number | null;
  ll: string | null;
  rt: string | null;
  rs: number | null;
  rm: number | null;
  rl: string | null;
  st: number;
  why: string | null;
  newer: number;
  mask: number;
  pend: number;
  fin: number;
  job: number;
}

interface Kid {
  k: string;
  p: string;
  rp: string | null;
  l: LsEntry | null;
  r: LsEntry | null;
  st: number;
  why: string | null;
  newer: number;
  fin: number;
  job: number;
}

const COLS = "id, parent, p, rp, depth, d, lt, ls, lm, ll, rt, rs, rm, rl, st, why, newer, mask, pend, fin, job";

export class CompareSession {
  readonly stats: SessionStats;
  private warnSet = new Set<string>();
  /** depth limit and unreadable folders, as short sentences for the sidebar */
  get warnings(): string[] {
    const w = [...this.warnSet];
    if (this.errorCount) w.push(`${this.errorCount} folder${this.errorCount === 1 ? "" : "s"} could not be read`);
    return w;
  }
  private db: DatabaseSync;
  private q: Record<string, StatementSync>;
  private focus: string[] = [];
  private kick: () => void = () => undefined;
  private changed = new Set<string>();
  private changedOverflow = false;
  private exclude;
  private include;
  private depthWarned = false;
  private errorCount = 0;
  /** final rows per [file=0 | dir=1][status bit], kept in memory so status polls never scan the table */
  private tally: [Record<number, number>, Record<number, number>] = [{}, {}];
  private count(d: number, st: number, by = 1) {
    const t = this.tally[d ? 1 : 0];
    t[st] = (t[st] ?? 0) + by;
  }
  private closed = false;
  private running = false;
  private liveTimer: NodeJS.Timeout | undefined;
  private liveAbort = new AbortController();
  /** change-feed positions per side; -1 until the first poll sets the baseline */
  private seq: [number, number] = [-1, -1];
  /** folders that changed while they were being listed: re-listed on the next poll */
  private retry = new Set<string>();

  constructor(
    private left: DirSource,
    private right: DirSource,
    readonly o: DiffOptions & { dirConcurrency?: number },
    private file = ":memory:",
  ) {
    const db = openDb(file, 16384, true);
    if (!db) throw new FsError(500, "SQLite is not available in this runtime");
    this.db = db;
    db.exec(`
      CREATE TABLE rows (
        id INTEGER PRIMARY KEY, parent INTEGER NOT NULL, k TEXT NOT NULL, p TEXT NOT NULL, rp TEXT, depth INTEGER NOT NULL, d INTEGER NOT NULL,
        lt TEXT, ls INTEGER, lm INTEGER, ll TEXT, rt TEXT, rs INTEGER, rm INTEGER, rl TEXT,
        st INTEGER NOT NULL DEFAULT 0, why TEXT, newer INTEGER NOT NULL DEFAULT 0, mask INTEGER NOT NULL DEFAULT 0,
        pend INTEGER NOT NULL DEFAULT 0, fin INTEGER NOT NULL DEFAULT 0, job INTEGER NOT NULL DEFAULT 5
      );
      CREATE UNIQUE INDEX rows_pk ON rows(parent, k);
      CREATE INDEX rows_p ON rows(p);
      CREATE INDEX rows_job ON rows(job, depth, id);
      CREATE INDEX rows_kid_job ON rows(parent, job);
      CREATE INDEX rows_rp ON rows(rp) WHERE rp IS NOT NULL;
    `);
    const p = (s: string) => db.prepare(s);
    this.q = {
      ins: p("INSERT INTO rows (parent, k, p, rp, depth, d, lt, ls, lm, ll, rt, rs, rm, rl, st, why, newer, mask, fin, job) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"),
      byId: p(`SELECT ${COLS} FROM rows WHERE id = ?`),
      byP: p(`SELECT ${COLS} FROM rows WHERE p = ? ORDER BY id LIMIT 1`),
      byRp: p(`SELECT ${COLS} FROM rows WHERE rp = ? ORDER BY id LIMIT 1`),
      setAgg: p("UPDATE rows SET pend = ?, mask = ?, st = ?, why = ?, fin = ? WHERE id = ?"),
      setTimes: p("UPDATE rows SET lm = ?, rm = ? WHERE id = ?"),
      kidAgg: p("SELECT DISTINCT st, mask, fin FROM rows WHERE parent = ?"),
      kidOpen: p("SELECT count(*) AS n FROM rows WHERE parent = ? AND fin = 0"),
      subTally: p("SELECT d, st, count(*) AS n FROM rows WHERE fin = 1 AND (id = ? OR (p >= ? AND p < ?)) GROUP BY d, st"),
      subDel: p("DELETE FROM rows WHERE id = ? OR (p >= ? AND p < ?)"),
      queuedBy: p("SELECT job, count(*) AS n FROM rows WHERE job IN (1, 3) GROUP BY job"),
      kids: p(`SELECT ${COLS} FROM rows WHERE parent = ?`),
      setJob: p("UPDATE rows SET job = ? WHERE id = ?"),
      nextList: p("SELECT id FROM rows WHERE job = 1 ORDER BY depth, id LIMIT ?"),
      nextHash: p("SELECT id FROM rows WHERE job = 3 ORDER BY id LIMIT ?"),
      kidJob: p("SELECT id FROM rows WHERE parent = ? AND job = ? LIMIT ?"),
      listed: p("UPDATE rows SET job = 5, pend = ?, mask = mask | ? WHERE id = ?"),
      fin: p("UPDATE rows SET st = ?, why = ?, fin = 1, job = 5 WHERE id = ?"),
      hashed: p("UPDATE rows SET st = ?, why = ?, newer = ?, fin = 1, job = 5 WHERE id = ?"),
      childDone: p("UPDATE rows SET pend = pend - 1, mask = mask | ? WHERE id = ? RETURNING pend, fin, job"),
      queued: p("SELECT count(*) AS n FROM rows WHERE job IN (1, 2, 3, 4)"),
    };
    this.exclude = compileGlobs(o.exclude, o.ignoreCase);
    this.include = o.include.length ? compileGlobs(o.include, o.ignoreCase) : null;
    this.stats = { dirsScanned: 0, dirsQueued: 1, entries: 0, hashed: 0, hashQueued: 0, hashedBytes: 0, cacheHits: 0, cacheMisses: 0, startedAt: Date.now(), rev: 0, live: false };
    // The root pair: both sides are directories (the job validates that by listing them).
    this.q.ins!.run(0, "", "", null, 0, 1, "dir", 0, 0, null, "dir", 0, 0, null, 0, null, 0, 0, 0, J.LIST);
  }

  /** Folders the UI shows (the current folder and every expanded one): their listings and hashes go first. */
  setFocus(rels: string[]) {
    this.focus = [...new Set(rels)].slice(0, 64);
    this.kick();
  }

  /** Run until every queued listing and hash is done. Throws on cancel or when a root cannot be listed. */
  async run(signal: AbortSignal, progress?: Progress): Promise<void> {
    this.running = true;
    delete this.stats.finishedAt;
    try {
      await this.runLoop(signal, progress);
    } finally {
      this.running = false;
    }
  }

  private async runLoop(signal: AbortSignal, progress?: Progress): Promise<void> {
    const dirConc = Math.max(1, Math.min(32, this.o.dirConcurrency ?? 16));
    const hashConc = Math.max(1, this.o.concurrency);
    const inflight = new Set<Promise<void>>();
    let lists = 0;
    let hashes = 0;
    let fatal: unknown = null;
    const start = (id: number, kind: "list" | "hash") => {
      this.q.setJob!.run(kind === "list" ? J.LISTING : J.HASHING, id);
      kind === "list" ? lists++ : hashes++;
      const t = (kind === "list" ? this.listOne(id, signal) : this.hashOne(id, signal))
        .catch((e) => {
          if (!signal.aborted) fatal = e;
        })
        .finally(() => {
          kind === "list" ? lists-- : hashes--;
          inflight.delete(t);
          if (progress) {
            progress.entries = this.stats.entries;
            progress.totalEntries = 0;
            progress.current = `${this.stats.dirsScanned} folders scanned`;
          }
        });
      inflight.add(t);
    };
    for (;;) {
      if (signal.aborted || fatal) {
        await Promise.allSettled([...inflight]);
        if (fatal) throw fatal;
        throw new FsError(400, "canceled");
      }
      if (lists < dirConc) for (const id of this.pick(J.LIST, dirConc - lists)) start(id, "list");
      if (hashes < hashConc) for (const id of this.pick(J.HASH, hashConc - hashes)) start(id, "hash");
      if (!inflight.size) break;
      await Promise.race([...inflight, new Promise<void>((r) => (this.kick = r))]);
    }
    this.stats.finishedAt = Date.now();
    this.stats.dirsQueued = 0;
    this.stats.hashQueued = 0;
    this.bump("");
  }

  /** Next queued work, folders in focus (and their direct children) first, then breadth first. */
  private pick(job: 1 | 3, n: number): number[] {
    const out: number[] = [];
    const seen = new Set<number>();
    const add = (id: number) => {
      if (out.length < n && !seen.has(id)) {
        seen.add(id);
        out.push(id);
      }
    };
    for (const rel of this.focus) {
      if (out.length >= n) break;
      const r = this.q.byP!.get(rel) as unknown as DbRow | undefined;
      if (!r) continue;
      if (r.job === job) add(r.id);
      for (const k of this.q.kidJob!.all(r.id, job, n) as { id: number }[]) add(k.id);
    }
    if (out.length < n) for (const k of (job === J.LIST ? this.q.nextList! : this.q.nextHash!).all(n * 2) as { id: number }[]) add(k.id);
    return out;
  }

  private key = (name: string) => (this.o.ignoreCase ? name.toLowerCase() : name);
  private wanted(rel: string, e: LsEntry) {
    if (e.n === "." || e.n === ".." || e.n === TRASH_DIR) return false;
    if (this.o.ignoreHidden && e.n.startsWith(".")) return false;
    const isDir = e.t === "dir";
    if (this.exclude.test(rel, isDir)) return false;
    if (!isDir && this.include && !this.include.test(rel, false)) return false;
    return true;
  }

  private async listOne(id: number, signal: AbortSignal) {
    const r = this.q.byId!.get(id) as unknown as DbRow;
    const hasL = r.lt === "dir";
    const hasR = r.rt === "dir";
    if (r.depth >= this.o.depth) {
      if (!this.depthWarned) this.warnSet.add(`Folders deeper than ${this.o.depth} levels were not compared`);
      this.depthWarned = true;
      this.q.listed!.run(0, 0, id);
      if (!r.fin) this.finish(id, BIT.identical, null);
      return;
    }
    const rightRel = r.rp ?? r.p;
    const get = async (src: DirSource, rel: string) => {
      const x = await src.list(rel, signal);
      x.cached ? this.stats.cacheHits++ : this.stats.cacheMisses++;
      return x.entries;
    };
    const [L, R] = await Promise.all([
      hasL ? get(this.left, r.p).catch((e: Error) => e) : Promise.resolve([] as LsEntry[]),
      hasR ? get(this.right, rightRel).catch((e: Error) => e) : Promise.resolve([] as LsEntry[]),
    ]);
    if (signal.aborted || !this.q.byId!.get(id)) return; // canceled, or dropped by a live update meanwhile
    if (L instanceof Error || R instanceof Error) {
      const e = (L instanceof Error ? L : R) as Error;
      const side = L instanceof Error ? "left" : "right";
      if (id === 1) throw new FsError(e instanceof FsError ? (e.status as 400) : 500, `${side} folder: ${e.message}`);
      this.errorCount++;
      this.stats.dirsScanned++;
      this.q.listed!.run(0, 0, id);
      if (!r.fin) this.finish(id, BIT.error, e.message || "could not read folder");
      return;
    }
    const kids = this.children(r, L, R);
    let pend = 0;
    let mask = 0;
    let newDirs = 0;
    let newHashes = 0;
    const db = this.db;
    db.exec("BEGIN");
    try {
      for (const c of kids) {
        this.insert(id, r.depth + 1, c);
        if (c.job === J.LIST) newDirs++;
        if (c.job === J.HASH) newHashes++;
        if (c.fin) mask |= c.st;
        else pend++;
      }
      this.q.listed!.run(pend, mask, id);
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
    this.stats.entries += kids.length;
    this.stats.dirsScanned++;
    this.stats.dirsQueued += newDirs - 1;
    this.stats.hashQueued += newHashes;
    this.bump(r.p);
    // A one-sided folder already has its status; a two-sided one is final once nothing below is open.
    if (!r.fin && pend === 0) this.finish(id, mask & NOT_IDENTICAL ? BIT.different : BIT.identical, mask & NOT_IDENTICAL ? "contents differ" : null);
  }

  /** The child rows a folder should have for two listings (classified; folders and equal-size files queued). */
  private children(r: DbRow, L: LsEntry[], R: LsEntry[]): Kid[] {
    const hasR = r.rt === "dir";
    const rightRel = r.rp ?? r.p;
    const join = (base: string, n: string) => (base ? `${base}/${n}` : n);
    const rmap = new Map<string, LsEntry>();
    for (const e of R) if (this.wanted(join(rightRel, e.n), e) && !rmap.has(this.key(e.n))) rmap.set(this.key(e.n), e);
    const side = (e: LsEntry): Side => ({ t: e.t, s: e.s, m: e.m, ...(e.l !== undefined ? { l: e.l } : {}) });
    const out: Kid[] = [];
    const seen = new Set<string>();
    for (const l of L) {
      const p = join(r.p, l.n);
      if (!this.wanted(p, l)) continue;
      const k = this.key(l.n);
      if (seen.has(k)) continue; // two left names equal ignoring case: the first one wins, like the right side
      seen.add(k);
      const rr = hasR ? rmap.get(k) : undefined;
      if (!rr) {
        out.push({ k, p, rp: null, l, r: null, st: BIT["left-only"], why: null, newer: 0, fin: 1, job: l.t === "dir" ? J.LIST : J.DONE });
        continue;
      }
      rmap.delete(k);
      const rp = join(rightRel, rr.n);
      const v = classify(side(l), side(rr), this.o);
      const rpCol = rp !== p ? rp : null;
      if (v.status === "pending-dir") out.push({ k, p, rp: rpCol, l, r: rr, st: 0, why: null, newer: 0, fin: 0, job: J.LIST });
      else if (v.status === "pending-hash") out.push({ k, p, rp: rpCol, l, r: rr, st: 0, why: null, newer: 0, fin: 0, job: J.HASH });
      else out.push({ k, p, rp: rpCol, l, r: rr, st: BIT[v.status], why: ("why" in v && v.why) || null, newer: "newer" in v && v.newer ? (v.newer === "left" ? 1 : 2) : 0, fin: 1, job: J.DONE });
    }
    for (const [k, rr] of rmap) {
      const p = join(r.p, rr.n);
      const rp = join(rightRel, rr.n);
      out.push({ k, p, rp: rp !== p ? rp : null, l: null, r: rr, st: BIT["right-only"], why: null, newer: 0, fin: 1, job: rr.t === "dir" ? J.LIST : J.DONE });
    }
    return out;
  }
  private insert(parent: number, depth: number, c: Kid) {
    const d = (c.l ?? c.r)!.t === "dir" ? 1 : 0;
    const l = c.l;
    const rr = c.r;
    this.q.ins!.run(parent, c.k, c.p, c.rp, depth, d, l?.t ?? null, l?.s ?? null, l?.m ?? null, l?.l ?? null, rr?.t ?? null, rr?.s ?? null, rr?.m ?? null, rr?.l ?? null, c.st, c.why, c.newer, c.st, c.fin, c.job);
    if (c.fin) this.count(d, c.st);
  }

  private async hashOne(id: number, signal: AbortSignal) {
    const r = this.q.byId!.get(id) as unknown as DbRow;
    let st: number;
    let why: string | null = null;
    let newer = 0;
    try {
      const [a, b] = await Promise.all([this.left.hash(r.p, signal), this.right.hash(r.rp ?? r.p, signal)]);
      if (a === b) st = BIT.identical;
      else {
        st = BIT.different;
        why = "content";
        const dm = (r.lm ?? 0) - (r.rm ?? 0);
        if (Math.abs(dm) > this.o.toleranceMs) newer = dm > 0 ? 1 : 2;
      }
      this.stats.hashedBytes += (r.ls ?? 0) * 2;
      if (!this.q.byId!.get(id)) return; // dropped by a live update meanwhile
    } catch (e) {
      if (signal.aborted) {
        this.q.setJob!.run(J.HASH, id);
        return;
      }
      st = BIT.error;
      why = (e as Error).message || "could not hash";
    }
    this.stats.hashed++;
    this.stats.hashQueued--;
    this.q.hashed!.run(st, why, newer, id);
    this.count(0, st);
    this.bump(r.p.includes("/") ? r.p.slice(0, r.p.lastIndexOf("/")) : "");
    this.propagate(r.parent, st, 0);
  }

  /** Mark a row final with a status and tell its parent. */
  private finish(id: number, st: number, why: string | null) {
    const r = this.q.byId!.get(id) as unknown as DbRow;
    this.q.fin!.run(st, why, id);
    if (r.p !== "") this.count(r.d, st);
    this.bump(r.p.includes("/") ? r.p.slice(0, r.p.lastIndexOf("/")) : "");
    if (r.p === "" ) return;
    this.propagate(r.parent, st, r.mask);
  }
  private propagate(parent: number, st: number, mask: number) {
    if (!parent) return;
    const x = this.q.childDone!.get(st | mask, parent) as { pend: number; fin: number; job: number } | undefined;
    if (!x || x.fin || x.pend > 0 || x.job !== J.DONE) return;
    const p = this.q.byId!.get(parent) as unknown as DbRow;
    this.finish(parent, p.mask & NOT_IDENTICAL ? BIT.different : BIT.identical, p.mask & NOT_IDENTICAL ? "contents differ" : null);
  }

  private bump(rel: string) {
    this.stats.rev++;
    if (this.changed.size < 2048) this.changed.add(rel);
    else this.changedOverflow = true;
  }

  /* ------------------------------------------------------------------ live updates */

  /**
   * Follow both sides' change feeds (inotify on the agents): every changed folder this compare has listed is
   * listed again, its rows are updated in place (unchanged rows and subtrees stay), new work is compared, and
   * the folder's ancestors get their status recomputed.
   */
  startLive(intervalMs = 2000) {
    if (this.liveTimer || this.closed || (!this.left.changes && !this.right.changes)) return;
    this.stats.live = true;
    const tick = async () => {
      try {
        await this.pollChanges();
      } catch {
        /* agent briefly unreachable: try again next tick */
      }
      if (!this.closed) {
        this.liveTimer = setTimeout(() => void tick(), intervalMs);
        this.liveTimer.unref?.();
      }
    };
    this.liveTimer = setTimeout(() => void tick(), intervalMs);
    this.liveTimer.unref?.();
  }

  /** One round of the change feeds (exposed for tests). */
  async pollChanges(): Promise<number> {
    const signal = this.liveAbort.signal;
    const targets = new Set<number>();
    const want = (side: 0 | 1, rel: string) => {
      const r = (side === 1 ? (this.q.byRp!.get(rel) ?? this.q.byP!.get(rel)) : this.q.byP!.get(rel)) as unknown as DbRow | undefined;
      if (!r || !r.d) return;
      if (side === 1 && r.rp && r.rp !== rel) return;
      if (r.job === J.DONE) targets.add(r.id);
      else if (r.job === J.LISTING) this.retry.add(`${side}:${rel}`);
    };
    const old = [...this.retry];
    this.retry.clear();
    for (const x of old) want(Number(x[0]) as 0 | 1, x.slice(2));
    for (const [i, src] of [this.left, this.right].entries()) {
      if (!src.changes) continue;
      const since = this.seq[i] as number;
      const ch = await src.changes(Math.max(0, since), signal);
      this.seq[i] = ch.seq;
      if (since < 0) continue; // first poll: baseline only
      if (ch.reset) for (const rel of this.focus) want(i as 0 | 1, rel);
      for (const d of ch.dirs) want(i as 0 | 1, d);
    }
    let n = 0;
    for (const id of targets) {
      if (n++ >= 256 || this.closed) break;
      await this.relist(id, signal);
    }
    return targets.size;
  }

  private async relist(id: number, signal: AbortSignal) {
    const r = this.q.byId!.get(id) as unknown as DbRow | undefined;
    if (!r || !r.d || r.job !== J.DONE || r.depth >= this.o.depth) return;
    let L: LsEntry[] = [];
    let R: LsEntry[] = [];
    try {
      [L, R] = await Promise.all([
        r.lt === "dir" ? this.left.list(r.p, signal).then((x) => x.entries) : Promise.resolve([]),
        r.rt === "dir" ? this.right.list(r.rp ?? r.p, signal).then((x) => x.entries) : Promise.resolve([]),
      ]);
    } catch {
      return; // gone or unreadable now: its parent's change event will drop it
    }
    const cur = this.q.byId!.get(id) as unknown as DbRow | undefined;
    if (this.closed || !cur || cur.job !== J.DONE) return;
    const have = new Map((this.q.kids!.all(id) as unknown as (DbRow & { k?: string })[]).map((x) => [this.key(x.p.slice(x.p.lastIndexOf("/") + 1)), x]));
    const same = (h: DbRow, c: Kid) => {
      const eq = (t: string | null, sz: number | null, m: number | null, l: string | null, e: LsEntry | null) =>
        (t ?? null) === (e?.t ?? null) && (t === "dir" || ((sz ?? null) === (e?.s ?? null) && (m ?? null) === (e?.m ?? null) && (l ?? null) === (e?.l ?? null)));
      return h.p === c.p && (h.rp ?? null) === c.rp && eq(h.lt, h.ls, h.lm, h.ll, c.l) && eq(h.rt, h.rs, h.rm, h.rl, c.r);
    };
    let changed = false;
    this.db.exec("BEGIN");
    try {
      for (const c of this.children(cur, L, R)) {
        // match on the stored name's key (rows written before keep their spelling)
        const h = have.get(c.k);
        have.delete(c.k);
        if (h && same(h, c)) {
          if (h.d && (h.lm !== (c.l?.m ?? null) || h.rm !== (c.r?.m ?? null))) this.q.setTimes!.run(c.l?.m ?? null, c.r?.m ?? null, h.id);
          continue;
        }
        if (h) this.drop(h);
        this.insert(id, cur.depth + 1, c);
        changed = true;
      }
      for (const h of have.values()) {
        this.drop(h);
        changed = true;
      }
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
    if (!changed) return;
    for (const x of this.q.queuedBy!.all() as { job: number; n: number }[]) x.job === J.LIST ? (this.stats.dirsQueued = x.n) : (this.stats.hashQueued = x.n);
    this.bump(cur.p);
    this.refreshUp(id);
    if (!this.running && !this.closed) void this.run(signal).catch(() => undefined);
    else this.kick();
  }

  /** Remove a row and everything below it, taking its final rows out of the tallies. */
  private drop(h: DbRow) {
    const lo = h.p + "/";
    const hi = h.p + "0";
    for (const x of this.q.subTally!.all(h.id, lo, hi) as { d: number; st: number; n: number }[]) this.count(x.d, x.st, -x.n);
    this.q.subDel!.run(h.id, lo, hi);
  }

  /** Recompute a two-sided folder's status from its children, then its ancestors' (after a live update). */
  private refreshUp(id: number) {
    for (let at = id; at; ) {
      const r = this.q.byId!.get(at) as unknown as DbRow | undefined;
      if (!r) return;
      if (r.lt !== "dir" || r.rt !== "dir") return; // one-sided: its own status does not depend on what is inside
      let mask = 0;
      for (const x of this.q.kidAgg!.all(at) as { st: number; mask: number; fin: number }[]) if (x.fin) mask |= x.st | x.mask;
      const open = (this.q.kidOpen!.get(at) as { n: number }).n;
      const fin = open === 0 && r.job === J.DONE ? 1 : 0;
      const st = fin ? (mask & NOT_IDENTICAL ? BIT.different : BIT.identical) : 0;
      const why = st === BIT.different ? "contents differ" : null;
      if (r.p !== "") {
        if (r.fin) this.count(r.d, r.st, -1);
        if (fin) this.count(r.d, st);
      }
      this.q.setAgg!.run(open, mask, st, why, fin, at);
      this.bump(r.p.includes("/") ? r.p.slice(0, r.p.lastIndexOf("/")) : "");
      at = r.parent;
    }
  }

  /* ------------------------------------------------------------------ reads for the UI */

  private view(r: DbRow): ViewRow {
    const l: Side | undefined = r.lt ? { t: r.lt as Side["t"], s: r.ls ?? 0, m: r.lm ?? 0, ...(r.ll !== null ? { l: r.ll } : {}) } : undefined;
    const rr: Side | undefined = r.rt ? { t: r.rt as Side["t"], s: r.rs ?? 0, m: r.rm ?? 0, ...(r.rl !== null ? { l: r.rl } : {}) } : undefined;
    return {
      p: r.p,
      ...(r.rp ? { rp: r.rp } : {}),
      status: r.fin ? (NAME[r.st] ?? "error") : "pending",
      ...(l ? { l } : {}),
      ...(rr ? { r: rr } : {}),
      ...(r.newer ? { newer: r.newer === 1 ? ("left" as const) : ("right" as const) } : {}),
      ...(r.why ? { why: r.why } : {}),
      ...(r.d ? { mask: r.mask, listed: r.job === J.DONE } : {}),
    };
  }

  /** The rows of one folder (relative path, "" = root) with their current state. */
  folder(rel: string): FolderView | null {
    const r = this.q.byP!.get(rel) as unknown as DbRow | undefined;
    if (!r || !r.d) return null;
    return { rel, listed: r.job === J.DONE, status: r.fin ? (NAME[r.st] ?? "error") : "pending", rows: (this.q.kids!.all(r.id) as unknown as DbRow[]).map((x) => this.view(x)), rev: this.stats.rev };
  }

  /** Every row below (and including) the given folders, for sync planning on a selection. */
  *subtree(rels: string[]): Generator<ViewRow> {
    const q = this.db.prepare(`SELECT ${COLS} FROM rows WHERE id > 1 AND p >= ? AND p < ? ORDER BY p`);
    const one = this.q.byP!;
    for (const rel of rels) {
      if (rel === "") {
        for (const x of q.iterate("", "￿") as Iterable<DbRow>) yield this.view(x);
        continue;
      }
      const self = one.get(rel) as unknown as DbRow | undefined;
      if (self) yield this.view(self);
      for (const x of q.iterate(rel + "/", rel + "0") as Iterable<DbRow>) yield this.view(x);
    }
  }

  /** Paths of final rows with one of the given statuses (whole tree). */
  *withStatus(statuses: Status[]): Generator<string> {
    const bits = statuses.map((s) => BIT[s]).filter(Boolean);
    if (!bits.length) return;
    const q = this.db.prepare(`SELECT p FROM rows WHERE id > 1 AND fin = 1 AND st IN (${bits.join(",")}) ORDER BY p`);
    for (const x of q.iterate() as Iterable<{ p: string }>) yield x.p;
  }

  /** Folders whose rows changed since the last call (null = too many, refetch everything shown). */
  takeChanged(): string[] | null {
    const out = this.changedOverflow ? null : [...this.changed];
    this.changed.clear();
    this.changedOverflow = false;
    return out;
  }

  counts(): { files: Counts; dirs: Counts } {
    const mk = (t: Record<number, number>): Counts => ({ identical: t[1] ?? 0, different: t[2] ?? 0, leftOnly: t[4] ?? 0, rightOnly: t[8] ?? 0, error: t[16] ?? 0 });
    return { files: mk(this.tally[0]), dirs: mk(this.tally[1]) };
  }

  /** All rows (tests and the legacy whole-result endpoint), ordered by path. */
  rows(limit = Infinity): Row[] {
    const out: Row[] = [];
    for (const v of this.subtree([""])) {
      if (out.length >= limit) break;
      out.push({ ...v, status: v.status === "pending" ? "error" : v.status } as Row);
    }
    return out;
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.liveTimer);
    this.liveAbort.abort();
    this.kick();
    try {
      this.db.close();
    } catch {
      /* closed */
    }
    if (this.file !== ":memory:") for (const f of [this.file, this.file + "-wal", this.file + "-shm"]) fs.rmSync(f, { force: true });
  }
}
