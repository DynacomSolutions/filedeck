import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";

/** One row of the helper's output: the IO a process (in a cgroup) did to a device in the helper's interval. */
export interface TraceRow {
  dev: string;
  cg: number;
  pid: number;
  comm: string;
  r: number;
  w: number;
  rb: number;
  wb: number;
}

export type TraceState = "off" | "starting" | "running" | "failed";

export interface IoTraceOptions {
  /** path of filedeck-iotrace */
  helper: string;
  intervalMs: number;
  now?: () => number;
  log?: (s: string) => void;
  /** replaces child_process.spawn (tests) */
  spawn?: (cmd: string, args: string[]) => ChildProcess;
  /** a helper that sends no first line within this long is stopped (default 5 s) */
  startMs?: number;
  /** after a failure the helper is not started again for this long (default 5 min) */
  retryMs?: number;
}

const MAX_KEYS = 8192;
const MAX_LINE = 4 * 1024 * 1024;

/**
 * The eBPF helper (server/native/filedeck-iotrace): it prints one JSON line per interval, with the IO deltas of that interval. The helper is
 * started while somebody reads the pressure and stopped when nobody does. Any failure (no helper, a first line `{"ok":false}`, a crash, a silent
 * helper) puts it in `failed`: the collector then uses /proc and /sys, and the helper is tried again after `retryMs`.
 */
export class IoTrace {
  state: TraceState = "off";
  private child?: ChildProcess;
  private buf = "";
  private rows = new Map<string, TraceRow>();
  private since = 0;
  private failedAt = 0;
  private startTimer?: NodeJS.Timeout;
  private warned = false;
  private lastLineAt = 0;
  private readonly o: Required<Omit<IoTraceOptions, "log">> & { log?: (s: string) => void };

  constructor(opts: IoTraceOptions) {
    this.o = { now: opts.now ?? Date.now, startMs: opts.startMs ?? 5000, retryMs: opts.retryMs ?? 300_000, spawn: opts.spawn ?? ((c, a) => nodeSpawn(c, a, { stdio: ["ignore", "pipe", "pipe"] })), log: opts.log, helper: opts.helper, intervalMs: opts.intervalMs };
  }

  /** Start the helper, unless it is running or failed lately. Never throws. */
  start(): void {
    if (!this.o.helper || this.child) return;
    if (this.state === "failed" && this.o.now() - this.failedAt < this.o.retryMs) return;
    this.state = "starting";
    this.rows.clear();
    this.buf = "";
    this.since = this.o.now();
    let child: ChildProcess;
    try {
      child = this.o.spawn(this.o.helper, ["--interval-ms", String(this.o.intervalMs)]);
    } catch (e) {
      this.fail(`could not start (${(e as Error).message})`);
      return;
    }
    this.child = child;
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (d: string) => this.data(child, d));
    child.stderr?.on("data", () => undefined);
    child.on("error", (e) => this.fail(`could not start (${e.message})`, child));
    child.on("exit", (code) => {
      if (this.child === child) this.fail(`exited with code ${code}`, child);
    });
    this.startTimer = setTimeout(() => {
      if (this.state === "starting") this.fail("sent no first line", child);
    }, this.o.startMs);
    this.startTimer.unref();
  }

  /** Stop the helper (nobody reads the pressure). It is not a failure. */
  stop(): void {
    clearTimeout(this.startTimer);
    const c = this.child;
    this.child = undefined;
    if (c) {
      try {
        c.kill("SIGTERM");
      } catch {
        /* gone */
      }
    }
    if (this.state !== "failed") this.state = "off";
    this.rows.clear();
    this.buf = "";
  }

  private fail(why: string, child?: ChildProcess): void {
    if (child && this.child !== child) return;
    clearTimeout(this.startTimer);
    const c = this.child;
    this.child = undefined;
    if (c) {
      try {
        c.kill("SIGKILL");
      } catch {
        /* gone */
      }
    }
    this.state = "failed";
    this.failedAt = this.o.now();
    this.rows.clear();
    if (!this.warned) {
      this.warned = true;
      this.o.log?.(`disk pressure: eBPF helper ${why}; using /proc and /sys instead`);
    }
  }

  private data(child: ChildProcess, d: string): void {
    if (this.child !== child) return;
    this.buf += d;
    if (this.buf.length > MAX_LINE && !this.buf.includes("\n")) return this.fail("sent a line that is too long", child);
    let i: number;
    while ((i = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, i);
      this.buf = this.buf.slice(i + 1);
      if (line.trim()) this.line(child, line);
      if (this.child !== child) return;
    }
  }

  private line(child: ChildProcess, line: string): void {
    let m: { ok?: boolean; error?: string; rows?: unknown };
    try {
      m = JSON.parse(line);
    } catch {
      return this.fail("sent a line that is not JSON", child);
    }
    if (m.ok !== true) return this.fail(`failed (${typeof m.error === "string" ? m.error.slice(0, 120) : "no reason"})`, child);
    if (this.state === "starting") {
      clearTimeout(this.startTimer);
      this.state = "running";
    }
    this.lastLineAt = this.o.now();
    if (!Array.isArray(m.rows)) return;
    for (const r of m.rows as Partial<TraceRow>[]) {
      if (typeof r?.dev !== "string" || typeof r.cg !== "number") continue;
      const row: TraceRow = { dev: r.dev, cg: r.cg, pid: Number(r.pid) || 0, comm: String(r.comm ?? "").slice(0, 32), r: Number(r.r) || 0, w: Number(r.w) || 0, rb: Number(r.rb) || 0, wb: Number(r.wb) || 0 };
      const k = `${row.dev}|${row.cg}|${row.pid}`;
      const e = this.rows.get(k);
      if (e) {
        e.r += row.r;
        e.w += row.w;
        e.rb += row.rb;
        e.wb += row.wb;
        if (row.comm) e.comm = row.comm;
      } else if (this.rows.size < MAX_KEYS) this.rows.set(k, row);
    }
  }

  /** The rows added up since the last call and the time they cover (ms). Empty while the helper does not run. */
  take(): { rows: TraceRow[]; ms: number } {
    const now = this.o.now();
    const out = { rows: [...this.rows.values()], ms: Math.max(1, now - this.since) };
    this.rows = new Map();
    this.since = now;
    return out;
  }

  /** ms since the last good line, or Infinity */
  get silentMs(): number {
    return this.lastLineAt ? this.o.now() - this.lastLineAt : Infinity;
  }
}
