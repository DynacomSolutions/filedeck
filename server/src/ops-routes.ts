import type { Hono } from "hono";
import { OpQueue, OpError, type Choice, type ConflictPolicy, type Loc, type OpSpec, type SyncStep } from "./ops-queue.ts";
import type { Target } from "./hub.ts";

const MAX_ITEMS = 10_000;
const POLICIES = new Set(["ask", "skip", "overwrite", "rename"]);

/**
 * Hub job queue API for bulk operations:
 *   POST   /api/ops/jobs                {op, items|steps, dst?, conflict?}
 *   GET    /api/ops/jobs                summaries
 *   GET    /api/ops/jobs/:id            with per-item progress
 *   POST   /api/ops/jobs/:id/{pause,resume,cancel}
 *   POST   /api/ops/jobs/:id/resolve    {action: skip|overwrite|rename, all?}
 *   DELETE /api/ops/jobs/:id            forget a finished job
 */
export function registerOps(app: Hono, agents: Map<string, Target>, isSource: (node: string) => boolean): OpQueue {
  const queue = new OpQueue({ agents, isSource });

  const abs = (p: unknown, what: string): string => {
    if (typeof p !== "string" || !p.startsWith("/") || p.includes("\0")) throw new OpError(400, `${what} must be an absolute path`);
    return p;
  };
  const node = (n: unknown): string => {
    if (typeof n !== "string" || !agents.has(n)) throw new OpError(404, `unknown node ${String(n)}`);
    return n;
  };
  const loc = (v: unknown, what: string): Loc => {
    const o = v as Partial<Loc> | null;
    const p = abs(o?.path, what);
    if (p === "/") throw new OpError(400, `${what} cannot be the root`);
    return { node: node(o?.node), path: p };
  };
  const dest = (v: unknown) => {
    const o = v as { node?: unknown; dir?: unknown } | null;
    return { node: node(o?.node), dir: abs(o?.dir, "dst.dir") };
  };
  const list = <T,>(v: unknown, what: string, f: (x: unknown) => T): T[] => {
    if (!Array.isArray(v) || v.length === 0 || v.length > MAX_ITEMS) throw new OpError(400, `${what} must be a list of 1 to ${MAX_ITEMS} entries`);
    return v.map(f);
  };

  function parse(b: unknown): OpSpec {
    const o = b as Record<string, unknown> | null;
    if (!o || typeof o !== "object") throw new OpError(400, "invalid JSON body");
    switch (o.op) {
      case "copy":
      case "move": {
        const conflict = (o.conflict ?? "ask") as string;
        if (!POLICIES.has(conflict)) throw new OpError(400, "conflict must be ask, skip, overwrite or rename");
        return { op: o.op, items: list(o.items, "items", (x) => loc(x, "item")), dst: dest(o.dst), conflict: conflict as ConflictPolicy, preserveTimes: o.preserveTimes === true };
      }
      case "trash":
      case "delete":
        return { op: o.op, items: list(o.items, "items", (x) => loc(x, "item")) };
      case "sync": {
        const steps = list(o.steps, "steps", (x): SyncStep => {
          const s = x as Record<string, unknown> | null;
          if (s?.kind === "mkdir" || s?.kind === "trash") return { kind: s.kind, ...(({ node: n, path: p }) => ({ node: node(n), path: abs(p, "path") }))(s as { node: unknown; path: unknown }) };
          if (s?.kind === "copy") {
            const bytes = typeof s.bytes === "number" && s.bytes >= 0 ? s.bytes : undefined;
            return { kind: "copy", src: loc(s.src, "src"), dst: dest(s.dst), ...(bytes !== undefined ? { bytes } : {}) };
          }
          throw new OpError(400, "unknown sync step");
        });
        return { op: "sync", steps, ...(typeof o.title === "string" ? { title: o.title.slice(0, 200) } : {}) };
      }
    }
    throw new OpError(400, "op must be copy, move, trash, delete or sync");
  }

  const fail = (e: unknown) => {
    const m = e instanceof OpError ? e : new OpError(400, "bad request");
    return Response.json({ error: m.message }, { status: m.status });
  };

  app.post("/api/ops/jobs", async (c) => {
    try {
      return c.json(queue.create(parse(await c.req.json().catch(() => null))), 202);
    } catch (e) {
      return fail(e);
    }
  });
  app.get("/api/ops/jobs", (c) => c.json({ jobs: queue.list() }));
  const one = (fn: (id: string) => unknown) => (c: import("hono").Context) => {
    const v = fn(c.req.param("id") ?? "");
    return v ? c.json(v) : c.json({ error: "not found" }, 404);
  };
  app.get("/api/ops/jobs/:id", one((id) => queue.get(id)));
  app.post("/api/ops/jobs/:id/pause", one((id) => queue.pause(id)));
  app.post("/api/ops/jobs/:id/resume", one((id) => queue.resume(id)));
  app.post("/api/ops/jobs/:id/cancel", one((id) => queue.cancel(id)));
  app.post("/api/ops/jobs/:id/resolve", async (c) => {
    const b = (await c.req.json().catch(() => null)) as { action?: string; all?: boolean } | null;
    if (!b || !["skip", "overwrite", "rename"].includes(b.action ?? "")) return c.json({ error: "action must be skip, overwrite or rename" }, 400);
    const r = queue.resolve(c.req.param("id"), b.action as Choice, b.all === true);
    if (r === undefined) return c.json({ error: "not found" }, 404);
    if (r === "none") return c.json({ error: "job is not waiting for an answer" }, 409);
    return c.json(r);
  });
  app.delete("/api/ops/jobs/:id", (c) => (queue.dismiss(c.req.param("id")) ? c.json({ ok: true }) : c.json({ error: "not found or still active" }, 404)));
  return queue;
}
