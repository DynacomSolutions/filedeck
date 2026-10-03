import { FsError } from "./fsops.ts";
import { hashFile, type WalkEntry } from "./walk.ts";
import { splitPatterns } from "./glob.ts";
import type { JobCtl } from "./jobs.ts";
import { CompareSession, type DirSource } from "./cmp-engine.ts";
import { localReader } from "./diff-routes.ts";
import { resolveRead } from "./paths.ts";

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
  /** files hashed at once (each pair streams on its own agent) */
  concurrency: number;
  /** folders listed at once (each listing runs on both agents) */
  dirConcurrency: number;
}

export const DEFAULT_OPTIONS: DiffOptions = {
  mode: "quick",
  toleranceMs: 2000,
  ignoreCase: false,
  ignoreHidden: false,
  include: [],
  exclude: [],
  depth: 64,
  concurrency: 4,
  dirConcurrency: 16,
};
export const LIMITS = { depth: 256, concurrency: 16, dirConcurrency: 32, toleranceMs: 24 * 3600_000 };

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
    concurrency: num(o.concurrency, DEFAULT_OPTIONS.concurrency, 1, LIMITS.concurrency, "concurrency"),
    dirConcurrency: num(o.dirConcurrency, DEFAULT_OPTIONS.dirConcurrency, 1, LIMITS.dirConcurrency, "dirConcurrency"),
  };
}

export const DIFF_STATUSES = ["identical", "different", "left-only", "right-only", "error"] as const;
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

/** Kept for callers of the old name: a side of a compare is anything that can list one folder and hash one file. */
export type DiffSource = DirSource;

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

/** Compare two trees to completion and return every row (tests, small in-process use; the hub serves rows per folder instead). */
export async function compareTrees(left: DirSource, right: DirSource, o: DiffOptions, ctl: JobCtl): Promise<DiffResult> {
  const s = new CompareSession(left, right, o);
  try {
    await s.run(ctl.signal, ctl.progress);
    const { files, dirs } = s.counts();
    return { rows: s.rows(), files, dirs, hashedFiles: s.stats.hashed, hashedBytes: s.stats.hashedBytes, warnings: s.warnings };
  } finally {
    s.close();
  }
}

/** DirSource backed by a directory on this machine (tests, and any in-process use). */
export function localSource(root: string, virtualPath: string): DirSource {
  const at = (rel: string) => (virtualPath === "/" ? "" : virtualPath) + "/" + rel;
  const reader = localReader();
  return {
    async list(rel) {
      const r = resolveRead(root, rel ? at(rel) : virtualPath);
      await reader.statDir(r.real);
      return { entries: (await reader.readDir(r.real)).map(({ i: _i, ...e }) => e), cached: false };
    },
    async hash(rel, signal) {
      return (await hashFile(root, at(rel), signal)).sha256;
    },
  };
}
