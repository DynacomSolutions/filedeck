import { fmtSize } from "./api";

export type Tone = "neutral" | "accent" | "amber" | "green" | "red" | "muted";
type Prog = { bytes: number; totalBytes: number; entries: number; totalEntries: number; current: string };

const PILLS: Record<string, { label: string; tone: Tone }> = {
  queued: { label: "queued", tone: "neutral" },
  running: { label: "running", tone: "accent" },
  paused: { label: "paused", tone: "amber" },
  waiting: { label: "waiting for you", tone: "amber" },
  done: { label: "done", tone: "green" },
  failed: { label: "failed", tone: "red" },
  canceled: { label: "canceled", tone: "muted" },
};

/** The status pill of a job: text always names the state, the tone only adds to it. `who` is "agent" or "hub" for a lost connection. */
export function statusPill(state: string, o: { stale?: boolean; who?: string; pct?: number | null } = {}): { label: string; tone: Tone } {
  const live = state === "queued" || state === "running" || state === "paused" || state === "waiting";
  if (o.stale && live) return { label: `waiting for the ${o.who ?? "agent"}`, tone: "amber" };
  const p = PILLS[state] ?? { label: state, tone: "neutral" as Tone };
  return state === "running" && o.pct != null ? { ...p, label: `running ${o.pct}%` } : p;
}

/** Seconds left from the rate since `startedAt` against a known total; null when there is no total, no rate or it is too early to say. */
export function etaSec(p: Prog, startedAt: number | undefined, now: number, minMs = 3000): number | null {
  if (!startedAt || now - startedAt < minMs) return null;
  const [done, total] = p.totalEntries > 0 ? [p.entries, p.totalEntries] : p.totalBytes > 0 ? [p.bytes, p.totalBytes] : [0, 0];
  if (done <= 0 || total <= done) return null;
  return ((total - done) * (now - startedAt)) / done / 1000;
}

/** "under a minute left", "about 4 min left", "about 2 h 5 min left" */
export function etaText(sec: number): string {
  if (sec < 60) return "under a minute left";
  const m = Math.round(sec / 60);
  if (m < 60) return `about ${m} min left`;
  return `about ${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ""} left`;
}

const n = (v: number) => v.toLocaleString();

/** Line 1 of a running job: size and entries (an expected total from an earlier scan only feeds the ETA), then the ETA. */
function progressLine(job: { kind: string; progress: Prog; startedAt?: number }, now: number, totals: boolean): string {
  const p = job.progress;
  const parts: string[] = [];
  if (p.bytes > 0 || p.totalBytes > 0) parts.push(fmtSize(p.bytes) + (totals && p.totalBytes > 0 ? ` of ${fmtSize(p.totalBytes)}` : ""));
  if (p.entries > 0 || p.totalEntries > 0) parts.push(`${n(p.entries)}${totals && p.totalEntries > 0 ? ` of ${n(p.totalEntries)}` : ""} entries`);
  const eta = etaSec(p, job.startedAt, now);
  if (eta !== null) parts.push(etaText(eta));
  return parts.join(", ");
}

/** Up to two detail lines of an agent job, empty ones left out. */
export function jobLines(job: { kind: string; state: string; progress: Prog; startedAt?: number; error?: string; result?: { path?: string; skipped?: { symlinks: number; hardlinks: number; special: number } } }, now: number): string[] {
  if (job.state === "failed") return job.error ? [job.error] : [];
  if (job.state === "queued" || job.state === "running") {
    const sized = job.kind === "size" || job.kind === "du";
    return [progressLine(job, now, !sized), job.progress.current].filter(Boolean);
  }
  const s = job.result?.skipped;
  const skipped = s ? s.symlinks + s.hardlinks + s.special : 0;
  return [job.result?.path, skipped > 0 ? `${skipped} link/special entr${skipped === 1 ? "y" : "ies"} skipped for safety` : ""].filter((x): x is string => !!x);
}
