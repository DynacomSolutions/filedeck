import { StringDecoder } from "node:string_decoder";
import { Worker } from "node:worker_threads";
import type { Readable } from "node:stream";
import type { Hono } from "hono";
import { FsError } from "./fsops.ts";
import { compileGlobs, timeSlicer } from "./glob.ts";
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

/**
 * Limits for user regular expressions. A regular expression a user writes can take very long on some text however it
 * is screened, so it is never run on the event loop: each search that uses one gets a worker thread, and the time the
 * search spends waiting for that worker, added up over the whole search, may not pass `regexTotalMs`. Past it, or when
 * the client goes away, the worker is terminated. Only `maxWorkers` such searches run at once. (Mutable for tests.)
 */
export const searchLimits = { regexTotalMs: 20_000, maxWorkers: 4 };

/** Matches many strings in one call (a batch of names, the lines of a chunk), so one round trip serves many tests. */
export interface Tester {
  testMany(items: string[]): Promise<boolean[]>;
  /** release the worker, if any; safe to call twice */
  close(): void;
}

/** The time one search may spend in user regular expressions, shared by its name and content patterns. */
export interface RegexBudget {
  leftMs: number;
}
export const newBudget = (): RegexBudget => ({ leftMs: searchLimits.regexTotalMs });

/** A pattern the program built itself (escaped text): it cannot backtrack badly, so it runs directly. */
function plainTester(re: RegExp): Tester {
  return { testMany: async (items) => items.map((s) => re.test(s)), close() {} };
}

const WORKER_CODE = `
const { parentPort, workerData } = require("node:worker_threads");
const re = new RegExp(workerData.src, workerData.flags);
parentPort.on("message", (m) => {
  const items = m.items, out = new Uint8Array(items.length);
  for (let i = 0; i < items.length; i++) out[i] = re.test(items[i]) ? 1 : 0;
  parentPort.postMessage({ id: m.id, out });
});
`;

let activeWorkers = 0;
const TOO_LONG = "pattern took too long to run: simplify the regular expression";

/**
 * A user's regular expression in a worker thread (see `searchLimits`). Answers 400 when the search's time in it runs
 * out; the event loop is never blocked, and `terminate()` stops even a pattern stuck in backtracking.
 */
function workerTester(src: string, flags: string, budget: RegexBudget, signal?: AbortSignal): Tester {
  safeRegex(src, flags); // length, heuristics and syntax, with the 400 messages
  if (activeWorkers >= searchLimits.maxWorkers) throw new FsError(429, "too many regular-expression searches running, try again shortly");
  activeWorkers++;
  const worker = new Worker(WORKER_CODE, { eval: true, workerData: { src, flags }, resourceLimits: { maxOldGenerationSizeMb: 64, maxYoungGenerationSizeMb: 16 } });
  let closed = false;
  let failure: FsError | null = null;
  let next = 1;
  const pending = new Map<number, { resolve: (v: boolean[]) => void; reject: (e: unknown) => void }>();
  const fail = (e: FsError) => {
    failure ??= e;
    for (const p of pending.values()) p.reject(e);
    pending.clear();
    close();
  };
  const close = () => {
    if (closed) return;
    closed = true;
    activeWorkers--;
    signal?.removeEventListener("abort", onAbort);
    void worker.terminate();
  };
  const onAbort = () => fail(new FsError(400, "canceled"));
  signal?.addEventListener("abort", onAbort, { once: true });
  worker.on("message", (m: { id: number; out: Uint8Array }) => {
    const p = pending.get(m.id);
    pending.delete(m.id);
    p?.resolve(Array.from(m.out, (x) => x === 1));
  });
  worker.on("error", () => fail(new FsError(400, "the regular expression could not be run")));
  worker.on("exit", () => {
    if (!closed && pending.size) fail(new FsError(500, "regular-expression worker stopped"));
  });
  worker.unref(); // after the listeners: adding a "message" listener takes a reference again
  return {
    testMany(items) {
      if (failure) return Promise.reject(failure);
      if (closed) return Promise.reject(new FsError(400, "canceled"));
      if (budget.leftMs <= 0) {
        fail(new FsError(400, TOO_LONG));
        return Promise.reject(failure);
      }
      const id = next++;
      const t0 = performance.now();
      return new Promise<boolean[]>((resolve, reject) => {
        const timer = setTimeout(() => fail(new FsError(400, TOO_LONG)), budget.leftMs);
        const settle = <T>(f: (v: T) => void) => (v: T) => {
          clearTimeout(timer);
          budget.leftMs -= performance.now() - t0;
          f(v);
        };
        pending.set(id, { resolve: settle(resolve), reject: settle(reject) });
        worker.postMessage({ id, items });
      });
    },
    close,
  };
}

/** `userRegex`: the text is a regular expression written by the user; otherwise it is literal text and is escaped. */
export function makeTester(text: string, userRegex: boolean, ignoreCase: boolean, budget: RegexBudget = newBudget(), signal?: AbortSignal): Tester {
  const flags = ignoreCase ? "i" : "";
  return userRegex ? workerTester(text, flags, budget, signal) : plainTester(safeRegex(esc(text), flags));
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Which of the entries match the name query. Names are matched in batches so a regular expression runs as one worker round trip. */
function nameMatcher(o: SearchOpts, testers: Tester[], budget: RegexBudget, signal?: AbortSignal): (es: WalkEntry[]) => Promise<boolean[]> {
  if (!o.q) return async (es) => es.map(() => true);
  if (o.mode === "glob") {
    const m = compileGlobs([o.q], o.ignoreCase);
    return async (es) => {
      const tick = timeSlicer();
      const out: boolean[] = [];
      for (const e of es) {
        const w = tick();
        if (w) await w;
        out.push(m.test(e.p, e.t === "dir"));
      }
      return out;
    };
  }
  const t = makeTester(o.q, o.mode === "regex", o.ignoreCase, budget, signal);
  testers.push(t);
  return (es) => t.testMany(es.map((e) => e.p.slice(e.p.lastIndexOf("/") + 1)));
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
  const testers: Tester[] = [];
  try {
    return yield* searchWith(walk, o, read, testers, signal);
  } finally {
    for (const t of testers) t.close(); // also on a cancelled request: stops a worker that is still matching
    await walk.return({ truncated: false, depthLimited: false, errors: 0 }).catch(() => undefined);
  }
}

async function* searchWith(
  walk: AsyncGenerator<WalkEntry[], WalkSummary>,
  o: SearchOpts,
  read: (rel: string) => Promise<Readable>,
  testers: Tester[],
  signal?: AbortSignal,
): AsyncGenerator<SearchBatch, SearchSummary> {
  const budget = newBudget();
  const nameOk = nameMatcher(o, testers, budget, signal);
  const grep = o.content ? makeTester(o.content, o.contentRegex, o.contentIgnoreCase, budget, signal) : null;
  if (grep) testers.push(grep);
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
    // a multi-byte character cut by the chunk boundary is held back until its remaining bytes arrive
    const decoder = new StringDecoder("utf8");
    let checked = false;
    let read_ = 0;
    const scan = async (lines: string[]) => {
      const ts = lines.map((line) => (line.length > MAX_LINE ? line.slice(0, MAX_LINE) : line));
      const hit = await grep!.testMany(ts);
      for (let i = 0; i < ts.length; i++) {
        lineNo++;
        if (hit[i]) {
          n++;
          if (!first) first = { l: lineNo, x: ts[i]!.trim().slice(0, SNIPPET) };
        }
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
        const parts = (carry + decoder.write(chunk)).split("\n");
        // the unfinished last line goes on into the next chunk; only its first MAX_LINE characters are ever matched
        carry = (parts.pop() as string).slice(0, MAX_LINE);
        await scan(parts.map((p) => (p.endsWith("\r") ? p.slice(0, -1) : p)));
        if (bytes > o.maxTotalBytes) {
          sum.capped = true;
          break;
        }
      }
      carry += decoder.end();
      if (carry) await scan([carry]);
    } catch (err) {
      if (signal?.aborted || err instanceof FsError) throw err;
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
      const nameHit = await nameOk(r.value);
      for (const [idx, e] of r.value.entries()) {
        sum.scanned++;
        if (signal?.aborted) throw new FsError(400, "canceled");
        const isDir = e.t === "dir";
        if (o.types === "file" && isDir) continue;
        if (o.types === "dir" && !isDir) continue;
        if (!nameHit[idx]) continue;
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
