import type { MiddlewareHandler } from "hono";
import { getConnInfo } from "@hono/node-server/conninfo";
import { isIP } from "node:net";
import { isRawRoute } from "./request-guard.ts";
import { keyFingerprint } from "./auth/sshkey.ts";

/**
 * Write audit log: one JSON line on stdout (`"audit":true`) per state-changing request, and per admin call (`/api/admin/*`) of any
 * method, GET too, written after the response so the status is known.
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

/**
 * A sign-in body (hub and agent `/api/auth/*`) holds a password or a key signature: only its `name` is kept, and a body of any other
 * shape (an array, say, whose strings `pick` would keep) gives nothing.
 */
function signInBody(v: unknown): { name: string } | undefined {
  if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
  const name = (v as { name?: unknown }).name;
  return typeof name === "string" ? { name: clip(name) } : undefined;
}

/** Whether `p` is an admin path (`/api/admin` or below it): every call there is written, whatever its method or its outcome. */
export const isAdminPath = (p: string): boolean => p === "/api/admin" || p.startsWith("/api/admin/");

/** The most nodes, grants per node and sources an admin audit line keeps (the admin routes take at most 64 grants per node). */
const MAX_ADMIN_ITEMS = 64;
/** The most keys of a `keys` list an admin audit line looks at (an account holds at most 32). */
const MAX_ADMIN_KEYS = 32;

const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * An admin body (`/api/admin/*`) as its audit line keeps it: `name`, `kind`, `admin`, `nodes` as `{ <node>: { runAs, grants: [{path,
 * write}] } }`, `sources` as `{ <source>: { write } }`, for a `publicKey` its `fingerprint` (as OpenSSH prints it), `keys` as the
 * fingerprints of every key in a `keys` list and `publicKey`, and `password` as "set" (a string) or "removed" (null). Nothing else, of
 * the expected types only: never a password, a password hash or the key text. Strings are clipped and lists bounded. A body that is not
 * an object gives nothing.
 */
export function adminBody(v: unknown): Record<string, unknown> | undefined {
  if (!isPlainObject(v)) return undefined;
  const out: Record<string, unknown> = {};
  if (typeof v.name === "string") out.name = clip(v.name);
  if (typeof v.kind === "string") out.kind = clip(v.kind);
  if (typeof v.admin === "boolean") out.admin = v.admin;
  if (isPlainObject(v.nodes)) {
    // (built with fromEntries, so a key such as __proto__ stays a plain field)
    out.nodes = Object.fromEntries(
      Object.entries(v.nodes)
        .slice(0, MAX_ADMIN_ITEMS)
        .filter((e): e is [string, Record<string, unknown>] => isPlainObject(e[1]))
        .map(([node, a]) => {
          const grants = Array.isArray(a.grants)
            ? a.grants
                .slice(0, MAX_ADMIN_ITEMS)
                .filter(isPlainObject)
                .map((g) => ({ ...(typeof g.path === "string" ? { path: clip(g.path) } : {}), ...(typeof g.write === "boolean" ? { write: g.write } : {}) }))
            : undefined;
          return [clip(node), { ...(typeof a.runAs === "string" ? { runAs: clip(a.runAs) } : {}), ...(grants ? { grants } : {}) }];
        }),
    );
  }
  if (isPlainObject(v.sources)) {
    out.sources = Object.fromEntries(
      Object.entries(v.sources)
        .slice(0, MAX_ADMIN_ITEMS)
        .map(([source, a]) => [clip(source), isPlainObject(a) && typeof a.write === "boolean" ? { write: a.write } : {}]),
    );
  }
  // whether a password was set or removed, never the value
  if (typeof v.password === "string") out.password = "set";
  else if (v.password === null) out.password = "removed";
  if (typeof v.publicKey === "string") {
    const fp = keyFingerprint(v.publicKey);
    if (fp) out.fingerprint = fp;
  }
  // every key the body holds (a `keys` list, then `publicKey`), as its fingerprint only; a line that is not a key is left out
  if (Array.isArray(v.keys) || typeof v.publicKey === "string") {
    const lines = [...(Array.isArray(v.keys) ? v.keys.slice(0, MAX_ADMIN_KEYS) : []), v.publicKey];
    const fps = lines.map((k) => (typeof k === "string" ? keyFingerprint(k) : null)).filter((fp): fp is string => fp !== null);
    if (fps.length > 0) out.keys = [...new Set(fps)];
  }
  return out;
}

/** The audit line of a request the guard refused (or, with `aborted`, one whose body the client abandoned before it was acted on, status 499): status, method, route, query and the origin it claimed; the body is never read. The user is named when the account is already known: on an agent always, on the hub never (its guard runs before sign-in, so those lines are "refused before sign-in"). */
/**
 * How many reverse proxies sit in front of this process (FILEDECK_TRUSTED_PROXIES, 0 = none, the default). The forwarded chain
 * is believed only to that depth; with none, a client that talks to the process directly cannot choose the address that is
 * recorded (or used as a key) by sending a header of its own. The count reaches `clientOf` through the context (`trustProxies`).
 */
export const trustProxies = (hops: number): MiddlewareHandler => async (c, next) => {
  c.set("trustedProxies" as never, hops as never);
  await next();
};

/** One hop of a forwarded chain as an IP address: a port and the brackets of an IPv6 address are removed; anything that is not an address gives undefined. */
export function hopAddress(hop: string | undefined): string | undefined {
  let h = (hop ?? "").trim();
  const br = /^\[([^\]]+)\](?::\d{1,5})?$/.exec(h);
  if (br) h = br[1]!;
  else if (/^[^:]+:\d{1,5}$/.test(h)) h = h.slice(0, h.lastIndexOf(":")); // "1.2.3.4:5678" (a bare IPv6 address has several colons)
  h = h.replace(/%[\w.-]+$/, ""); // a zone id
  return isIP(h) ? h : undefined;
}

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
    fwd = parts.length >= hops ? hopAddress(parts[parts.length - hops]) : undefined; // not an address: the socket peer is used
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
      ...userOf(c),
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

/**
 * `sys:<name>` or `virt:<name>` of the account behind a request (set by the hub's gate or the agent's check), else nothing; and
 * `asRoot: true` for a request made under a system administrator's act-as-root switch (no such field otherwise).
 */
function userOf(c: import("hono").Context): { user?: string; asRoot?: true } {
  const u = c.get("user");
  if (!u?.kind || !u.name) return {};
  return { user: `${u.kind}:${u.name}`, ...(u.kind === "sys" && u.asRoot === true ? { asRoot: true as const } : {}) };
}

/**
 * The tailnet part of an audit line (docs/superpowers/specs/2026-11-18-tailscale-sign-in-design.md, "Audit"): for
 * `POST /api/auth/login-tailscale` the device's login and tags, the subject that matched, the source, the device name and its tailnet
 * address (socket source), and on a refusal the reason (with the accounts of a tag conflict); for a request made with a Tailscale
 * session its subject and source, plus the reason when the binding ended the session. Logins, tags and device names are not secrets;
 * the socket path and the raw whois answer never come here.
 */
export type AuditTailnet = {
  login?: string;
  tags?: string[];
  subject?: string;
  source?: "socket" | "headers";
  node?: string;
  address?: string;
  reason?: string;
  accounts?: string[];
};

/** Sets the tailnet part of this request's audit line (the hub's sign-in routes and gate). */
export const setAuditTailnet = (c: import("hono").Context, t: AuditTailnet): void => c.set("auditTailnet" as never, t as never);

function tailnetPart(c: import("hono").Context): { tailnet?: AuditTailnet } {
  const t = c.get("auditTailnet" as never) as AuditTailnet | undefined;
  return t ? { tailnet: t } : {};
}

export function audit(who: string, sink: AuditSink = (l) => console.log(l)): MiddlewareHandler {
  return async (c, next) => {
    const m = c.req.method;
    const p = c.req.path;
    // every admin call is written, whatever its method: reading the accounts and sessions is recorded too
    const admin = isAdminPath(p);
    if (!admin && (m === "GET" || m === "HEAD" || m === "OPTIONS" || !p.startsWith("/api/"))) return next();
    const t0 = Date.now();
    let body: unknown;
    // The body was parsed once by the request guard and is shared through the body cache; without it (a bare audit
    // middleware) only a small declared body is parsed, never one of unknown or large size, whatever its encoding.
    if (!isRawRoute(m, p)) {
      const len = Number(c.req.header("content-length") ?? "0");
      const shared = c.req.bodyCache.json as Promise<unknown> | undefined;
      if (shared || (len > 0 && len <= MAX_BODY && !c.req.raw.headers.has("transfer-encoding"))) {
        try {
          const parsed = await (shared ?? c.req.json());
          body = p.startsWith("/api/auth/") ? signInBody(parsed) : admin ? adminBody(parsed) : pick(parsed);
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
        ...userOf(c),
        ...clientOf(c),
        method: m,
        route: clip(p),
        query: Object.keys(q).length ? q : undefined,
        body,
        ...tailnetPart(c),
        status: c.res.status,
        ms: Date.now() - t0,
      }),
    );
  };
}
