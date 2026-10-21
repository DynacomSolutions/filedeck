import { spawn as nodeSpawn } from "node:child_process";
import type { EventEmitter } from "node:events";
import type { Readable } from "node:stream";
import { listMounts } from "./mounts.ts";
import { TRASH_DIR } from "./paths.ts";

/**
 * Keeps the size store current from kernel change notifications (fanotify, via the small native helper
 * `filedeck-fanwatch`, see server/native). The helper prints one line per changed directory:
 *   #ready N | x PATH (entry added, removed, moved, attributes) | w PATH (file closed after writing) | m PATH (file modified) | !overflow
 * Each changed folder goes to `SizeStore.applyChanged`, debounced per folder (pending folders live in the size store's SQLite file, see SizeStore.notePending): structure changes and closed writes
 * settle for `settleMs`, an ongoing write (modify) re-reads a folder at most every `modifyMs`.
 * Without the helper, the capabilities or kernel support the agent logs once and keeps the TTL/mtime behaviour.
 */

export interface HelperProc extends EventEmitter {
  stdout: Readable | null;
  stderr: Readable | null;
  kill(): boolean;
}
export type SpawnHelper = (cmd: string, args: string[]) => HelperProc;

export interface FanWatchOptions {
  /** helper binary; empty = disabled */
  helper: string;
  root: string;
  procMounts: string;
  settleMs?: number;
  modifyMs?: number;
  spawn?: SpawnHelper;
  /** restart backoff after an unexpected helper exit */
  restartMinMs?: number;
  restartMaxMs?: number;
  /** pending changed folders held in memory (only while the store is unusable) before the burst is treated like a kernel overflow */
  maxPending?: number;
}

export interface ChangeSink {
  applyChanged(virtual: string): Promise<void>;
  markStale(virtual: string): void;
  /** keep changed folders on disk: false when that is not possible (the watcher then keeps them in memory) */
  notePending?(items: { path: string; dueAt: number; modify: boolean }[], modifyMs: number): Promise<boolean>;
  /** folders due at `now` (oldest first, at most `limit`), marked as run; null = the backlog is too old to drain, the pending rows are dropped */
  takeDue?(now: number, limit: number, t: { modifyMs: number; settleMs: number }): Promise<string[] | null>;
  /** folders that ran within `withinMs` (a crash may have cut the run short) */
  recentRuns?(now: number, withinMs: number, limit: number): string[];
  clearPending?(): Promise<void>;
}

const MAXFS = 256;
const FLUSH_MS = 250;
const FLUSH_MAX = 2000;
const DRAIN_BATCH = 256;

/** Agent virtual path of a helper path (as the helper's mount namespace sees it, i.e. under the agent root), or null outside the root or inside a trash store. */
export function mapPath(root: string, hostPath: string): string | null {
  if (!hostPath.startsWith("/")) return null;
  let v: string;
  if (root === "/") v = hostPath;
  else if (hostPath === root) v = "/";
  else if (hostPath.startsWith(root + "/")) v = hostPath.slice(root.length);
  else return null;
  return v.split("/").includes(TRASH_DIR) ? null : v;
}

/** Inverse of the helper's escaping: `\\` and `\xHH`. Lines are split on "\n" only, which the helper never leaves unescaped inside a path. */
export const unescapeLine = (s: string) => s.replace(/\\(?:(\\)|x([0-9a-f]{2}))/g, (_, b?: string, h?: string) => (b ? "\\" : String.fromCharCode(parseInt(h!, 16))));

export class FanWatch {
  private proc: HelperProc | null = null;
  /** events not yet handed to the store: the only per-folder state in memory, at most FLUSH_MAX entries */
  private buf = new Map<string, { at: number; modify: boolean }>();
  private inflight = 0;
  /** the store is read for due folders only until this time (events were noted lately) or after a take that found some; the first drain always reads */
  private activeUntil = 0;
  private firstTake = true;
  private recovered = false;
  private resume: (() => void) | null = null;
  private timer: NodeJS.Timeout | null = null;
  /** fallback while the store is unusable: due time per folder (capped by maxPending), and last runs for the modify interval */
  private mem = new Map<string, number>();
  private lastRun = new Map<string, number>();
  private draining = false;
  private stopped = false;
  private warned = false;
  private marks: string[] = [];
  private unwatched: string[] = [];
  /** when the helper reported #ready (every mark is in place); Infinity while it is not running or not ready */
  private readyAt = Infinity;
  private settleMs: number;
  private modifyMs: number;

  constructor(
    private store: ChangeSink,
    private o: FanWatchOptions,
  ) {
    this.settleMs = o.settleMs ?? 1000;
    this.modifyMs = o.modifyMs ?? 30_000;
  }

  private warn(msg: string) {
    if (this.warned) return;
    this.warned = true;
    console.error(`fanotify watcher off, folder sizes refresh by age and folder mtime only: ${msg}`);
  }

  private lastLog = 0;
  private backoff = 0;
  private restartTimer: NodeJS.Timeout | null = null;
  private note(msg: string) {
    if (Date.now() - this.lastLog < 60_000) return;
    this.lastLog = Date.now();
    console.error(`fanotify watcher: ${msg}`);
  }

  /** Spawn the helper for every local filesystem under the root. Never throws. */
  async start(): Promise<void> {
    if (!this.o.helper || this.proc || this.stopped) return;
    this.ensureTimer(); // also drains folders a previous run left pending
    try {
      const all = await listMounts(this.o.root, this.o.procMounts);
      const mounts = all.filter((m) => !m.network && !m.unreachable);
      this.unwatched = all.filter((m) => m.network || m.unreachable).map((m) => m.mountpoint);
      const hostPaths = mounts.map((m) => (this.o.root === "/" ? m.mountpoint : this.o.root + (m.mountpoint === "/" ? "" : m.mountpoint)));
      // the helper marks at most MAXFS filesystems (server/native): the rest are not watched
      this.marks = mounts.slice(0, MAXFS).map((m) => m.mountpoint);
      this.unwatched.push(...mounts.slice(MAXFS).map((m) => m.mountpoint));
      hostPaths.length = Math.min(hostPaths.length, MAXFS);
      if (!hostPaths.length) return this.warn("no local filesystem under the root");
      if (!this.recovered && this.store.recentRuns) {
        // folders taken just before a stop or crash may not have been applied: re-read them on the next read
        this.recovered = true;
        const recent = this.store.recentRuns(Date.now(), 60_000, 1001);
        for (const m of recent.length > 1000 ? this.marks : recent) this.store.markStale(m);
      }
      if (this.stopped) return;
      const p = (this.o.spawn ?? ((c, a) => nodeSpawn(c, a, { stdio: ["ignore", "pipe", "pipe"] }) as unknown as HelperProc))(this.o.helper, hostPaths);
      this.proc = p;
      this.readyAt = Infinity;
      let err = "";
      p.stderr?.on("data", (d: Buffer) => (err = (err + d).slice(-500)));
      p.on("error", (e: Error) => this.warn(e.message));
      p.on("exit", (code: number | null, sig: string | null) => {
        if (this.proc !== p) return;
        this.proc = null;
        this.readyAt = Infinity;
        if (this.stopped) return;
        // 2 = not permitted, 3 = not supported: retrying cannot help. Anything else may have lost events.
        if (code === 2 || code === 3 || !this.o.helper) return this.warn(err.trim() || `helper exited (${code})`);
        for (const m of this.marks) this.store.markStale(m);
        this.backoff = Math.min(this.o.restartMaxMs ?? 300_000, this.backoff ? this.backoff * 2 : (this.o.restartMinMs ?? 1000));
        this.note(`helper exited (${code ?? sig}${err.trim() ? ": " + err.trim() : ""}), restarting in ${this.backoff} ms`);
        this.restartTimer = setTimeout(() => void this.start(), this.backoff);
        this.restartTimer.unref();
      });
      let buf = "";
      p.stdout?.setEncoding?.("utf8");
      p.stdout?.on("data", (d: string | Buffer) => {
        buf += d;
        let i;
        while ((i = buf.indexOf("\n")) >= 0) {
          this.line(buf.slice(0, i));
          buf = buf.slice(i + 1);
        }
        if (buf.length > 65_536) buf = ""; // no helper line is this long
        // the store is behind: stop reading until it has taken what is in flight
        if (this.inflight >= 4 && p.stdout?.pause) {
          p.stdout.pause();
          this.resume = () => {
            if (this.inflight >= 4) return;
            this.resume = null;
            p.stdout?.resume();
          };
        }
      });
    } catch (e) {
      this.warn((e as Error).message);
    }
  }

  /**
   * True when the helper is running and `virtual` lies on a watched filesystem with no unwatched one below it, so stored sizes are kept current.
   * Overflow and exit mark the rows stale, so the next read re-scans them and is current again.
   */
  covers(virtual: string): boolean {
    if (!this.proc || this.readyAt === Infinity) return false; // marks are not all in place yet
    const under = (dir: string, v: string) => dir === "/" || v === dir || v.startsWith(dir + "/");
    const home = (v: string, dirs: string[]) => dirs.filter((d) => under(d, v)).reduce((a, d) => Math.max(a, d.length), -1);
    if (home(virtual, this.marks) <= home(virtual, this.unwatched)) return false;
    return !this.unwatched.some((d) => d !== virtual && under(virtual, d));
  }

  /** Rows written before this time were not watched while they aged (the restart gap): the size store gives them the TTL rule, not the watcher's trust. */
  watchedSince(): number {
    return this.readyAt;
  }

  stop() {
    this.stopped = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.buf.clear();
    this.mem.clear();
    this.proc?.kill();
    this.proc = null;
    this.readyAt = Infinity;
  }

  /** One helper output line. */
  line(l: string) {
    if (l === "!overflow") return this.overflow();
    if (l.startsWith("#ready")) {
      this.backoff = 0;
      this.readyAt = Date.now();
    }
    if (l.startsWith("c ")) {
      const host = unescapeLine(l.slice(2));
      const v = mapPath(this.o.root, host);
      if (v) this.unwatched.push(v); // the mark failed: stored sizes there are never trusted past the TTL
      return void this.note(`cannot watch ${host}, changes there are seen only by age and folder mtime`);
    }
    const kind = l[0];
    if ((kind !== "x" && kind !== "w" && kind !== "m") || l[1] !== " ") return;
    const v = mapPath(this.o.root, unescapeLine(l.slice(2)));
    if (v) this.schedule(v, kind === "m");
  }

  /** Events were lost: forget the pending folders and let the next read re-scan the watched trees. */
  private overflow() {
    this.buf.clear();
    this.mem.clear();
    void this.store.clearPending?.();
    for (const m of this.marks) this.store.markStale(m);
  }

  private ensureTimer() {
    if (this.timer || this.stopped) return;
    this.timer = setInterval(() => void this.tick(), Math.max(10, Math.min(FLUSH_MS, this.settleMs)));
    this.timer.unref();
  }

  private schedule(v: string, modify: boolean) {
    this.ensureTimer();
    const cur = this.buf.get(v);
    // a settle event wins over a modify event: it is not held back by the modify interval
    this.buf.set(v, { at: cur ? Math.min(cur.at, Date.now() + this.settleMs) : Date.now() + this.settleMs, modify: (cur?.modify ?? true) && modify });
    if (this.buf.size >= FLUSH_MAX) void this.flush();
  }

  /** Hand the buffered events to the store (disk). With no usable store they wait in memory, capped like the old behaviour. */
  private async flush(): Promise<void> {
    if (!this.buf.size) return;
    const items = [...this.buf].map(([path, e]) => ({ path, dueAt: e.at, modify: e.modify }));
    this.buf = new Map();
    this.inflight++;
    try {
      if (this.store.notePending && (await this.store.notePending(items, this.modifyMs))) return void (this.activeUntil = Date.now() + this.modifyMs + this.settleMs);
      this.keepInMemory(items);
    } finally {
      this.inflight--;
      this.resume?.();
    }
  }

  private keepInMemory(items: { path: string; dueAt: number; modify: boolean }[]) {
    for (const i of items) {
      const at = i.modify ? Math.max(i.dueAt, (this.lastRun.get(i.path) ?? 0) + this.modifyMs) : i.dueAt;
      const cur = this.mem.get(i.path);
      if (cur !== undefined && cur <= at) continue;
      if (cur === undefined && this.mem.size >= (this.o.maxPending ?? 50_000)) {
        this.note("too many changed folders pending, treating it as an overflow");
        this.mem.clear();
        for (const m of this.marks) this.store.markStale(m);
        return;
      }
      this.mem.set(i.path, at);
    }
  }

  private async tick() {
    await this.flush();
    await this.drain();
  }

  /** Apply the folders whose time has come, one after the other, taking them from the store a batch at a time. */
  private async drain() {
    if (this.draining) return;
    this.draining = true;
    try {
      while (!this.stopped) {
        const now = Date.now();
        let batch: string[] | null = [];
        if (this.store.takeDue && (this.firstTake || now <= this.activeUntil)) {
          this.firstTake = false;
          batch = await this.store.takeDue(now, DRAIN_BATCH, { modifyMs: this.modifyMs, settleMs: this.settleMs });
          if (batch === null) {
            this.note("changed folders are too far behind, treating it as an overflow");
            for (const m of this.marks) this.store.markStale(m);
            break;
          }
        }
        if (!batch.length && this.mem.size) {
          batch = [...this.mem].filter(([, at]) => at <= now).slice(0, DRAIN_BATCH).map(([p]) => p);
          for (const p of batch) {
            this.mem.delete(p);
            this.lastRun.delete(p);
            this.lastRun.set(p, now);
          }
          // insertion order = age order: drop the old ones from the front, stop at the first young one
          for (const [k, t] of this.lastRun) {
            if (now - t <= this.modifyMs) break;
            this.lastRun.delete(k);
          }
        }
        if (!batch.length) break;
        for (const v of batch) {
          if (this.stopped) break;
          try {
            await this.store.applyChanged(v);
          } catch {
            /* a folder that vanished or cannot be read: the next scan deals with it */
          }
        }
        if (this.store.takeDue) this.activeUntil = Math.max(this.activeUntil, Date.now() + this.modifyMs + this.settleMs); // rows may remain after a slow batch
      }
    } finally {
      this.draining = false;
    }
  }
}
