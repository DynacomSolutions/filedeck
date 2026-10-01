import type { Readable } from "node:stream";
import type { Hono } from "hono";
import { FsError } from "./fsops.ts";
import { compileGlobs } from "./glob.ts";
import { resolveRead } from "./paths.ts";
import { walkTree, type WalkEntry, type WalkSummary } from "./walk.ts";
import { createReadStream } from "node:fs";
import type { Config } from "./config.ts";
import { walkResponse } from "./diff-routes.ts";

export type SearchMode = "name" | "glob" | "regex";
export type SearchTypes = "all" | "file" | "dir";

export interface SearchOpts {
  /** name query ("" = every name) */
  q: string;
  mode: SearchMode;
  ignoreCase: boolean;
  /** text to look for inside files ("" = no content search) */
  content: string;
  contentRegex: boolean;
  contentIgnoreCase: boolean;
  types: SearchTypes;
  /** stop after this many hits */
  maxResults: number;
  /** content search: largest file read (bigger files are skipped and counted) */
  maxFileBytes: number;
  /** content search: stop reading after this many bytes in total */
  maxTotalBytes: number;
}

export interface SearchHit {
  p: string;
  t: WalkEntry["t"];
  s: number;
  m: number;
  /** content hits: first matching line (1-based), a trimmed snippet of it, and how many lines matched */
  l?: number;
  x?: string;
  n?: number;
}
export interface SearchBatch {
  h: SearchHit[];
  /** entries examined so far */
  sc: number;
}
export interface SearchSummary extends WalkSummary {
  scanned: number;
  /** files whose content was read */
  grepped: number;
  /** files left out of the content search: too big, binary or unreadable */
  skipped: number;
  /** the result cap or the content byte cap ended the search early */
  capped: boolean;
}

export const MAX_PATTERN = 200;
const MAX_LINE = 2000;
const SNIPPET = 200;

/** Reject the classic catastrophic-backtracking shapes: a quantified group that itself holds a quantifier, or back-references. */
export function safeRegex(src: string, flags: string): RegExp {
  if (src.length > MAX_PATTERN) throw new FsError(400, "pattern too long");
  if (/\\[1-9k]/.test(src) || /\((?:[^()\\]|\\.)*[+*](?:[^()\\]|\\.)*\)\s*[+*{]/.test(src) || /\((?:[^()\\]|\\.)*\{\d*,\d*\}(?:[^()\\]|\\.)*\)\s*[+*{]/.test(src)) {
    throw new FsError(400, "pattern rejected: nested quantifiers or back-references are not allowed");
  }
  try {
    return new RegExp(src, flags);
  } catch {
    throw new FsError(400, "invalid regular expression");
  }
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function nameMatcher(o: SearchOpts): (rel: string, isDir: boolean) => boolean {
  if (!o.q) return () => true;
  if (o.mode === "glob") {
    const m = compileGlobs([o.q], o.ignoreCase);
    return (rel, isDir) => m.test(rel, isDir);
  }
  const re = safeRegex(o.mode === "regex" ? o.q : esc(o.q), o.ignoreCase ? "i" : "");
  return (rel) => re.test(rel.slice(rel.lastIndexOf("/") + 1));
}

/** Binary heuristic: a NUL byte in the first chunk. */
const looksBinary = (b: Buffer) => b.subarray(0, 4096).includes(0);

/**
 * Bounded streaming search over a walk. Names are matched against the entry's base name
 * (globs with a "/" against the path below the start folder); content search reads text
 * files one at a time, line by line, with a per-file size cap and a total byte budget.
 * Yields batches (also empty ones, as progress and so a cancel is noticed promptly).
 */
export async function* searchTree(
  walk: AsyncGenerator<WalkEntry[], WalkSummary>,
  o: SearchOpts,
  read: (rel: string) => Promise<Readable>,
  signal?: AbortSignal,
): AsyncGenerator<SearchBatch, SearchSummary> {
  const nameOk = nameMatcher(o);
  const grep = o.content ? safeRegex(o.contentRegex ? o.content : esc(o.content), o.contentIgnoreCase ? "i" : "") : null;
  if (!o.q && !grep && o.types === "all") throw new FsError(400, "empty search");
  const sum: SearchSummary = { truncated: false, depthLimited: false, errors: 0, scanned: 0, grepped: 0, skipped: 0, capped: false };
  let bytes = 0;
  let found = 0;
  let pending: SearchHit[] = [];
  let last = Date.now();
  const flush = (force = false): SearchBatch | null => {
    if (!force && !pending.length && Date.now() - last < 250) return null;
    const b = { h: pending, sc: sum.scanned };
    pending = [];
    last = Date.now();
    return b;
  };

  const grepFile = async (e: WalkEntry): Promise<{ l: number; x: string; n: number } | null> => {
    if (e.s > o.maxFileBytes) {
      sum.skipped++;
      return null;
    }
    if (bytes + e.s > o.maxTotalBytes) {
      sum.capped = true;
      return null;
    }
    let stream: Readable;
    try {
      stream = await read(e.p);
    } catch {
      sum.skipped++;
      return null;
    }
    const onAbort = () => stream.destroy();
    signal?.addEventListener("abort", onAbort, { once: true });
    let first: { l: number; x: string } | null = null;
    let n = 0;
    let lineNo = 0;
    let carry = "";
    let checked = false;
    let read_ = 0;
    const scan = (line: string) => {
      lineNo++;
      const t = line.length > MAX_LINE ? line.slice(0, MAX_LINE) : line;
      if (grep!.test(t)) {
        n++;
        if (!first) first = { l: lineNo, x: t.trim().slice(0, SNIPPET) };
      }
    };
    try {
      for await (const chunk of stream as AsyncIterable<Buffer>) {
        if (signal?.aborted) throw new FsError(400, "canceled");
        read_ += chunk.length;
        bytes += chunk.length;
        if (!checked) {
          checked = true;
          if (looksBinary(chunk)) {
            sum.skipped++;
            stream.destroy();
            return null;
          }
        }
        if (read_ > o.maxFileBytes) break;
        const parts = (carry + chunk.toString("utf8")).split("\n");
        carry = (parts.pop() as string).slice(-MAX_LINE * 2);
        for (const p of parts) scan(p.endsWith("\r") ? p.slice(0, -1) : p);
        if (bytes > o.maxTotalBytes) {
          sum.capped = true;
          break;
        }
      }
      if (carry) scan(carry);
    } catch (err) {
      if (signal?.aborted) throw err;
      sum.skipped++;
      return null;
    } finally {
      signal?.removeEventListener("abort", onAbort);
      stream.destroy();
    }
    sum.grepped++;
    return first ? { ...(first as { l: number; x: string }), n } : null;
  };

  const gen = walk;
  try {
    for (;;) {
      if (signal?.aborted) throw new FsError(400, "canceled");
      const r = await gen.next();
      if (r.done) {
        sum.truncated = r.value.truncated;
        sum.depthLimited = r.value.depthLimited;
        sum.errors = r.value.errors;
        break;
      }
      for (const e of r.value) {
        sum.scanned++;
        if (signal?.aborted) throw new FsError(400, "canceled");
        const isDir = e.t === "dir";
        if (o.types === "file" && isDir) continue;
        if (o.types === "dir" && !isDir) continue;
        if (!nameOk(e.p, isDir)) continue;
        if (grep) {
          if (e.t !== "file") continue;
          const g = await grepFile(e);
          if (g) pending.push({ p: e.p, t: e.t, s: e.s, m: e.m, l: g.l, x: g.x, n: g.n });
          if (sum.capped) break;
          if (!g) {
            const b = flush();
            if (b) yield b;
            continue;
          }
        } else pending.push({ p: e.p, t: e.t, s: e.s, m: e.m });
        if (++found >= o.maxResults) {
          sum.capped = true;
          break;
        }
        const b = flush();
        if (b) yield b;
      }
      if (sum.capped) break;
      const b = flush();
      if (b) yield b;
    }
  } finally {
    await gen.return({ truncated: false, depthLimited: false, errors: 0 }).catch(() => undefined);
  }
  const rest = flush(true);
  if (rest && rest.h.length) yield rest;
  return sum;
}

const int = (v: string | undefined, d: number, lo: number, hi: number) => {
  const n = v === undefined || v === "" ? d : Number(v);
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, Math.floor(n))) : d;
};

const capped = (v: string | undefined) => {
  if ((v ?? "").length > MAX_PATTERN) throw new FsError(400, "pattern too long");
  return v ?? "";
};

/** Query string -> options (shared by the agent and the network-source app). */
export function parseSearch(q: (k: string) => string | undefined, cfg: { searchMaxFileBytes: number; searchMaxBytes: number }): SearchOpts & { depth: number; hidden: boolean; maxEntries: number } {
  const mode = q("mode") === "glob" ? "glob" : q("mode") === "regex" ? "regex" : "name";
  const types = q("types") === "file" ? "file" : q("types") === "dir" ? "dir" : "all";
  return {
    q: capped(q("q")),
    mode,
    ignoreCase: q("ic") !== "0",
    content: capped(q("content")),
    contentRegex: q("cre") === "1",
    contentIgnoreCase: q("cic") !== "0",
    types,
    maxResults: int(q("maxResults"), 2000, 1, 20000),
    maxFileBytes: int(q("maxFile"), cfg.searchMaxFileBytes, 1, cfg.searchMaxFileBytes),
    maxTotalBytes: cfg.searchMaxBytes,
    depth: int(q("depth"), 32, 1, 64),
    hidden: q("hidden") === "1",
    maxEntries: int(q("max"), 200_000, 1, 500_000),
  };
}

/** At most this many searches walk one agent at a time; more get a 429 and the SPA says to retry. */
export class SearchGate {
  private n = 0;
  constructor(private max: number) {}
  async *wrap<T, S>(gen: AsyncGenerator<T, S>): AsyncGenerator<T, S> {
    if (this.n >= this.max) throw new FsError(429, "too many searches running, try again shortly");
    this.n++;
    try {
      return yield* gen;
    } finally {
      this.n--;
    }
  }
}

export function registerSearchRoutes(app: Hono, cfg: Config) {
  const gate = new SearchGate(cfg.searchConcurrency);
  app.get("/api/fs/search", async (c) => {
    const q = c.req.query.bind(c.req);
    const p = parseSearch(q, cfg);
    const start = q("path") ?? "/";
    const signal = c.req.raw.signal;
    const walk = walkTree(cfg.root, start, { hidden: p.hidden, depth: p.depth, max: Math.min(p.maxEntries, cfg.walkMaxEntries), include: [], exclude: [], ignoreCase: false }, signal);
    const read = async (rel: string) => {
      const r = resolveRead(cfg.root, (start === "/" ? "" : start.replace(/\/+$/, "")) + "/" + rel);
      return createReadStream(r.real, { highWaterMark: 64 * 1024 });
    };
    return walkResponse(gate.wrap(searchTree(walk, p, read, signal)));
  });
}
