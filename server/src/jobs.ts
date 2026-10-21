import { randomUUID } from "node:crypto";
import type { JobRow, JobStore } from "./job-store.ts";

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

/** What an adopted job needs to run again; built from the stored allowlisted params. */
export type Rebuild = (params: unknown) => Promise<{ run: (ctl: JobCtl) => Promise<unknown>; onDrop?: () => void; gate?: (signal: AbortSignal) => Promise<void> }>;

/** Shared store: `scope` names this process's jobs, `rebuild` restarts adopted kinds (others fail), the lease is how long a silent owner keeps its jobs. */
export interface JobsStore {
  store: JobStore;
  scope: string;
  rebuild?: Record<string, Rebuild>;
  leaseMs?: number;
  tickMs?: number;
}

interface Job extends JobView {
  /** JSON of the allowlisted params, null = not rebuildable */
  params?: string | null;
  /** the last write to the store was skipped */
  dirty?: boolean;
  run: (ctl: JobCtl) => Promise<unknown>;
  onDrop?: () => void;
  /** set while the job waits for its gate: it is queued but takes no slot */
  gated?: boolean;
  abort: AbortController;
  big?: boolean;
}

const live = (s: string) => s === "queued" || s === "running";
const rowView = (r: JobRow) => JSON.parse(r.view) as JobView;

/** Background job queue: bounded concurrency, progress, cancel. In memory, or shared through a JobStore: bounded concurrency, progress, cancel. */
export class Jobs {
  private jobs = new Map<string, Job>();
  private running = 0;
  constructor(
    private concurrency = 2,
    private keep = 100,
    private mapErr: (e: unknown) => string = (e) => (e as Error)?.message ?? "failed",
    private lanes?: JobLanes,
    private shared?: JobsStore,
  ) {
    // one unref'd timer: heartbeat, foreign cancels, adoption of jobs whose owner went silent
    if (shared) setInterval(() => this.tick(), shared.tickMs ?? 1000).unref();
  }
  private timer?: ReturnType<typeof setInterval>;
  private lastSkipLog = 0;
  private readonly me = randomUUID();
  private stopping = false;
  private adopting = new Set<string>();

  /** How an adopted job of this kind is run again (no-op without a shared store). */
  register(kind: string, rebuild: Rebuild) {
    if (this.shared) (this.shared.rebuild ??= {})[kind] = rebuild;
  }

  /**
   * `onDrop` runs when the job is canceled while still queued (its `run` then never starts).
   * `gate` runs at once with the job's abort signal; the job takes no slot until it resolves (a rejection fails the job).
   */
  create(kind: string, title: string, run: (ctl: JobCtl) => Promise<unknown>, onDrop?: () => void, gate?: (signal: AbortSignal) => Promise<void>, meta?: { params?: unknown; id?: string; createdAt?: number }): JobView {
    const job: Job = {
      id: meta?.id ?? randomUUID(),
      params: meta?.params === undefined ? null : JSON.stringify(meta.params),
      kind,
      title,
      state: "queued",
      progress: { bytes: 0, totalBytes: 0, entries: 0, totalEntries: 0, current: "" },
      createdAt: meta?.createdAt ?? Date.now(),
      run,
      onDrop,
      abort: new AbortController(),
    };
    this.jobs.set(job.id, job);
    this.save(job);
    if (gate) {
      job.gated = true;
      gate(job.abort.signal)
        .then(
          () => void (job.gated = false),
          (e) => {
            job.gated = false;
            if (job.state !== "queued") return;
            job.state = job.abort.signal.aborted ? "canceled" : "failed";
            if (job.state === "failed") job.error = this.mapErr(e);
            job.finishedAt = Date.now();
            this.save(job);
          },
        )
        .finally(() => this.pump());
    }
    this.prune();
    this.pump();
    return this.view(job);
  }

  private view(j: Job): JobView {
    const { run: _r, onDrop: _d, gated: _g, abort: _a, big: _b, params: _p, dirty: _y, ...v } = j;
    const out: JobView = { ...v, progress: { ...j.progress } };
    if (j.state === "queued") {
      const all = [...this.jobs.values()].sort((a, b) => a.createdAt - b.createdAt);
      const me = all.indexOf(j);
      const ahead = all.filter((x, i) => x.state === "running" || (x.state === "queued" && i < me));
      out.queue = { position: ahead.length, ahead: ahead.map((x) => ({ id: x.id, title: x.title, state: x.state })) };
    }
    return out;
  }

  /** Other processes' jobs are read from the store (during a rollout the old pod still runs what the new one is polled for). */
  list(): JobView[] {
    const own = [...this.jobs.values()].map((j) => this.view(j));
    const other = (this.shared?.store.list(this.shared.scope) ?? []).filter((r) => !this.jobs.has(r.id)).map(rowView);
    return [...own, ...other].sort((a, b) => b.createdAt - a.createdAt);
  }

  get(id: string): JobView | undefined {
    const j = this.jobs.get(id);
    if (j) return this.view(j);
    const r = this.shared?.store.get(id, this.shared.scope);
    return r && rowView(r);
  }

  cancel(id: string): JobView | undefined {
    const j = this.jobs.get(id);
    if (!j) {
      const r = this.shared?.store.get(id, this.shared.scope);
      if (r && live(r.state)) this.shared!.store.setCancel(id, this.shared!.scope); // its owner aborts it at the next tick
      return r && rowView(r);
    }
    if (j.state === "queued") {
      j.state = "canceled";
      j.finishedAt = Date.now();
      j.abort.abort();
      j.onDrop?.();
      this.save(j);
    } else if (j.state === "running") {
      j.abort.abort();
    }
    return this.view(j);
  }

  /** Forget a finished job. */
  dismiss(id: string): boolean {
    const j = this.jobs.get(id);
    if (!j) {
      const r = this.shared?.store.get(id, this.shared.scope);
      if (!r || live(r.state)) return false;
      this.shared!.store.delete(id, this.shared!.scope);
      return true;
    }
    if (j.state === "queued" || j.state === "running") return false;
    this.shared?.store.delete(id, this.shared.scope);
    return this.jobs.delete(id);
  }

  get active(): number {
    return [...this.jobs.values()].filter((j) => j.state === "queued" || j.state === "running").length;
  }

  private prune() {
    const finished = [...this.jobs.values()].filter((j) => j.finishedAt).sort((a, b) => a.finishedAt! - b.finishedAt!);
    for (const j of finished.slice(0, Math.max(0, finished.length - this.keep))) this.jobs.delete(j.id);
    this.shared?.store.prune(this.shared.scope, this.keep, Date.now());
  }

  private save(j: Job) {
    if (!this.shared || this.stopping) return;
    // a skipped write (busy database) is retried by tick
    j.dirty = !this.shared.store.put({
      id: j.id, scope: this.shared.scope, kind: j.kind, title: j.title, params: j.params ?? null, view: JSON.stringify({ ...this.view(j), queue: undefined }),
      state: j.state, owner: this.me, beat: Date.now(), created_at: j.createdAt, finished_at: j.finishedAt ?? null,
    });
  }

  /** One heartbeat round. A busy database only skips it; nothing here waits. */
  tick() {
    const sh = this.shared;
    if (!sh || this.stopping) return;
    try {
      const now = Date.now();
      const all = [...this.jobs.values()];
      for (const j of all) if (j.dirty && !live(j.state)) this.save(j);
      const mine = all.filter((j) => live(j.state));
      const lost = sh.store.beatAll(this.me, mine.map((j) => ({ id: j.id, view: JSON.stringify({ ...this.view(j), queue: undefined }) })), now);
      if (!lost) {
        // busy: skip the whole round (noted at most once a minute)
        if (now - this.lastSkipLog > 60_000) {
          this.lastSkipLog = now;
          console.error(JSON.stringify({ slow: "job-beat-skipped", jobs: mine.map((j) => j.id) }));
        }
        return;
      }
      for (const id of lost) {
        const j = this.jobs.get(id)!;
        const r = sh.store.get(id, sh.scope);
        if (!r) this.save(j); // the first write was skipped
        else if (r.owner !== this.me) {
          // adopted elsewhere: stop here and persist nothing
          this.jobs.delete(id);
          j.abort.abort();
        }
      }
      for (const id of sh.store.canceled(this.me)) this.cancel(id);
      for (const r of sh.store.orphans(sh.scope, this.me, now - (sh.leaseMs ?? 30_000))) {
        if (this.jobs.has(r.id) || this.adopting.has(r.id)) continue;
        if (r.params && sh.rebuild?.[r.kind]) {
          if (sh.store.claim(r.id, r.owner, r.beat, this.me, now)) void this.adopt(r);
        } else sh.store.failClaim(r, this.me, JSON.stringify(this.interrupted(r, now)), now);
      }
    } catch {
      /* try again next tick */
    }
  }

  private interrupted(r: JobRow, now: number) {
    return { ...rowView(r), state: "failed", error: "Interrupted by an agent restart. Start it again.", finishedAt: now };
  }

  /** Rebuild a claimed job; if that fails it is marked failed (a busy write is found again by the next tick as our own orphan). */
  private async adopt(r: JobRow) {
    const sh = this.shared!;
    this.adopting.add(r.id);
    try {
      const params = JSON.parse(r.params!);
      const b = await sh.rebuild![r.kind]!(params);
      this.create(r.kind, r.title, b.run, b.onDrop, b.gate, { params, id: r.id, createdAt: r.created_at });
    } catch {
      const now = Date.now();
      sh.store.put({ ...r, view: JSON.stringify(this.interrupted(r, now)), state: "failed", owner: this.me, beat: now, finished_at: now });
    } finally {
      this.adopting.delete(r.id);
    }
  }

  /**
   * Shutdown: abort what runs (their catch blocks clean staging), wait up to `ms`, then hand the live rows over at once (beat 0).
   * Nothing is persisted as canceled: the next process rebuilds or fails them.
   */
  async interrupt(ms = 3000) {
    this.stopping = true;
    for (const j of this.jobs.values()) if (live(j.state)) j.abort.abort();
    for (const end = Date.now() + ms; this.running > 0 && Date.now() < end; ) await new Promise((r) => setTimeout(r, 20));
    this.shared?.store.release(this.me);
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
    if (this.stopping) return;
    for (const j of this.jobs.values()) {
      if (!this.canStart()) return;
      if (j.state !== "queued" || j.gated) continue;
      if (this.lanes && !this.timer) {
        this.timer = setInterval(() => this.recheck(), this.lanes.checkMs ?? 1000);
        this.timer.unref();
      }
      this.running++;
      j.state = "running";
      j.startedAt = Date.now();
      this.save(j);
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
          this.save(j);
          this.running--;
          this.prune();
          this.pump();
        });
    }
  }
}
