/** Empty for an unknown time (null, undefined, 0 or not a finite number), never 1970-01-01. */
export const fmtDate = (ms: number | null | undefined) =>
  typeof ms !== "number" || !Number.isFinite(ms) || ms <= 0 ? "" : new Date(ms).toISOString().slice(0, 16).replace("T", " ");
