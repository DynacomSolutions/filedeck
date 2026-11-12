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
 *  3. Size. JSON bodies are capped at MAX_SMALL_JSON, or MAX_JSON_BODY on the bulk routes, and an editor save at
 *     `maxEdit`. A body is counted as it arrives (also without Content-Length) and refused as soon as it is over the
 *     cap. Raw upload streams are never touched here (they have their own limit and are streamed, not cloned).
 *
 * A JSON body is read and parsed once, here: the parsed value is kept on the request, so the read-only
 * guard, the audit log and the route's own `c.req.json()` (replaced for this request) all get that same value, and the bytes are handed on for a
 * proxy that forwards the body.
 */
/**
 * Largest JSON body on the bulk routes (the biggest job the hub accepts, 10,000 items or steps, with long paths);
 * every other JSON route is held to MAX_SMALL_JSON.
 */
export const MAX_JSON_BODY = 16 * 1024 * 1024;
export const MAX_SMALL_JSON = 1024 * 1024;
/** The audit line reads a body only up to this size (see audit.ts). */
const AUDIT_BODY = 256 * 1024;

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

const DEFAULT_PORT: Record<string, string> = { http: "80", https: "443" };

function splitHost(h: string): { name: string; port?: string } {
  const m = /^(\[[^\]]*\]|[^:]*)(?::(\d*))?$/.exec(h.trim().toLowerCase());
  return { name: m?.[1] ?? h.toLowerCase(), ...(m?.[2] ? { port: m[2] } : {}) };
}

/**
 * Whether a Host header value is in a list of `host` or `host:port` entries. Host names are compared; a port only when
 * the entry names one. A request without a port in its Host header is on the scheme's default port, so an entry
 * `files.example:443` (or `:80`) matches `Host: files.example`, and an entry `files.example` matches any port.
 */
export function matchesHostList(host: string, list: readonly string[]): boolean {
  const h = splitHost(host);
  return list.some((e) => {
    const x = splitHost(e);
    return x.name === h.name && (!x.port || x.port === h.port || (h.port === undefined && (x.port === "80" || x.port === "443")));
  });
}

/**
 * An Origin that names a listed host. The scheme and port must be those of this request's own origin where that is
 * known (X-Forwarded-Proto, the ports in Host and X-Forwarded-Host); a listed entry that names a port accepts that
 * port only; an entry without one accepts only the request's own port, or the default ports when none is known.
 */
function originListed(c: import("hono").Context, u: URL, allowed: readonly string[]): boolean {
  const scheme = u.protocol.slice(0, -1);
  const port = u.port || DEFAULT_PORT[scheme] || "";
  const xfp = c.req.header("x-forwarded-proto")?.split(",")[0]?.trim().toLowerCase();
  if (xfp && xfp !== scheme) return false;
  const own = new Set<string>();
  const hostPort = splitHost(c.req.header("host") ?? "").port;
  const fwdPort = splitHost(c.req.header("x-forwarded-host")?.split(",")[0] ?? "").port;
  for (const p of [hostPort, fwdPort, xfp ? DEFAULT_PORT[xfp] : undefined]) if (p) own.add(p);
  if (own.size === 0) own.add("80").add("443");
  const name = u.hostname.toLowerCase();
  return allowed.some((e) => {
    const x = splitHost(e);
    return x.name === name && (x.port ? x.port === port : own.has(port));
  });
}

/**
 * Without Sec-Fetch-Site the Origin must name this server: the Host header, the host a reverse proxy says it was
 * asked for (X-Forwarded-Host: a cross-site page cannot set it without a preflight, which is never granted), or a
 * listed host (see originListed).
 */
function crossSite(c: import("hono").Context, allowed: readonly string[]): boolean {
  const site = c.req.header("sec-fetch-site");
  if (site) return site !== "same-origin" && site !== "none";
  const origin = c.req.header("origin");
  if (origin === undefined) return false;
  let u: URL;
  try {
    u = new URL(origin);
  } catch {
    return true; // "null" and anything that is not an origin
  }
  const oh = u.host.toLowerCase();
  const host = (c.req.header("host") ?? new URL(c.req.url).host).toLowerCase();
  if (oh === host) return false;
  const fwd = c.req.header("x-forwarded-host")?.split(",")[0]?.trim().toLowerCase();
  if (fwd && oh === fwd) return false;
  return !originListed(c, u, allowed);
}

const BULK = new Set(["/api/ops/jobs", "/api/fs/delete", "/api/fs/trash", "/api/fs/copy", "/api/fs/move", "/api/jobs/compress", "/api/trash/restore", "/api/trash/delete", "/api/diff/jobs", "/api/jobs/extract", "/api/fs/zip-ticket"]);
const BULK_DIFF = /^\/api\/diff\/jobs\/[^/]+\/(?:focus|subtree)$/;

/** Routes that take lists of paths (up to the item limit of a job) and so may carry a large JSON body. */
export function isBulkRoute(p: string): boolean {
  const r = agentPath(p);
  return BULK.has(r) || BULK_DIFF.test(r);
}

/** Thrown into a forwarded body that outgrew its cap (the proxy answers 413 for it). */
export class BodyTooLarge extends Error {
  constructor() {
    super("request body too large");
    this.name = "BodyTooLarge";
  }
}

/** Whether `e` (or what it wraps) is a BodyTooLarge. */
export function isBodyTooLarge(e: unknown): boolean {
  for (let x = e as { name?: string; cause?: unknown } | undefined, i = 0; x && i < 5; x = x.cause as typeof x, i++) if (x.name === "BodyTooLarge") return true;
  return false;
}

/** The body passed on as it arrives, counted, and failed as soon as it is over `max` (nothing is buffered or parsed). */
function capStream(body: ReadableStream<Uint8Array>, max: number): ReadableStream<Uint8Array> {
  let n = 0;
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, ctl) {
        n += chunk.length;
        if (n > max) ctl.error(new BodyTooLarge());
        else ctl.enqueue(chunk);
      },
    }),
  );
}

/** Read a request body up to `max` bytes; `undefined` as soon as it is over (the rest is not read). */
async function readCapped(req: Request, max: number): Promise<Buffer | undefined> {
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (declared > max) return undefined;
  const reader = req.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const parts: Uint8Array[] = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.length;
    if (n > max) {
      void reader.cancel().catch(() => undefined);
      return undefined;
    }
    parts.push(value);
  }
  return Buffer.concat(parts, n);
}

export interface GuardOptions {
  /** cap for PUT /api/fs/write (bytes); unset = none */
  maxEdit?: number;
  maxJson?: number;
  /** extra host names an Origin may carry (the hub's allowed-hosts list) */
  allowedHosts?: readonly string[];
  /** the hub: a request proxied to an agent is checked and counted while its bytes pass through, never parsed here (the agent parses it once) */
  forward?: boolean;
  /** where a refused request is written to the audit log (the body is not read) */
  audit?: { who: string; sink?: AuditSink };
}

/** Headers a browser adds that the next hop must not see (the hub has already judged them). */
export function stripBrowserContext(h: Headers): void {
  for (const k of [...h.keys()]) if (k === "origin" || k.startsWith("sec-fetch-")) h.delete(k);
}

export function requestGuard(o: GuardOptions = {}): MiddlewareHandler {
  const maxBulk = o.maxJson ?? MAX_JSON_BODY;
  const maxSmall = Math.min(MAX_SMALL_JSON, maxBulk);
  const editLimit = o.maxEdit
    ? bodyLimit({ maxSize: o.maxEdit, onError: (c) => refuse(c, 413, "request body too large") })
    : undefined;
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
    if (!hasBody) return next();
    if (!(ct && JSON_TYPE.test(ct))) return refuse(c, 415, "content type must be application/json");
    const cap = isBulkRoute(c.req.path) ? maxBulk : maxSmall;
    if (o.forward && agentPath(c.req.path) !== c.req.path && !(cl !== undefined && Number(cl) <= AUDIT_BODY)) {
      // proxied, and not small enough to be worth reading for the audit line: stream it through under the cap
      if (Number(cl ?? "0") > cap) return refuse(c, 413, "request body too large");
      if (c.req.raw.body) c.req.raw = new Request(c.req.raw, { body: capStream(c.req.raw.body, cap), duplex: "half" } as RequestInit);
      return next();
    }
    let buf: Buffer | undefined;
    try {
      buf = await readCapped(c.req.raw, cap);
    } catch {
      // the client went away while sending: nothing was acted on, and it is said so in the audit log
      if (o.audit) auditRefusal(o.audit.who, c, 499, o.audit.sink, true);
      return new Response(null, { status: 499 });
    }
    if (!buf) return refuse(c, 413, "request body too large");
    // parse once; everything after this (read-only guard, audit, the route) gets this value from the body cache
    const parsed = new Promise<unknown>((resolve, reject) => {
      try {
        resolve(JSON.parse(new TextDecoder().decode(buf))); // decode() drops a leading byte-order mark, as Request.json() does
      } catch (e) {
        reject(e);
      }
    });
    parsed.catch(() => undefined);
    c.req.bodyCache.json = parsed; // Hono's own json() parses the text again on every call, so it is replaced by the shared value
    c.req.json = () => parsed as Promise<never>;
    c.req.raw = new Request(c.req.raw, { body: buf as unknown as BodyInit });
    return next();
  };
}
