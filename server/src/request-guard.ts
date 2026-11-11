import type { MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { auditRefusal, type AuditSink } from "./audit.ts";

/**
 * Request guard for every HTTP surface that changes state (hub, agent and the
 * network-source app). Three checks on a request whose method is not
 * GET, HEAD or OPTIONS:
 *
 *  1. Same origin. A browser that names the request as cross-site
 *     (`Sec-Fetch-Site` other than `same-origin` or `none`), or whose `Origin`
 *     host differs from the `Host` header, is refused with 403. A request with
 *     neither header (the CLI, curl, the hub calling an agent) is allowed: it
 *     is not a browser acting for a web page.
 *  2. JSON content type. Where the body is parsed as JSON the request must say
 *     so (`application/json` or `+json`), otherwise 415. The routes that take
 *     a raw body (editor save, upload, upload chunk) are exempt.
 *  3. Size. JSON bodies are capped at MAX_JSON_BODY (a body without Content-Length is counted as it arrives) and an editor save at
 *     `maxEdit`, before anything is buffered. Raw upload streams are never
 *     touched here (they have their own limit and are streamed, not cloned).
 */
/** Largest JSON body: the biggest job the hub accepts (10,000 items or steps) with long paths fits well within it. */
export const MAX_JSON_BODY = 16 * 1024 * 1024;

/** The path as the agent sees it: a hub request for `/api/nodes/<node>/<rest>` is judged by `<rest>`. */
export function agentPath(p: string): string {
  const m = /^\/api\/nodes\/[^/]+(\/.*)$/.exec(p);
  return m ? (m[1] as string) : p;
}

/** Routes whose body is raw bytes, not JSON. */
export function isRawRoute(method: string, p: string): boolean {
  const r = agentPath(p);
  return (method === "PUT" && (r === "/api/fs/write" || r === "/api/fs/upload")) || (method === "PATCH" && r === "/api/upload/chunk");
}

const SAFE = new Set(["GET", "HEAD", "OPTIONS"]);
const JSON_TYPE = /^application\/(?:[\w.+-]+\+)?json\s*(?:;|$)/i;

/** Whether `host` (a Host header value) is in a list of `host` or `host:port` entries; an entry without a port accepts any port. */
export function matchesHostList(host: string, list: readonly string[]): boolean {
  const h = host.toLowerCase();
  return list.includes(h) || list.includes(h.replace(/:\d+$/, ""));
}

/**
 * Without Sec-Fetch-Site the Origin must name this server: the Host header, the host a reverse proxy says it was
 * asked for (X-Forwarded-Host: a cross-site page cannot set it without a preflight, which is never granted), or a
 * listed host.
 */
function crossSite(c: import("hono").Context, allowed: readonly string[]): boolean {
  const site = c.req.header("sec-fetch-site");
  if (site) return site !== "same-origin" && site !== "none";
  const origin = c.req.header("origin");
  if (origin === undefined) return false;
  let oh: string;
  try {
    oh = new URL(origin).host.toLowerCase();
  } catch {
    return true; // "null" and anything that is not an origin
  }
  const host = (c.req.header("host") ?? new URL(c.req.url).host).toLowerCase();
  if (oh === host) return false;
  const fwd = c.req.header("x-forwarded-host")?.split(",")[0]?.trim().toLowerCase();
  if (fwd && oh === fwd) return false;
  return !matchesHostList(oh, allowed);
}

export interface GuardOptions {
  /** cap for PUT /api/fs/write (bytes); unset = none */
  maxEdit?: number;
  maxJson?: number;
  /** extra host names an Origin may carry (the hub's allowed-hosts list) */
  allowedHosts?: readonly string[];
  /** where a refused request is written to the audit log (the body is not read) */
  audit?: { who: string; sink?: AuditSink };
}

/** Headers a browser adds that the next hop must not see (the hub has already judged them). */
export function stripBrowserContext(h: Headers): void {
  for (const k of [...h.keys()]) if (k === "origin" || k.startsWith("sec-fetch-")) h.delete(k);
}

export function requestGuard(o: GuardOptions = {}): MiddlewareHandler {
  const maxJson = o.maxJson ?? MAX_JSON_BODY;
  const tooBig = (c: import("hono").Context) => refuse(c, 413, "request body too large");
  const jsonLimit = bodyLimit({ maxSize: maxJson, onError: tooBig });
  const editLimit = o.maxEdit ? bodyLimit({ maxSize: o.maxEdit, onError: tooBig }) : undefined;
  const allowed = (o.allowedHosts ?? []).map((h) => h.toLowerCase());
  const refuse = (c: import("hono").Context, status: 403 | 413 | 415, error: string) => {
    if (o.audit) auditRefusal(o.audit.who, c, status, o.audit.sink);
    return c.json({ error }, status);
  };
  return async (c, next) => {
    const m = c.req.method;
    if (SAFE.has(m)) return next();
    if (crossSite(c, allowed)) return refuse(c, 403, "cross-site request refused");
    if (isRawRoute(m, c.req.path)) return m === "PUT" && agentPath(c.req.path) === "/api/fs/write" && editLimit ? editLimit(c, next) : next();
    const ct = c.req.header("content-type");
    const cl = c.req.header("content-length");
    const hasBody = c.req.raw.headers.has("transfer-encoding") || (cl !== undefined ? cl !== "0" : ct !== undefined);
    if (hasBody && !(ct && JSON_TYPE.test(ct))) return refuse(c, 415, "content type must be application/json");
    return jsonLimit(c, next);
  };
}
