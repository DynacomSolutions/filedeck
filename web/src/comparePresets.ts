// Saved compare presets live in localStorage, so whatever is there may be hand-edited or from another version.
import { DEFAULT_UI, FOLDER_MODES, type DiffMode, type UiOpts } from "./urlState";

const num = (v: unknown, d: number, lo: number, hi: number) => (typeof v === "number" && Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : d);
const bool = (v: unknown, d: boolean) => (typeof v === "boolean" ? v : d);
const text = (v: unknown, d: string) => (typeof v === "string" ? v : d);

/** Compare options with every field checked and clamped; anything missing or of the wrong type falls back to the default. */
export function sanitizeOpts(v: unknown): UiOpts {
  const o = (v && typeof v === "object" && !Array.isArray(v) ? v : {}) as Record<string, unknown>;
  return {
    mode: FOLDER_MODES.includes(o.mode as DiffMode) ? (o.mode as DiffMode) : DEFAULT_UI.mode,
    toleranceSec: num(o.toleranceSec, DEFAULT_UI.toleranceSec, 0, 86400),
    ignoreCase: bool(o.ignoreCase, DEFAULT_UI.ignoreCase),
    ignoreHidden: bool(o.ignoreHidden, DEFAULT_UI.ignoreHidden),
    include: text(o.include, DEFAULT_UI.include),
    exclude: text(o.exclude, DEFAULT_UI.exclude),
    depth: num(o.depth, DEFAULT_UI.depth, 1, 256),
  };
}

/** The stored preset map, keeping only entries whose value is an object, each one sanitised. */
export function parsePresets(raw: string | null): Record<string, UiOpts> {
  let v: unknown;
  try {
    v = JSON.parse(raw ?? "{}");
  } catch {
    return {};
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) return {};
  const out: Record<string, UiOpts> = {};
  for (const [k, x] of Object.entries(v)) if (k !== "__proto__" && x && typeof x === "object" && !Array.isArray(x)) out[k] = sanitizeOpts(x);
  return out;
}
