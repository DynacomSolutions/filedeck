import { randomUUID } from "node:crypto";

export type JobState = "queued" | "running" | "done" | "failed" | "canceled";

export interface Progress {
  bytes: number;
  /** 0 until known */
  totalBytes: number;
  entries: number;
  totalEntries: number;
  current: string;
}

export interface JobView {
  id: string;
  kind: string;
  title: string;
  state: JobState;
  progress: Progress;
  error?: string;
  result?: unknown;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  /** queued jobs only: what is ahead of this one */
  queue?: { position: number; ahead: { id: string; title: string; state: JobState }[] };
}

/**
 * Optional lanes: a running job that `isBig` stops counting against `concurrency`, so a small job queued behind
 * long ones still starts. `maxTotal` bounds how many jobs run at once, big ones included.
 */
export interface JobLanes {
  isBig: (j: JobView) => boolean;
  maxTotal: number;
  /** how often running jobs are re-checked for being big */
  checkMs?: number;
}

export interface JobCtl {
  signal: AbortSignal;
  progress: Progress;
}

interface Job extends JobView {
  run: (ctl: JobCtl) => Promise<unknown>;
  abort: AbortController;
  big?: boolean;
}

/** In-memory background job queue: bounded concurrency, progress, cancel. */
export class Jobs {
  private jobs = new Map<string, Job>();
  private running = 0;
  constructor(
    private concurrency = 2,
    private keep = 100,
    private mapErr: (e: unknown) => string = (e) => (e as Error)?.message ?? "failed",
    private lanes?: JobLanes,
  ) {}
  private timer?: ReturnType<typeof setInterval>;

  create(kind: string, title: string, run: (ctl: JobCtl) => Promise<unknown>): JobView {
    const job: Job = {
      id: randomUUID(),
      kind,
      title,
      state: "queued",
      progress: { bytes: 0, totalBytes: 0, entries: 0, totalEntries: 0, current: "" },
      createdAt: Date.now(),
      run,
      abort: new AbortController(),
    };
    this.jobs.set(job.id, job);
    this.prune();
    this.pump();
    return this.view(job);
  }

  private view(j: Job): JobView {
    const { run: _r, abort: _a, big: _b, ...v } = j;
    const out: JobView = { ...v, progress: { ...j.progress } };
    if (j.state === "queued") {
      const all = [...this.jobs.values()].sort((a, b) => a.createdAt - b.createdAt);
      const me = all.indexOf(j);
      const ahead = all.filter((x, i) => x.state === "running" || (x.state === "queued" && i < me));
      out.queue = { position: ahead.length, ahead: ahead.map((x) => ({ id: x.id, title: x.title, state: x.state })) };
    }
    return out;
  }

  list(): JobView[] {
    return [...this.jobs.values()].sort((a, b) => b.createdAt - a.createdAt).map((j) => this.view(j));
  }

  get(id: string): JobView | undefined {
    const j = this.jobs.get(id);
    return j && this.view(j);
  }

  cancel(id: string): JobView | undefined {
    const j = this.jobs.get(id);
    if (!j) return undefined;
    if (j.state === "queued") {
      j.state = "canceled";
      j.finishedAt = Date.now();
    } else if (j.state === "running") {
      j.abort.abort();
    }
    return this.view(j);
  }

  /** Forget a finished job. */
  dismiss(id: string): boolean {
    const j = this.jobs.get(id);
    if (!j || j.state === "queued" || j.state === "running") return false;
    return this.jobs.delete(id);
  }

  get active(): number {
    return [...this.jobs.values()].filter((j) => j.state === "queued" || j.state === "running").length;
  }

  private prune() {
    const finished = [...this.jobs.values()].filter((j) => j.finishedAt).sort((a, b) => a.finishedAt! - b.finishedAt!);
    for (const j of finished.slice(0, Math.max(0, finished.length - this.keep))) this.jobs.delete(j.id);
  }

  private canStart(): boolean {
    if (!this.lanes) return this.running < this.concurrency;
    let big = 0;
    for (const j of this.jobs.values()) if (j.state === "running" && j.big) big++;
    return this.running - big < this.concurrency && this.running < this.lanes.maxTotal;
  }

  /** Mark long-running jobs big (sticky) and start what that frees room for. */
  private recheck() {
    let any = false;
    for (const j of this.jobs.values()) {
      if (j.state !== "running") continue;
      any = true;
      if (!j.big && this.lanes!.isBig(this.view(j))) j.big = true;
    }
    if (!any && this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    this.pump();
  }

  private pump() {
    for (const j of this.jobs.values()) {
      if (!this.canStart()) return;
      if (j.state !== "queued") continue;
      if (this.lanes && !this.timer) {
        this.timer = setInterval(() => this.recheck(), this.lanes.checkMs ?? 1000);
        this.timer.unref();
      }
      this.running++;
      j.state = "running";
      j.startedAt = Date.now();
      void j
        .run({ signal: j.abort.signal, progress: j.progress })
        .then((r) => {
          if (j.abort.signal.aborted) {
            j.state = "canceled";
          } else {
            j.state = "done";
            j.result = r;
          }
        })
        .catch((e) => {
          if (j.abort.signal.aborted) j.state = "canceled";
          else {
            j.state = "failed";
            j.error = this.mapErr(e);
          }
        })
        .finally(() => {
          j.finishedAt = Date.now();
          this.running--;
          this.prune();
          this.pump();
        });
    }
  }
}
