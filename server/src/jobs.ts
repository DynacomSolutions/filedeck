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
}

export interface JobCtl {
  signal: AbortSignal;
  progress: Progress;
}

interface Job extends JobView {
  run: (ctl: JobCtl) => Promise<unknown>;
  abort: AbortController;
}

/** In-memory background job queue: bounded concurrency, progress, cancel. */
export class Jobs {
  private jobs = new Map<string, Job>();
  private running = 0;
  constructor(
    private concurrency = 2,
    private keep = 100,
    private mapErr: (e: unknown) => string = (e) => (e as Error)?.message ?? "failed",
  ) {}

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
    const { run: _r, abort: _a, ...v } = j;
    return { ...v, progress: { ...j.progress } };
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

  private pump() {
    for (const j of this.jobs.values()) {
      if (this.running >= this.concurrency) return;
      if (j.state !== "queued") continue;
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
