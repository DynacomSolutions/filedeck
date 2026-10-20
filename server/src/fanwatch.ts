import { spawn as nodeSpawn } from "node:child_process";
import type { EventEmitter } from "node:events";
import type { Readable } from "node:stream";
import { listMounts } from "./mounts.ts";
import { TRASH_DIR } from "./paths.ts";

/**
 * Keeps the size store current from kernel change notifications (fanotify, via the small native helper
 * `filedeck-fanwatch`, see server/native). The helper prints one line per changed directory:
 *   #ready N | x PATH (entry added, removed, moved, attributes) | w PATH (file closed after writing) | m PATH (file modified) | !overflow
 * Each changed folder goes to `SizeStore.applyChanged`, debounced per folder: structure changes and closed writes
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
  /** pending changed folders (timers plus queue) before the burst is treated like a kernel overflow */
  maxPending?: number;
}

export interface ChangeSink {
  applyChanged(virtual: string): Promise<void>;
  markStale(virtual: string): void;
}

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
  private due = new Map<string, { at: number; timer: NodeJS.Timeout }>();
  private lastRun = new Map<string, number>();
  private queue = new Set<string>();
  private draining = false;
  private stopped = false;
  private warned = false;
  private marks: string[] = [];
  private unwatched: string[] = [];
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
    try {
      const all = await listMounts(this.o.root, this.o.procMounts);
      const mounts = all.filter((m) => !m.network && !m.unreachable);
      this.unwatched = all.filter((m) => m.network || m.unreachable).map((m) => m.mountpoint);
      const hostPaths = mounts.map((m) => (this.o.root === "/" ? m.mountpoint : this.o.root + (m.mountpoint === "/" ? "" : m.mountpoint)));
      this.marks = mounts.map((m) => m.mountpoint);
      if (!hostPaths.length) return this.warn("no local filesystem under the root");
      if (this.stopped) return;
      const p = (this.o.spawn ?? ((c, a) => nodeSpawn(c, a, { stdio: ["ignore", "pipe", "pipe"] }) as unknown as HelperProc))(this.o.helper, hostPaths);
      this.proc = p;
      let err = "";
      p.stderr?.on("data", (d: Buffer) => (err = (err + d).slice(-500)));
      p.on("error", (e: Error) => this.warn(e.message));
      p.on("exit", (code: number | null, sig: string | null) => {
        if (this.proc !== p) return;
        this.proc = null;
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
    if (!this.proc) return false;
    const under = (dir: string, v: string) => dir === "/" || v === dir || v.startsWith(dir + "/");
    const home = (v: string, dirs: string[]) => dirs.filter((d) => under(d, v)).reduce((a, d) => Math.max(a, d.length), -1);
    if (home(virtual, this.marks) <= home(virtual, this.unwatched)) return false;
    return !this.unwatched.some((d) => d !== virtual && under(virtual, d));
  }

  stop() {
    this.stopped = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    for (const d of this.due.values()) clearTimeout(d.timer);
    this.due.clear();
    this.queue.clear();
    this.proc?.kill();
    this.proc = null;
  }

  /** One helper output line. */
  line(l: string) {
    if (l === "!overflow") return this.dropPending();
    if (l.startsWith("#ready")) this.backoff = 0;
    if (l.startsWith("c ")) return void this.note(`cannot watch ${unescapeLine(l.slice(2))}, changes there are seen only by age and folder mtime`);
    const kind = l[0];
    if ((kind !== "x" && kind !== "w" && kind !== "m") || l[1] !== " ") return;
    const v = mapPath(this.o.root, unescapeLine(l.slice(2)));
    if (v) this.schedule(v, kind === "m");
  }

  /** Events were lost or are too many to track: forget the pending folders and let the next read re-scan the watched trees. */
  private dropPending() {
    for (const d of this.due.values()) clearTimeout(d.timer);
    this.due.clear();
    this.queue.clear();
    for (const m of this.marks) this.store.markStale(m);
  }

  private schedule(v: string, modify: boolean) {
    const now = Date.now();
    let at = now + this.settleMs;
    if (modify) at = Math.max(at, (this.lastRun.get(v) ?? 0) + this.modifyMs);
    const cur = this.due.get(v);
    if (cur && cur.at <= at) return;
    // a bulk write adds one entry per folder while drain waits on size scans: bound memory by acting as on a kernel overflow
    if (!cur && this.due.size + this.queue.size >= (this.o.maxPending ?? 50_000)) {
      this.note("too many changed folders pending, treating it as an overflow");
      return this.dropPending();
    }
    if (cur) clearTimeout(cur.timer);
    const timer = setTimeout(() => {
      this.due.delete(v);
      this.queue.add(v);
      void this.drain();
    }, at - now);
    timer.unref();
    this.due.set(v, { at, timer });
  }

  private async drain() {
    if (this.draining) return;
    this.draining = true;
    try {
      for (let v; !this.stopped && (v = this.queue.values().next().value as string | undefined) !== undefined; ) {
        this.queue.delete(v);
        // insertion order = age order: drop the old ones from the front, stop at the first young one
        this.lastRun.delete(v);
        this.lastRun.set(v, Date.now());
        for (const [k, t] of this.lastRun) {
          if (Date.now() - t <= this.modifyMs) break;
          this.lastRun.delete(k);
        }
        try {
          await this.store.applyChanged(v);
        } catch {
          /* a folder that vanished or cannot be read: the next scan deals with it */
        }
      }
    } finally {
      this.draining = false;
    }
  }
}
