import type { MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";

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
 *  3. Size. JSON bodies are capped at MAX_JSON_BODY and an editor save at
 *     `maxEdit`, before anything is buffered. Raw upload streams are never
 *     touched here (they have their own limit and are streamed, not cloned).
 */
export const MAX_JSON_BODY = 1024 * 1024;

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

function crossSite(site: string | undefined, origin: string | undefined, host: string): boolean {
  if (site) return site !== "same-origin" && site !== "none";
  if (origin === undefined) return false;
  try {
    return new URL(origin).host !== host;
  } catch {
    return true; // "null" and anything that is not an origin
  }
}

export interface GuardOptions {
  /** cap for PUT /api/fs/write (bytes); unset = none */
  maxEdit?: number;
  maxJson?: number;
}

/** Headers a browser adds that the next hop must not see (the hub has already judged them). */
export function stripBrowserContext(h: Headers): void {
  for (const k of [...h.keys()]) if (k === "origin" || k.startsWith("sec-fetch-")) h.delete(k);
}

export function requestGuard(o: GuardOptions = {}): MiddlewareHandler {
  const maxJson = o.maxJson ?? MAX_JSON_BODY;
  const tooBig = (c: import("hono").Context) => c.json({ error: "request body too large" }, 413);
  const jsonLimit = bodyLimit({ maxSize: maxJson, onError: tooBig });
  const editLimit = o.maxEdit ? bodyLimit({ maxSize: o.maxEdit, onError: tooBig }) : undefined;
  return async (c, next) => {
    const m = c.req.method;
    if (SAFE.has(m)) return next();
    const host = c.req.header("host") ?? new URL(c.req.url).host;
    if (crossSite(c.req.header("sec-fetch-site"), c.req.header("origin"), host)) return c.json({ error: "cross-site request refused" }, 403);
    if (isRawRoute(m, c.req.path)) return m === "PUT" && agentPath(c.req.path) === "/api/fs/write" && editLimit ? editLimit(c, next) : next();
    const ct = c.req.header("content-type");
    const cl = c.req.header("content-length");
    const hasBody = c.req.raw.headers.has("transfer-encoding") || (cl !== undefined ? cl !== "0" : ct !== undefined);
    if (hasBody && !(ct && JSON_TYPE.test(ct))) return c.json({ error: "content type must be application/json" }, 415);
    return jsonLimit(c, next);
  };
}
