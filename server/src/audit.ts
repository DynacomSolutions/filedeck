import type { MiddlewareHandler } from "hono";

/**
 * Write audit log: one JSON line on stdout per state-changing request
 * (`"audit":true`), written after the response so the status is known.
 * It records who asked (client address as forwarded by the ingress), what
 * (method, route, the paths named in the query or a small JSON body) and the
 * outcome. File contents, upload bodies and credentials are never read.
 */
export type AuditSink = (line: string) => void;

const QUERY_KEYS = ["path", "dir", "name", "from", "to", "id", "volume", "node"];
const BODY_KEYS = ["path", "paths", "from", "to", "toDir", "dir", "name", "node", "volume", "ids", "target", "op", "items", "src", "dst", "destDir", "format", "entries", "overwrite", "level", "exclude"];
const MAX_BODY = 256 * 1024;
const MAX_VALUES = 20;
const MAX_STR = 512;

const clip = (v: string) => (v.length > MAX_STR ? v.slice(0, MAX_STR) + "..." : v);

/** Reduce a parsed JSON body to the named, bounded, string-ish fields. */
export function pick(v: unknown, depth = 0): unknown {
  if (typeof v === "string") return clip(v);
  if (typeof v === "number" || typeof v === "boolean") return v;
  if (depth > 3 || v === null || typeof v !== "object") return undefined;
  if (Array.isArray(v)) return v.slice(0, MAX_VALUES).map((x) => pick(x, depth + 1)).concat(v.length > MAX_VALUES ? [`(+${v.length - MAX_VALUES} more)`] : []);
  const out: Record<string, unknown> = {};
  for (const k of BODY_KEYS) if (k in (v as object)) out[k] = pick((v as Record<string, unknown>)[k], depth + 1);
  return out;
}

export function audit(who: string, sink: AuditSink = (l) => console.log(l)): MiddlewareHandler {
  return async (c, next) => {
    const m = c.req.method;
    const p = c.req.path;
    if (m === "GET" || m === "HEAD" || m === "OPTIONS" || !p.startsWith("/api/")) return next();
    const t0 = Date.now();
    let body: unknown;
    const len = Number(c.req.header("content-length") ?? "0"); // 0 = not declared
    if ((c.req.header("content-type") ?? "").includes("json") && len <= MAX_BODY) {
      try {
        body = pick(await c.req.raw.clone().json());
      } catch {
        body = undefined;
      }
    }
    await next();
    const q: Record<string, string> = {};
    for (const k of QUERY_KEYS) {
      const v = c.req.query(k);
      if (v !== undefined) q[k] = clip(v);
    }
    const fwd = c.req.header("x-forwarded-for")?.split(",")[0]?.trim();
    sink(
      JSON.stringify({
        audit: true,
        ts: new Date(t0).toISOString(),
        who,
        ip: fwd || undefined,
        method: m,
        route: clip(p),
        query: Object.keys(q).length ? q : undefined,
        body,
        status: c.res.status,
        ms: Date.now() - t0,
      }),
    );
  };
}
