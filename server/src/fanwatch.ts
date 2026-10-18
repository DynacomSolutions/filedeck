import { spawn as nodeSpawn } from "node:child_process";
import type { EventEmitter } from "node:events";
import { createInterface } from "node:readline";
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

export const unescapeLine = (s: string) => s.replace(/\\([\\n])/g, (_, c: string) => (c === "n" ? "\n" : "\\"));

export class FanWatch {
  private proc: HelperProc | null = null;
  private due = new Map<string, { at: number; timer: NodeJS.Timeout }>();
  private lastRun = new Map<string, number>();
  private queue = new Set<string>();
  private draining = false;
  private stopped = false;
  private warned = false;
  private marks: string[] = [];
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

  /** Spawn the helper for every local filesystem under the root. Never throws. */
  async start(): Promise<void> {
    if (!this.o.helper || this.proc || this.stopped) return;
    try {
      const mounts = (await listMounts(this.o.root, this.o.procMounts)).filter((m) => !m.network && !m.unreachable);
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
        this.proc = null;
        if (!this.stopped) this.warn(err.trim() || `helper exited (${code ?? sig})`);
      });
      if (p.stdout) createInterface({ input: p.stdout }).on("line", (l) => this.line(l));
    } catch (e) {
      this.warn((e as Error).message);
    }
  }

  stop() {
    this.stopped = true;
    for (const d of this.due.values()) clearTimeout(d.timer);
    this.due.clear();
    this.queue.clear();
    this.proc?.kill();
    this.proc = null;
  }

  /** One helper output line. */
  line(l: string) {
    if (l === "!overflow") {
      for (const m of this.marks) this.store.markStale(m);
      return;
    }
    const kind = l[0];
    if ((kind !== "x" && kind !== "w" && kind !== "m") || l[1] !== " ") return;
    const v = mapPath(this.o.root, unescapeLine(l.slice(2)));
    if (v) this.schedule(v, kind === "m");
  }

  private schedule(v: string, modify: boolean) {
    const now = Date.now();
    let at = now + this.settleMs;
    if (modify) at = Math.max(at, (this.lastRun.get(v) ?? 0) + this.modifyMs);
    const cur = this.due.get(v);
    if (cur && cur.at <= at) return;
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
        this.lastRun.set(v, Date.now());
        if (this.lastRun.size > 10_000) for (const [k, t] of this.lastRun) if (Date.now() - t > this.modifyMs) this.lastRun.delete(k);
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
