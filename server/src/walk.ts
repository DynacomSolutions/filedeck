import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { FsError } from "./fsops.ts";
import { TRASH_DIR, resolveRead } from "./paths.ts";
import { compileGlobs } from "./glob.ts";

export interface WalkEntry {
  /** path relative to the walked folder, "/" separated */
  p: string;
  t: "file" | "dir" | "symlink" | "other";
  s: number;
  m: number;
  /** symlink target as stored */
  l?: string;
}

export interface WalkOpts {
  hidden: boolean;
  /** how many directory levels below the start folder are listed (1 = children only) */
  depth: number;
  /** stop after this many entries */
  max: number;
  include: string[];
  exclude: string[];
  ignoreCase: boolean;
}

export interface WalkSummary {
  truncated: boolean;
  depthLimited: boolean;
  /** directories or entries that could not be read */
  errors: number;
}

export const WALK_HARD_MAX_DEPTH = 64;

/**
 * Bounded, cancellable, read-only tree walk. Symlinks are reported but never
 * followed, so the walk cannot leave the tree or loop. Directories are read one
 * at a time (entries stat'ed in small batches) to stay gentle on the disk.
 */
export async function* walkTree(
  root: string,
  virtualPath: string,
  o: WalkOpts,
  signal?: AbortSignal,
): AsyncGenerator<WalkEntry[], WalkSummary> {
  const start = resolveRead(root, virtualPath);
  const st = await fs.stat(start.real);
  if (!st.isDirectory()) throw new FsError(400, "not a directory");
  const exclude = compileGlobs(o.exclude, o.ignoreCase);
  const include = o.include.length ? compileGlobs(o.include, o.ignoreCase) : null;
  const depthMax = Math.max(1, Math.min(o.depth, WALK_HARD_MAX_DEPTH));
  const summary: WalkSummary = { truncated: false, depthLimited: false, errors: 0 };
  let total = 0;
  const stack: { real: string; rel: string; depth: number }[] = [{ real: start.real, rel: "", depth: 1 }];
  while (stack.length) {
    if (signal?.aborted) throw new FsError(400, "canceled");
    const dir = stack.pop() as (typeof stack)[number];
    let names: string[];
    try {
      names = await fs.readdir(dir.real);
    } catch {
      summary.errors++;
      continue;
    }
    names.sort();
    const wanted = names.filter((n) => n !== TRASH_DIR && (o.hidden || !n.startsWith(".")));
    const out: WalkEntry[] = [];
    const subdirs: typeof stack = [];
    for (let i = 0; i < wanted.length; i += 32) {
      if (signal?.aborted) throw new FsError(400, "canceled");
      const got = await Promise.all(
        wanted.slice(i, i + 32).map(async (n) => {
          const real = path.join(dir.real, n);
          try {
            const s = await fs.lstat(real);
            const e: WalkEntry = {
              p: dir.rel ? `${dir.rel}/${n}` : n,
              t: s.isSymbolicLink() ? "symlink" : s.isDirectory() ? "dir" : s.isFile() ? "file" : "other",
              s: s.isDirectory() ? 0 : s.size,
              m: Math.floor(s.mtimeMs),
            };
            if (e.t === "symlink") e.l = await fs.readlink(real).catch(() => "");
            return { e, real };
          } catch {
            summary.errors++;
            return null;
          }
        }),
      );
      for (const g of got) {
        if (!g) continue;
        const isDir = g.e.t === "dir";
        if (exclude.test(g.e.p, isDir)) continue;
        if (!isDir && include && !include.test(g.e.p, false)) continue;
        if (total >= o.max) {
          summary.truncated = true;
          break;
        }
        total++;
        out.push(g.e);
        if (isDir) {
          if (dir.depth < depthMax) subdirs.push({ real: g.real, rel: g.e.p, depth: dir.depth + 1 });
          else summary.depthLimited = true;
        }
      }
      if (summary.truncated) break;
    }
    for (let i = 0; i < out.length; i += 500) yield out.slice(i, i + 500);
    if (summary.truncated) break;
    for (const d of subdirs.reverse()) stack.push(d);
  }
  return summary;
}

export class Semaphore {
  private waiting: (() => void)[] = [];
  private used = 0;
  constructor(private n: number) {}
  async run<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    while (this.used >= this.n) {
      await new Promise<void>((res) => this.waiting.push(res));
      if (signal?.aborted) throw new FsError(400, "canceled");
    }
    this.used++;
    try {
      return await fn();
    } finally {
      this.used--;
      this.waiting.shift()?.();
    }
  }
}

/** Streamed sha256 of a regular file (symlinks followed, confined to the root). */
export async function hashFile(root: string, p: string, signal?: AbortSignal) {
  const r = resolveRead(root, p);
  const st = await fs.stat(r.real);
  if (st.isDirectory()) throw new FsError(400, "is a directory");
  if (!st.isFile()) throw new FsError(400, "not a regular file");
  const h = createHash("sha256");
  const stream = createReadStream(r.real, { highWaterMark: 1 << 20, signal });
  let bytes = 0;
  for await (const chunk of stream) {
    h.update(chunk as Buffer);
    bytes += (chunk as Buffer).length;
  }
  return { path: r.virtual, size: st.size, mtime: Math.floor(st.mtimeMs), sha256: h.digest("hex"), bytes };
}
