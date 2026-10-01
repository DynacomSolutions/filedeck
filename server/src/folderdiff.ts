import { FsError } from "./fsops.ts";
import { hashFile, walkTree, type WalkEntry, type WalkOpts, type WalkSummary } from "./walk.ts";
import { splitPatterns } from "./glob.ts";
import type { JobCtl } from "./jobs.ts";

export const MODES = ["name", "size", "mtime", "content", "quick"] as const;
export type Mode = (typeof MODES)[number];

export interface DiffOptions {
  mode: Mode;
  /** mtimes closer than this count as equal (FAT rounds to 2 s, copies lose sub-second parts) */
  toleranceMs: number;
  ignoreCase: boolean;
  ignoreHidden: boolean;
  include: string[];
  exclude: string[];
  /** directory levels below each root (1 = children only) */
  depth: number;
  /** per-side entry ceiling */
  maxEntries: number;
  /** files hashed at once (each pair streams on its own agent) */
  concurrency: number;
}

export const DEFAULT_OPTIONS: DiffOptions = {
  mode: "quick",
  toleranceMs: 2000,
  ignoreCase: false,
  ignoreHidden: false,
  include: [],
  exclude: [],
  depth: 32,
  maxEntries: 250_000,
  concurrency: 4,
};
export const LIMITS = { depth: 64, maxEntries: 500_000, concurrency: 16, toleranceMs: 24 * 3600_000 };

const num = (v: unknown, d: number, lo: number, hi: number, what: string) => {
  if (v === undefined || v === null || v === "") return d;
  if (typeof v !== "number" || !Number.isFinite(v)) throw new FsError(400, `${what} must be a number`);
  return Math.max(lo, Math.min(hi, Math.floor(v)));
};
const pats = (v: unknown, what: string): string[] => {
  if (v === undefined || v === null) return [];
  if (typeof v === "string") return splitPatterns(v).slice(0, 100);
  if (Array.isArray(v) && v.every((x) => typeof x === "string")) return (v as string[]).map((x) => x.trim()).filter(Boolean).slice(0, 100);
  throw new FsError(400, `${what} must be a string or array of strings`);
};

/** Validate untrusted option JSON and clamp every limit. */
export function normalizeOptions(raw: unknown): DiffOptions {
  const o = (raw ?? {}) as Record<string, unknown>;
  if (typeof o !== "object" || Array.isArray(o)) throw new FsError(400, "options must be an object");
  const mode = o.mode === undefined ? DEFAULT_OPTIONS.mode : o.mode;
  if (!MODES.includes(mode as Mode)) throw new FsError(400, `mode must be one of ${MODES.join(", ")}`);
  return {
    mode: mode as Mode,
    toleranceMs: num(o.toleranceMs, DEFAULT_OPTIONS.toleranceMs, 0, LIMITS.toleranceMs, "toleranceMs"),
    ignoreCase: o.ignoreCase === true,
    ignoreHidden: o.ignoreHidden === true,
    include: pats(o.include, "include"),
    exclude: pats(o.exclude, "exclude"),
    depth: num(o.depth, DEFAULT_OPTIONS.depth, 1, LIMITS.depth, "depth"),
    maxEntries: num(o.maxEntries, DEFAULT_OPTIONS.maxEntries, 1, LIMITS.maxEntries, "maxEntries"),
    concurrency: num(o.concurrency, DEFAULT_OPTIONS.concurrency, 1, LIMITS.concurrency, "concurrency"),
  };
}

export type Status = "identical" | "different" | "left-only" | "right-only" | "error";
export interface Side {
  t: WalkEntry["t"];
  s: number;
  m: number;
  l?: string;
}
export interface Row {
  /** relative path, left side's spelling when both exist */
  p: string;
  /** right side's spelling, only when it differs from `p` (ignore-case matches) */
  rp?: string;
  status: Status;
  l?: Side;
  r?: Side;
  /** for differing files whose mtimes differ by more than the tolerance */
  newer?: "left" | "right";
  /** short reason for `different` / `error` */
  why?: string;
}
export interface Counts {
  identical: number;
  different: number;
  leftOnly: number;
  rightOnly: number;
  error: number;
}
export interface DiffResult {
  rows: Row[];
  files: Counts;
  dirs: Counts;
  hashedFiles: number;
  hashedBytes: number;
  warnings: string[];
}

export interface DiffSource {
  walk(o: WalkOpts, signal: AbortSignal, onEntries: (n: number) => void): Promise<WalkSummary & { entries: WalkEntry[] }>;
  hash(rel: string, signal: AbortSignal): Promise<string>;
}

const side = (e: WalkEntry): Side => ({ t: e.t, s: e.s, m: e.m, ...(e.l !== undefined ? { l: e.l } : {}) });

type Verdict = { status: Status; why?: string; newer?: "left" | "right" } | { status: "pending-dir" } | { status: "pending-hash" };

/** Pure per-pair decision; `pending-hash` means the caller must compare content. */
export function classify(l: Side, r: Side, o: Pick<DiffOptions, "mode" | "toleranceMs">): Verdict {
  if (l.t !== r.t) return { status: "different", why: "type" };
  if (l.t === "dir") return { status: "pending-dir" };
  const dm = l.m - r.m;
  const newer: "left" | "right" | undefined = Math.abs(dm) > o.toleranceMs ? (dm > 0 ? "left" : "right") : undefined;
  const diff = (why: string) => ({ status: "different" as const, why, ...(newer ? { newer } : {}) });
  if (o.mode === "name") return { status: "identical" };
  if (l.t === "symlink") return (l.l ?? "") === (r.l ?? "") ? { status: "identical" } : diff("link target");
  if (l.t === "other") return l.s === r.s ? { status: "identical" } : diff("size");
  switch (o.mode) {
    case "size":
      return l.s === r.s ? { status: "identical" } : diff("size");
    case "mtime":
      return newer ? diff("modified time") : { status: "identical" };
    case "content":
      return l.s !== r.s ? diff("size") : { status: "pending-hash" };
    case "quick":
      if (l.s !== r.s) return diff("size");
      return newer ? { status: "pending-hash" } : { status: "identical" };
  }
}

const empty = (): Counts => ({ identical: 0, different: 0, leftOnly: 0, rightOnly: 0, error: 0 });
const bump = (c: Counts, s: Status) => {
  if (s === "identical") c.identical++;
  else if (s === "different") c.different++;
  else if (s === "left-only") c.leftOnly++;
  else if (s === "right-only") c.rightOnly++;
  else c.error++;
};

function cmpPath(a: string, b: string): number {
  const x = a.split("/");
  const y = b.split("/");
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const p = x[i] as string;
    const q = y[i] as string;
    if (p !== q) return p < q ? -1 : 1;
  }
  return x.length - y.length;
}

/** Run `fn` over `items` with at most `n` in flight; stops scheduling on abort. */
async function pool<T>(items: T[], n: number, signal: AbortSignal, fn: (x: T) => Promise<void>) {
  let i = 0;
  const worker = async () => {
    while (i < items.length && !signal.aborted) await fn(items[i++] as T);
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
}

export async function compareTrees(left: DiffSource, right: DiffSource, o: DiffOptions, ctl: JobCtl): Promise<DiffResult> {
  const { signal, progress } = ctl;
  const stop = () => {
    if (signal.aborted) throw new FsError(400, "canceled");
  };
  const wo: WalkOpts = { hidden: !o.ignoreHidden, depth: o.depth, max: o.maxEntries, include: o.include, exclude: o.exclude, ignoreCase: o.ignoreCase };
  const warnings: string[] = [];
  const counts: [number, number] = [0, 0];
  const scan = async (src: DiffSource, i: 0 | 1, label: string) => {
    progress.current = `Scanning ${label}`;
    const w = await src.walk(wo, signal, (n) => {
      counts[i] = n;
      progress.entries = counts[0] + counts[1];
    });
    counts[i] = w.entries.length;
    progress.entries = counts[0] + counts[1];
    if (w.truncated) warnings.push(`${label} folder has more than ${o.maxEntries} entries; the listing was cut off`);
    if (w.depthLimited) warnings.push(`${label} folder is deeper than ${o.depth} levels; deeper entries were not compared`);
    if (w.errors) warnings.push(`${w.errors} entr${w.errors === 1 ? "y" : "ies"} in the ${label} folder could not be read`);
    return w.entries;
  };
  const [le, re] = await Promise.all([scan(left, 0, "left"), scan(right, 1, "right")]);
  stop();

  const key = (p: string) => (o.ignoreCase ? p.toLowerCase() : p);
  const rmap = new Map<string, WalkEntry>();
  for (const e of re) if (!rmap.has(key(e.p))) rmap.set(key(e.p), e);
  const rows: Row[] = [];
  const pendingDir = new Set<Row>();
  const hashes: { row: Row; l: WalkEntry; r: WalkEntry }[] = [];
  const seen = new Set<string>();
  for (const l of le) {
    const k = key(l.p);
    const r = rmap.get(k);
    if (!r || seen.has(k)) {
      rows.push({ p: l.p, status: "left-only", l: side(l) });
      continue;
    }
    seen.add(k);
    const row: Row = { p: l.p, status: "identical", l: side(l), r: side(r) };
    if (r.p !== l.p) row.rp = r.p;
    const v = classify(row.l as Side, row.r as Side, o);
    if (v.status === "pending-dir") pendingDir.add(row);
    else if (v.status === "pending-hash") hashes.push({ row, l, r });
    else {
      row.status = v.status;
      if ("why" in v && v.why) row.why = v.why;
      if ("newer" in v && v.newer) row.newer = v.newer;
    }
    rows.push(row);
  }
  for (const r of re) {
    const k = key(r.p);
    if (rmap.get(k) !== r || !seen.has(k)) rows.push({ p: r.p, status: "right-only", r: side(r) });
  }

  // Content comparison: hashes are computed on the agents that hold the files.
  let hashedBytes = 0;
  if (hashes.length) {
    progress.totalEntries = hashes.length;
    progress.totalBytes = hashes.reduce((n, h) => n + h.l.s * 2, 0);
    progress.entries = 0;
    progress.bytes = 0;
    await pool(hashes, o.concurrency, signal, async (h) => {
      progress.current = `Hashing ${h.row.p}`;
      try {
        const [a, b] = await Promise.all([left.hash(h.l.p, signal), right.hash(h.r.p, signal)]);
        if (a === b) h.row.status = "identical";
        else {
          h.row.status = "different";
          h.row.why = "content";
          const dm = h.l.m - h.r.m;
          if (Math.abs(dm) > o.toleranceMs) h.row.newer = dm > 0 ? "left" : "right";
        }
        hashedBytes += h.l.s * 2;
      } catch (e) {
        if (signal.aborted) return;
        h.row.status = "error";
        h.row.why = (e as Error).message || "could not hash";
      }
      progress.entries++;
      progress.bytes += h.l.s * 2;
    });
    stop();
  }

  rows.sort((a, b) => cmpPath(a.p, b.p));

  // Directories present on both sides are identical only if everything below them is.
  const state = new Map<string, boolean>(); // dir key -> all descendants identical
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i] as Row;
    const slash = row.p.lastIndexOf("/");
    if (pendingDir.has(row)) {
      const ok = state.get(key(row.p)) !== false;
      row.status = ok ? "identical" : "different";
      if (!ok) row.why = "contents differ";
    }
    if (slash > 0) {
      const pk = key(row.p.slice(0, slash));
      if (row.status !== "identical") state.set(pk, false);
      else if (!state.has(pk)) state.set(pk, true);
    }
  }

  const files = empty();
  const dirs = empty();
  for (const row of rows) bump((row.l?.t ?? row.r?.t) === "dir" ? dirs : files, row.status);
  return { rows, files, dirs, hashedFiles: hashes.length, hashedBytes, warnings };
}

/** DiffSource backed by a directory on this machine (tests, and any in-process use). */
export function localSource(root: string, virtualPath: string): DiffSource {
  const at = (rel: string) => (virtualPath === "/" ? "" : virtualPath) + "/" + rel;
  return {
    async walk(o, signal, onEntries) {
      const entries: WalkEntry[] = [];
      const g = walkTree(root, virtualPath, o, signal);
      for (;;) {
        const r = await g.next();
        if (r.done) return { ...r.value, entries };
        entries.push(...r.value);
        onEntries(entries.length);
      }
    },
    async hash(rel, signal) {
      return (await hashFile(root, at(rel), signal)).sha256;
    },
  };
}
