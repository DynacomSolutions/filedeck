import type { MiddlewareHandler } from "hono";
import { getConnInfo } from "@hono/node-server/conninfo";
import { isRawRoute } from "./request-guard.ts";

/**
 * Write audit log: one JSON line on stdout per state-changing request
 * (`"audit":true`), written after the response so the status is known.
 * It records who asked (`ip`: the last X-Forwarded-For entry, else the socket peer; `forwardedFor` keeps the whole chain, which the caller can write; `peer` the socket address), what
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

/** The audit line of a request the guard refused (or, with `aborted`, one whose body the client abandoned before it was acted on, status 499): status, method, route, query and the origin it claimed; the body is never read. */
/**
 * How many reverse proxies sit in front of this process (FILEDECK_TRUSTED_PROXIES, 0 = none, the default). The forwarded chain
 * is believed only to that depth; with none, a client that talks to the process directly cannot choose the address that is
 * recorded (or used as a key) by sending a header of its own. The count reaches `clientOf` through the context (`trustProxies`).
 */
export const trustProxies = (hops: number): MiddlewareHandler => async (c, next) => {
  c.set("trustedProxies" as never, hops as never);
  await next();
};

/**
 * Who asked: with that many proxies in front, the `X-Forwarded-For` entry that many places from the right (what the
 * outermost trusted proxy saw; the chain is kept as the caller can write it), otherwise the socket's peer address.
 */
export function clientOf(c: import("hono").Context): Record<string, string> {
  const chain = c.req.header("x-forwarded-for");
  let peer: string | undefined;
  try {
    peer = getConnInfo(c).remote.address;
  } catch {
    peer = undefined; // not served over a socket (tests)
  }
  let fwd: string | undefined;
  const hops = Number((c as { get(k: string): unknown }).get("trustedProxies") ?? 0) || 0;
  if (hops > 0 && chain) {
    const parts = chain.split(",").map((x) => x.trim());
    fwd = parts.length >= hops ? parts[parts.length - hops] : undefined;
  }
  const ip = fwd || peer;
  return {
    ...(ip ? { ip } : {}),
    ...(hops > 0 && chain && chain.includes(",") ? { forwardedFor: clip(chain) } : {}),
    ...(peer && fwd && fwd !== peer ? { peer } : {}),
  };
}

export function auditRefusal(who: string, c: import("hono").Context, status: number, sink: AuditSink = (l) => console.log(l), aborted = false): void {
  const q: Record<string, string> = {};
  for (const k of QUERY_KEYS) {
    const v = c.req.query(k);
    if (v !== undefined) q[k] = clip(v);
  }
  const origin = c.req.header("origin");
  const site = c.req.header("sec-fetch-site");
  sink(
    JSON.stringify({
      audit: true,
      ts: new Date().toISOString(),
      who,
      ...clientOf(c),
      method: c.req.method,
      route: clip(c.req.path),
      query: Object.keys(q).length ? q : undefined,
      ...(origin ? { origin: clip(origin) } : {}),
      ...(site ? { fetchSite: site } : {}),
      ...(aborted ? { aborted: true } : { refused: true }),
      status,
    }),
  );
}

export function audit(who: string, sink: AuditSink = (l) => console.log(l)): MiddlewareHandler {
  return async (c, next) => {
    const m = c.req.method;
    const p = c.req.path;
    if (m === "GET" || m === "HEAD" || m === "OPTIONS" || !p.startsWith("/api/")) return next();
    const t0 = Date.now();
    let body: unknown;
    // The body was parsed once by the request guard and is shared through the body cache; without it (a bare audit
    // middleware) only a small declared body is parsed, never one of unknown or large size, whatever its encoding.
    if (!isRawRoute(m, p)) {
      const len = Number(c.req.header("content-length") ?? "0");
      const shared = c.req.bodyCache.json as Promise<unknown> | undefined;
      if (shared || (len > 0 && len <= MAX_BODY && !c.req.raw.headers.has("transfer-encoding"))) {
        try {
          body = pick(await (shared ?? c.req.json()));
        } catch {
          body = undefined;
        }
      }
    }
    await next();
    const q: Record<string, string> = {};
    for (const k of QUERY_KEYS) {
      const v = c.req.query(k);
      if (v !== undefined) q[k] = clip(v);
    }
    sink(
      JSON.stringify({
        audit: true,
        ts: new Date(t0).toISOString(),
        who,
        ...clientOf(c),
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
