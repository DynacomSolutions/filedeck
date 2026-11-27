import type { Psi, PsiWindows } from "./types.ts";
import { ZERO_PSI } from "./types.ts";

function windows(line: string): PsiWindows {
  const get = (k: string) => Number(new RegExp(`\\b${k}=([0-9.]+)`).exec(line)?.[1] ?? 0) || 0;
  return { avg10: get("avg10"), avg60: get("avg60"), avg300: get("avg300") };
}

/**
 * Parses /proc/pressure/io or a cgroup's io.pressure:
 *   some avg10=5.30 avg60=11.70 avg300=22.90 total=175208970807
 *   full avg10=0.90 avg60=4.50 avg300=7.50 total=82954882129
 * Returns zeros for text that has neither line (pressure accounting is off).
 */
export function parsePsi(text: string): Psi {
  const some = text.split("\n").find((l) => l.startsWith("some "));
  const full = text.split("\n").find((l) => l.startsWith("full "));
  if (!some && !full) return structuredClone(ZERO_PSI);
  return { some: some ? windows(some) : { ...ZERO_PSI.some }, full: full ? windows(full) : { ...ZERO_PSI.full } };
}
