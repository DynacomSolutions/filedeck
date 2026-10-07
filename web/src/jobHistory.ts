/** Pure timing and history logic for the jobs tray (no React, no DOM). */

/** A clean finished job stays in the live list this long, then moves to history only. */
export const LINGER_MS = 8000;
/** Jobs that failed or skipped items need reading, so they linger longer. */
export const LINGER_ATTENTION_MS = 60000;
/** With nothing running, the tray folds itself away after this long. */
export const IDLE_COLLAPSE_MS = 15000;
export const HISTORY_MAX = 100;
export const HISTORY_KEY = "filedeck.job-history";

export type Outcome = "done" | "failed" | "canceled";

export interface HistoryEntry {
  /** stable identity, so the same job is never recorded twice */
  key: string;
  title: string;
  /** node or destination the job concerned, if any */
  where?: string;
  outcome: Outcome;
  /** one line: result path, error or counts */
  detail?: string;
  /** when it finished (ms since epoch) */
  at: number;
}

/** Add newly finished jobs: newest first, no duplicates by key, capped. */
export function addToHistory(history: HistoryEntry[], fresh: HistoryEntry[], max = HISTORY_MAX): HistoryEntry[] {
  const known = new Set(history.map((h) => h.key));
  const add = fresh.filter((f, i) => !known.has(f.key) && fresh.findIndex((g) => g.key === f.key) === i);
  if (!add.length) return history;
  return [...add, ...history].sort((a, b) => b.at - a.at).slice(0, max);
}

export const lingerFor = (needsAttention: boolean) => (needsAttention ? LINGER_ATTENTION_MS : LINGER_MS);

/** Whether a finished job still belongs in the live list. */
export const stillLingering = (finishedAt: number, now: number, needsAttention: boolean): boolean => now - finishedAt < lingerFor(needsAttention);

/** Milliseconds until the next finished job leaves the live list, or null when none will. */
export function nextExpiry(finished: { at: number; attention: boolean }[], now: number): number | null {
  let best: number | null = null;
  for (const f of finished) {
    const left = f.at + lingerFor(f.attention) - now;
    if (left > 0 && (best === null || left < best)) best = left;
  }
  return best;
}

/** Should the whole tray fold away? True once it has been idle (nothing live, nothing lingering) long enough. */
export const shouldAutoCollapse = (idleSince: number | null, now: number, delay = IDLE_COLLAPSE_MS): boolean => idleSince !== null && now - idleSince >= delay;

export function parseHistory(raw: string | null): HistoryEntry[] {
  try {
    const v = JSON.parse(raw ?? "[]") as unknown;
    if (!Array.isArray(v)) return [];
    return v
      .filter((x): x is HistoryEntry => !!x && typeof x === "object" && typeof x.key === "string" && typeof x.title === "string" && typeof x.at === "number" && (x.outcome === "done" || x.outcome === "failed" || x.outcome === "canceled"))
      .map((x) => ({ key: x.key, title: x.title, where: typeof x.where === "string" ? x.where : undefined, outcome: x.outcome, detail: typeof x.detail === "string" ? x.detail : undefined, at: x.at }))
      .slice(0, HISTORY_MAX);
  } catch {
    return [];
  }
}
