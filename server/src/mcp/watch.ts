import type { HubNodeStatus } from "../node-status-types.ts";
import type { HubCaller } from "./hub-call.ts";
import type { McpMetrics } from "./metrics.ts";
import type { McpRelease } from "./events.ts";

/**
 * The shared watch of one source: a node, or the hub's own operation queue. The hub has no push path from an agent for scans and jobs (the agent
 * answers `GET /api/jobs` and `GET /api/node-status`, and its change stream names file changes only), so the hub asks. One loop asks for each
 * source, whatever the number of sessions: it starts when the first client follows the source and stops when the last one leaves. A poll is
 * compared with the one before it, and only a difference becomes an event. Nothing is asked while no client follows.
 */

/** What a client sees of a job. The result of a job is left out: a size scan result is a whole folder tree. */
export interface JobSummary {
  id: string;
  kind: string;
  title: string;
  state: string;
  origin?: string;
  createdAt?: number;
  startedAt?: number;
  finishedAt?: number;
  error?: string;
  progress?: unknown;
  /** the node that runs the job, or `hub` for a hub operation */
  node: string;
}

export const SCAN_KINDS: ReadonlySet<string> = new Set(["size", "du"]);
export const TERMINAL: ReadonlySet<string> = new Set(["done", "failed", "canceled"]);

export function summarise(node: string, j: Record<string, unknown>): JobSummary | undefined {
  if (typeof j.id !== "string" || typeof j.state !== "string") return undefined;
  const num = (v: unknown) => (typeof v === "number" ? v : undefined);
  const out: JobSummary = { id: j.id, kind: typeof j.kind === "string" ? j.kind : "unknown", title: typeof j.title === "string" ? j.title : j.id, state: j.state, node };
  if (typeof j.origin === "string") out.origin = j.origin;
  if (num(j.createdAt) !== undefined) out.createdAt = num(j.createdAt);
  if (num(j.startedAt) !== undefined) out.startedAt = num(j.startedAt);
  if (num(j.finishedAt) !== undefined) out.finishedAt = num(j.finishedAt);
  if (typeof j.error === "string") out.error = j.error;
  if (j.progress !== undefined && j.progress !== null) out.progress = j.progress;
  return out;
}

/** A node's status as the hub reports it, or why the hub cannot read it. */
export type StatusView = HubNodeStatus | { node: string; state: "forbidden"; reason: string };

/**
 * The parts of a node status that mean something changed. The sample time, the journal age and size, the cursors, the lag and the subscriber
 * counts move all the time: an event for each would never stop.
 */
export function statusDigest(s: StatusView): string {
  if (s.state !== "available") return JSON.stringify([s.state, "reason" in s ? s.reason : ""]);
  const { sizeStore, roots, watcher, journal } = s.status;
  return JSON.stringify([
    sizeStore,
    roots.map((r) => [r.path, r.scannedAt, r.fullScan, r.state]),
    [watcher.kind, watcher.running, watcher.ready, watcher.mounts, watcher.covered, watcher.unsupported, watcher.unwatched, watcher.lostEvents, watcher.unwatchedPaths, watcher.coverage],
    [journal.serving, journal.epoch, journal.overflows, journal.dropped],
  ]);
}

export function rootsDigest(s: StatusView): string {
  return s.state === "available" ? JSON.stringify(s.status.roots.map((r) => [r.path, r.scannedAt, r.fullScan, r.state])) : "";
}

export type WatchEvent =
  | { kind: "job.created"; job: JobSummary }
  | { kind: "job.state"; job: JobSummary; previous: string }
  | { kind: "job.removed"; job: JobSummary }
  | { kind: "reachable"; reachable: boolean }
  | { kind: "status"; status: StatusView; rootsChanged: boolean; stateChanged: boolean };

export interface WatchSnapshot {
  /** undefined until the first poll answered */
  jobs?: Map<string, JobSummary>;
  status?: StatusView;
  reachable?: boolean;
  polledAt?: number;
}

export interface SourceWatchOptions {
  /** the node name, or `hub` */
  key: string;
  /** the node whose status is read; none for the hub queue */
  statusNode?: string;
  jobsPath: string;
  call: HubCaller;
  pollMs: number;
  metrics: McpMetrics;
  emit(events: WatchEvent[]): void;
}

export class SourceWatch {
  private snap: WatchSnapshot = {};
  private refs = 0;
  private timer?: NodeJS.Timeout;
  private current?: Promise<void>;
  private firstPoll?: Promise<void>;
  private stopped = false;
  private abort = new AbortController();

  constructor(private readonly o: SourceWatchOptions) {}

  get running(): boolean {
    return this.refs > 0 && !this.stopped;
  }

  get snapshot(): WatchSnapshot {
    return this.snap;
  }

  /** Counts one follower. The first one starts the loop. */
  acquire(): McpRelease {
    if (this.stopped) return () => undefined;
    if (++this.refs === 1) {
      this.abort = new AbortController();
      this.schedule(0);
    }
    let done = false;
    return () => {
      if (done) return;
      done = true;
      if (--this.refs === 0) this.halt();
    };
  }

  /** Resolves once the state is known: the first poll has answered (also with an error). */
  async ready(timeoutMs = 10_000): Promise<void> {
    if (this.snap.polledAt !== undefined) return;
    this.firstPoll ??= this.poll();
    await Promise.race([this.firstPoll, new Promise<void>((r) => setTimeout(r, timeoutMs).unref())]);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.refs = 0;
    this.halt();
    await this.current?.catch(() => undefined);
  }

  private halt(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.abort.abort();
    // a later follower starts a clean loop with a fresh baseline: what happened while nobody followed is not an event
    this.snap = {};
    this.firstPoll = undefined;
  }

  private schedule(ms: number): void {
    if (!this.running) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      void this.poll().finally(() => this.schedule(this.o.pollMs));
    }, ms);
    this.timer.unref();
  }

  /** One poll. A poll that is still running is joined, never doubled. */
  poll(): Promise<void> {
    if (this.current) return this.current;
    const run = this.pollOnce().finally(() => {
      this.current = undefined;
    });
    this.current = run;
    return run;
  }

  private async pollOnce(): Promise<void> {
    const { call, key, statusNode } = this.o;
    const signal = this.abort.signal;
    const [jobsRes, statusRes] = await Promise.all([
      call.json(this.o.jobsPath, signal).catch((e: unknown) => ({ status: 0, body: { error: (e as Error).message } })),
      statusNode ? call.json(`/api/status?node=${encodeURIComponent(statusNode)}`, signal).catch(() => undefined) : Promise.resolve(undefined),
    ]);
    if (signal.aborted) return;
    const events: WatchEvent[] = [];
    const prev = this.snap;
    const next: WatchSnapshot = { polledAt: Date.now() };

    const list = (jobsRes.body as { jobs?: unknown } | undefined)?.jobs;
    const answered = jobsRes.status === 200 && Array.isArray(list);
    this.o.metrics.poll(key, answered ? "ok" : "error");
    next.reachable = answered;
    if (answered) {
      const jobs = new Map<string, JobSummary>();
      for (const j of list as Record<string, unknown>[]) {
        const s = j && typeof j === "object" ? summarise(key, j) : undefined;
        if (s) jobs.set(s.id, s);
      }
      next.jobs = jobs;
      if (prev.jobs) {
        for (const [id, job] of jobs) {
          const before = prev.jobs.get(id);
          if (!before) events.push({ kind: "job.created", job });
          else if (before.state !== job.state) events.push({ kind: "job.state", job, previous: before.state });
        }
        for (const [id, job] of prev.jobs) if (!jobs.has(id)) events.push({ kind: "job.removed", job });
      }
    } else next.jobs = prev.jobs; // a failed poll keeps what was known: no job is "removed" because an agent did not answer
    if (prev.reachable !== undefined && prev.reachable !== answered) events.push({ kind: "reachable", reachable: answered });

    if (statusNode && statusRes) {
      let view: StatusView;
      const nodes = (statusRes.body as { nodes?: HubNodeStatus[] } | undefined)?.nodes;
      if (statusRes.status === 200 && Array.isArray(nodes) && nodes[0]) view = nodes[0];
      else if (statusRes.status === 403) view = { node: statusNode, state: "forbidden", reason: "The account may not read node status." };
      else view = { node: statusNode, state: "unavailable", reason: `The hub answered HTTP ${statusRes.status}.` };
      next.status = view;
      if (prev.status && statusDigest(prev.status) !== statusDigest(view)) {
        events.push({ kind: "status", status: view, rootsChanged: rootsDigest(prev.status) !== rootsDigest(view), stateChanged: prev.status.state !== view.state });
      }
    } else next.status = prev.status;

    this.snap = next;
    if (events.length) this.o.emit(events);
  }
}
