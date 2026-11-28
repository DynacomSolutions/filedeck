import { spawn, type ChildProcess } from "node:child_process";
import { Deadline } from "./deadline.ts";

/** One row of the output of filedeck-iotrace (docs/disk-pressure.md). */
export type IotraceRow = { dev: string; cg: number; pid: number; comm: string; r: number; w: number; rb: number; wb: number };
/** The change since the previous read. `source` tells which collector made it: the eBPF helper or the proc and cgroup fallback. */
export type IotraceSample = { t: number; rows: IotraceRow[]; source: "ebpf" | "proc" };

/** Reads the kernel maps of the helper once per call. It holds no timer. */
export interface IotraceSource {
  read(): Promise<{ t: number; rows: IotraceRow[] }>;
  close(): void;
}

/**
 * The helper process. It is started by the first read and waits on its stdin: one "read" line gives one JSON line back. It has no timer.
 * A failure line (`ok:false`), an exit or a spawn error rejects the read.
 */
export function helperSource(bin: string): IotraceSource {
  let child: ChildProcess | undefined;
  let buf = "";
  let waiting: { ok: (v: { t: number; rows: IotraceRow[] }) => void; fail: (e: Error) => void } | undefined;
  const end = (e: Error) => {
    const w = waiting;
    waiting = undefined;
    child = undefined;
    w?.fail(e);
  };
  const start = () => {
    const c = spawn(bin, [], { stdio: ["pipe", "pipe", "ignore"] });
    child = c;
    buf = "";
    c.stdout!.on("data", (d: Buffer) => {
      buf += d.toString();
      const nl = buf.indexOf("\n");
      if (nl < 0) return;
      const text = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      try {
        const o = JSON.parse(text);
        if (o.ok !== true) return end(new Error(String(o.error ?? "the helper failed")));
        const w = waiting;
        waiting = undefined;
        w?.ok({ t: o.t, rows: o.rows });
      } catch (e) {
        end(e as Error);
      }
    });
    c.stdin!.on("error", () => {});
    c.on("error", (e) => end(e));
    c.on("exit", (code) => {
      if (child === c) end(new Error(`the helper exited with status ${code}`));
    });
    return c;
  };
  return {
    read() {
      if (waiting) return Promise.reject(new Error("a read is already pending"));
      const c = child ?? start();
      return new Promise((ok, fail) => {
        waiting = { ok, fail };
        c.stdin!.write("read\n");
      });
    },
    close() {
      const c = child;
      child = undefined;
      c?.kill("SIGTERM");
    },
  };
}

/**
 * Reads the block IO counters on demand. Nothing runs while nobody asks:
 *  - `read()` is one read now (an API request, a `/metrics` scrape or a pressure event is the demand). Reads that overlap share one result.
 *  - `subscribe()` is a live view. While at least one subscriber exists, a one-shot deadline re-armed after each read gives it updates. The last
 *    unsubscribe clears the deadline.
 * When the helper cannot read (no privilege, no BTF, an error) the sampler uses `fallback` (the proc and cgroup collector) in the same way.
 */
export class IotraceSampler {
  private readonly subs = new Set<(s: IotraceSample) => void>();
  private readonly deadline = new Deadline(() => void this.tick());
  private inflight?: Promise<IotraceSample>;
  private helperDown = false;

  constructor(
    private readonly source: IotraceSource | undefined,
    private readonly fallback: () => Promise<{ t: number; rows: IotraceRow[] }>,
    private readonly intervalMs = 1000,
  ) {}

  get subscribers() {
    return this.subs.size;
  }

  read(): Promise<IotraceSample> {
    return (this.inflight ??= this.collect().finally(() => (this.inflight = undefined)));
  }

  subscribe(fn: (s: IotraceSample) => void): () => void {
    this.subs.add(fn);
    if (this.subs.size === 1) void this.tick();
    return () => {
      this.subs.delete(fn);
      if (!this.subs.size) this.deadline.clear();
    };
  }

  close() {
    this.subs.clear();
    this.deadline.clear();
    this.source?.close();
  }

  private async collect(): Promise<IotraceSample> {
    if (this.source && !this.helperDown) {
      try {
        return { ...(await this.source.read()), source: "ebpf" };
      } catch {
        this.helperDown = true;
        this.source.close();
      }
    }
    return { ...(await this.fallback()), source: "proc" };
  }

  private async tick() {
    if (!this.subs.size) return;
    try {
      const s = await this.read();
      for (const fn of [...this.subs]) fn(s);
    } catch {
      /* the fallback failed too: the next tick tries again */
    }
    if (this.subs.size) this.deadline.set(Date.now() + this.intervalMs);
  }
}
