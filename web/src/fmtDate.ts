const two = (n: number) => String(n).padStart(2, "0");

/** Local time as `YYYY-MM-DD HH:mm`, the same clock the job history shows. Empty for an unknown time (null, undefined, 0 or not a finite number), never 1970-01-01. */
export const fmtDate = (ms: number | null | undefined) => {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms <= 0) return "";
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return "";
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`;
};
