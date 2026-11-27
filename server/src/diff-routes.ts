import type { Hono } from "hono";
import * as ops from "./fsops.ts";
import fs from "node:fs/promises";
import { watch } from "node:fs";
import path from "node:path";
import { Semaphore, hashFile, walkTree, type WalkEntry, type WalkSummary } from "./walk.ts";
import { IndexCache, spillPath, type DirReader, type IdxEntry } from "./index-cache.ts";
import { isReservedName, resolveRead } from "./paths.ts";
import { FsError } from "./fsops.ts";
import type { Config } from "./config.ts";
import type { DirFeed } from "./events/dirwatch.ts";

/** Where the folder feed of the event bus is set, once the watcher exists (the file routes are made before it). */
export interface FeedRef {
  feed?: DirFeed;
}

/**
 * Directory reader for this machine: readdir + lstat in small batches; symlinks reported, never followed. Folder changes come from the event bus
 * (`feedRef.feed`, while the kernel watcher covers the folder): no watch of the kernel is made. Where it does not cover (no helper, an old kernel, a folder on
 * a network filesystem, a worker process) the reader keeps one `fs.watch` for the folder as it did before; the index bounds how many (`maxWatches`), and
 * a folder it does not watch is trusted by its modification time for a limited time.
 */
export function localReader(root = "/", feedRef: FeedRef = {}): DirReader {
  const virtual = (p: string) => (root === "/" ? p : p === root ? "/" : p.startsWith(root + "/") ? p.slice(root.length) : null);
  return {
    async statDir(p) {
      const st = await fs.stat(p);
      if (!st.isDirectory()) throw new FsError(400, "not a directory");
      return { ino: st.ino, mtime: st.mtimeMs };
    },
    async readDir(p) {
      const names = (await fs.readdir(p)).filter((n) => !isReservedName(n));
      const out: IdxEntry[] = [];
      for (let i = 0; i < names.length; i += 32) {
        const got = await Promise.all(
          names.slice(i, i + 32).map(async (n): Promise<IdxEntry | null> => {
            const real = path.join(p, n);
            try {
              const s = await fs.lstat(real);
              const t = s.isSymbolicLink() ? "symlink" : s.isDirectory() ? "dir" : s.isFile() ? "file" : "other";
              const e: IdxEntry = { n, t, s: t === "dir" ? 0 : s.size, m: Math.floor(s.mtimeMs), i: s.ino };
              if (t === "symlink") e.l = await fs.readlink(real).catch(() => "");
              return e;
            } catch {
              return null; // vanished or unreadable between readdir and lstat
            }
          }),
        );
        for (const g of got) if (g) out.push(g);
      }
      return out;
    },
    watch(p, onChange) {
      const v = virtual(p);
      const viaBus = v === null ? null : (feedRef.feed?.watch(v, () => onChange(null)) ?? null);
      if (viaBus) return viaBus;
      const w = watch(p, { persistent: false }, (_ev, name) => onChange(name ? String(name) : null));
      w.on("error", () => w.close());
      return () => w.close();
    },
  };
}

const int = (v: string | undefined, d: number, lo: number, hi: number) => {
  const n = v === undefined || v === "" ? d : Number(v);
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, Math.floor(n))) : d;
};

/**
 * Agent side of folder diff. Both endpoints are read-only and run next to the
 * data, so comparing two trees never moves file content between nodes.
 *  - GET /api/fs/hash?path=   sha256 of one regular file, streamed, concurrency-limited
 *  - GET /api/fs/walk?path=   NDJSON listing of a tree: {"e":[...]} batches, then {"done":{...}}
 */
export function registerDiffRoutes(app: Hono, cfg: Config, feedRef: FeedRef = {}): IndexCache {
  const root = cfg.root;
  const hashes = new Semaphore(Math.max(1, cfg.hashConcurrency));
  const lists = new Semaphore(Math.max(1, cfg.listConcurrency));
  const index = new IndexCache(cfg.indexDir ? path.join(cfg.indexDir, `index-${cfg.node}.db`) : spillPath("index"), localReader(root, feedRef), { maxWatches: cfg.indexWatches, ttlMs: cfg.indexRevalidateMs });

  app.get("/api/fs/hash", async (c) => {
    const signal = c.req.raw.signal;
    const r = resolveRead(root, c.req.query("path") ?? "");
    const st = await fs.stat(r.real);
    if (st.isDirectory()) throw new FsError(400, "is a directory");
    if (!st.isFile()) throw new FsError(400, "not a regular file");
    const h = await index.hash(r.real, { size: st.size, mtime: Math.floor(st.mtimeMs), ino: st.ino }, () =>
      hashes.run(async () => (await hashFile(root, c.req.query("path") ?? "", signal)).sha256, signal),
    );
    return c.json({ path: r.virtual, size: st.size, mtime: Math.floor(st.mtimeMs), sha256: h.sha256, cached: h.cached });
  });

  // One directory of a lazy compare: every entry (hidden ones too; the hub filters), served from the index when fresh.
  app.get("/api/fs/lsdir", async (c) => {
    const r = resolveRead(root, c.req.query("path") ?? "/");
    const out = await lists.run(() => index.list(r.real), c.req.raw.signal);
    return c.json({ path: r.virtual, cached: out.cached, entries: out.entries });
  });
  // Directories that changed since `since` (kernel change events on indexed directories), for live compares.
  app.get("/api/fs/index-changes", (c) => {
    const ch = index.changes(Number(c.req.query("since") ?? 0) || 0);
    const pre = root === "/" ? "" : root;
    return c.json({ seq: ch.seq, reset: ch.reset, dirs: ch.dirs.filter((d) => d === root || d.startsWith(pre + "/")).map((d) => d.slice(pre.length) || "/") });
  });
  app.get("/api/fs/index-stats", (c) => c.json({ enabled: index.enabled, ...index.stats }));

  app.get("/api/fs/walk", async (c) => {
    const q = c.req.query.bind(c.req);
    const opts = {
      hidden: q("hidden") === "1",
      depth: int(q("depth"), 32, 1, 64),
      max: int(q("max"), 100_000, 1, cfg.walkMaxEntries),
      include: (c.req.queries("include") ?? []).slice(0, 100),
      exclude: (c.req.queries("exclude") ?? []).slice(0, 100),
      ignoreCase: q("ignoreCase") === "1",
    };
    return walkResponse(walkTree(root, q("path") ?? "/", opts, c.req.raw.signal));
  });
  return index;
}

/** NDJSON body for a walk generator: {"e":[...]} batches, then {"done":{...}}. Pulls the first batch so path errors map to a status. */
export async function walkResponse<T = WalkEntry[], S = WalkSummary>(gen: AsyncGenerator<T, S>): Promise<Response> {
  // Pull the first batch before answering so path errors still map to a proper status.
  const first = await gen.next();
  const enc = new TextEncoder();
  const line = (o: unknown) => enc.encode(JSON.stringify(o) + "\n");
  const body = new ReadableStream<Uint8Array>({
    async start(ctl) {
      const push = (r: IteratorResult<unknown, unknown>) => {
        ctl.enqueue(line(r.done ? { done: r.value } : { e: r.value }));
      };
      push(first);
      if (first.done) return ctl.close();
    },
    async pull(ctl) {
      if (first.done) return;
      try {
        const r = await gen.next();
        ctl.enqueue(line(r.done ? { done: r.value } : { e: r.value }));
        if (r.done) ctl.close();
      } catch (e) {
        ctl.enqueue(line({ error: ops.mapError(e).message }));
        ctl.close();
      }
    },
    async cancel() {
      await gen.return({ truncated: false, depthLimited: false, errors: 0 } as S).catch(() => undefined);
    },
  });
  return new Response(body, { headers: { "content-type": "application/x-ndjson", "cache-control": "no-store" } });
}
