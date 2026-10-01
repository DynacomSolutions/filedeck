import type { Hono } from "hono";
import * as ops from "./fsops.ts";
import { Semaphore, hashFile, walkTree, type WalkSummary } from "./walk.ts";
import type { Config } from "./config.ts";

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
export function registerDiffRoutes(app: Hono, cfg: Config) {
  const root = cfg.root;
  const hashes = new Semaphore(Math.max(1, cfg.hashConcurrency));

  app.get("/api/fs/hash", async (c) => {
    const signal = c.req.raw.signal;
    const r = await hashes.run(() => hashFile(root, c.req.query("path") ?? "", signal), signal);
    return c.json({ path: r.path, size: r.size, mtime: r.mtime, sha256: r.sha256 });
  });

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
    const gen = walkTree(root, q("path") ?? "/", opts, c.req.raw.signal);
    // Pull the first batch before answering so path errors still map to a proper status.
    const first = await gen.next();
    const enc = new TextEncoder();
    const line = (o: unknown) => enc.encode(JSON.stringify(o) + "\n");
    const body = new ReadableStream<Uint8Array>({
      async start(ctl) {
        const push = (r: IteratorResult<unknown, WalkSummary>) => {
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
        await gen.return({ truncated: false, depthLimited: false, errors: 0 }).catch(() => undefined);
      },
    });
    return new Response(body, { headers: { "content-type": "application/x-ndjson", "cache-control": "no-store" } });
  });
}
