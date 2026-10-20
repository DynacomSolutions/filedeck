/** Polling a job across an agent or hub restart: what a failed poll means and how long to wait before the next try. */
export type PollFail = "unreachable" | "gone" | "other";

export const GIVE_UP_MS = 5 * 60_000;
export const GONE_TEXT = "The job is gone (the agent restarted). Start it again.";
export const UNREACHABLE_TEXT = "agent unreachable";

/** A network error (fetch TypeError) or a gateway status (499/502/503/504) is a restart in progress; 404 means the job is lost. */
export function classify(e: unknown): PollFail {
  if (e instanceof TypeError) return "unreachable";
  const s = (e as { status?: unknown } | null)?.status;
  if (s === 404) return "gone";
  return s === 499 || s === 502 || s === 503 || s === 504 ? "unreachable" : "other";
}

/** Wait before retry number `fails` (1 = first failure): 400 ms, 1 s, 2 s, then 5 s. */
export const backoff = (fails: number): number => [400, 1000, 2000][fails - 1] ?? 5000;

/** Whether to stop retrying: the first failure of this outage (`since`) is older than five minutes. */
export const gaveUp = (since: number, now: number): boolean => now - since >= GIVE_UP_MS;
