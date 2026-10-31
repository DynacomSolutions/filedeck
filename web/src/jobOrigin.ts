import type { JobOrigin } from "./api";

/** Jobs started by a person in the web UI show in the main list; everything else (CLI, watcher, adopted background work) is background. */
export const isBackground = (j: { origin?: JobOrigin }): boolean => j.origin !== undefined && j.origin !== "ui";

/** Split one node's jobs: foreground first, background second. A job without an origin (older agent) counts as foreground. */
export function splitByOrigin<T extends { origin?: JobOrigin }>(jobs: T[]): { fore: T[]; back: T[] } {
  const fore: T[] = [];
  const back: T[] = [];
  for (const j of jobs) (isBackground(j) ? back : fore).push(j);
  return { fore, back };
}
