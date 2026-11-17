import type { MiddlewareHandler } from "hono";
import { PathError, cleanVirtual, resolveInRoot } from "./paths.ts";
import { BODY_ROUTES } from "./readonly.ts";
import { MAX_JSON_BODY, isRawRoute } from "./request-guard.ts";

/**
 * A virtual account's worker answers only for paths inside its grants. Landlock limits what the worker can open, but not what `stat`
 * shows (size, owner, times of a file outside the grants) nor changes of modes, owners and times; so every path a request names must lie
 * inside a grant, else 403 `outside your folders`. A grant that does not allow writing is also a read-only prefix of the worker
 * (`readOnlyGuard`), which refuses every change under it. Landlock stays as the second layer.
 */

export interface Grant {
  path: string;
  write: boolean;
}

/** query parameters that hold a path */
const QUERY_KEYS = ["path", "dir"];
/** JSON body fields that hold one path or a list of paths (`volume` names a trash store, which the trash routes check themselves) */
const BODY_KEYS = ["path", "paths", "from", "to", "toDir", "dir", "destDir"];
/** fields whose entry itself is changed or removed, not what a link there leads to: only the link's own place must be inside */
const OWN_ENTRY: Record<string, string[]> = {
  "/api/fs/delete": ["paths"],
  "/api/fs/trash": ["paths"],
  "/api/fs/rename": ["from", "to"],
  "/api/fs/move": ["from"],
  "/api/fs/symlink": ["path"],
};
const ROUTES_WITH_BODY = new Set([...BODY_ROUTES, "/api/fs/zip-ticket"]);

/**
 * The routes whose path is optional (missing or empty means `/` or the served root to the route): there the guard checks `/` when the
 * request names none, so a request without a path is not a way around it.
 */
const PATH_ROUTES = new Set([
  "/api/fs/list", "/api/fs/stat", "/api/fs/read", "/api/fs/download", "/api/fs/text", "/api/fs/write", "/api/fs/fid", "/api/fs/props",
  "/api/fs/search", "/api/fs/walk", "/api/fs/lsdir", "/api/fs/hash", "/api/fs/thumb", "/api/fs/mediainfo", "/api/fs/transcode",
  "/api/archive/list", "/api/pdf/status", "/api/pdf/decrypted", "/api/git/status", "/api/git/info", "/api/git/show", "/api/git/worktrees",
  "/api/git/refs", "/api/git/diff", "/api/git/blob", "/api/events",
]);
const DIR_ROUTES = new Set(["/api/fs/upload", "/api/upload/status", "/api/upload/chunk", "/api/upload"]);
/** a body field that the route reads as `/` when it is missing */
const BODY_DEFAULTS: Record<string, string> = { "/api/fs/zip-ticket": "dir" };

const under = (v: string, g: string) => g === "/" || v === g || v.startsWith(g + "/");
const arr = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : typeof v === "string" ? [v] : []);

/** Whether `p` (a client path) lies inside one of the grants: as written, with the links on the way resolved, and (unless `own`) with a link at its end followed too. */
export function insideGrants(root: string, grants: Grant[], p: string, own = false): boolean {
  const inside = (v: string) => grants.some((g) => under(v, g.path));
  try {
    if (!inside("/" + cleanVirtual(p).join("/"))) return false;
    if (!inside(resolveInRoot(root, p, { followFinal: false }).virtual)) return false;
    return own || inside(resolveInRoot(root, p, { followFinal: true }).virtual);
  } catch (e) {
    if (e instanceof PathError) return false;
    throw e;
  }
}

export function grantGuard(root: string, grants: Grant[]): MiddlewareHandler {
  const deny = () => Response.json({ error: "outside your folders" }, { status: 403 });
  return async (c, next) => {
    const paths: { p: string; own: boolean }[] = [];
    const url = new URL(c.req.url);
    for (const k of QUERY_KEYS) for (const v of url.searchParams.getAll(k)) paths.push({ p: v || "/", own: false });
    const named = (k: string) => url.searchParams.getAll(k).length > 0;
    // (a zip with a ticket takes its folder from the ticket, which was checked when it was made)
    const optional = PATH_ROUTES.has(c.req.path) ? "path" : DIR_ROUTES.has(c.req.path) || (c.req.path === "/api/fs/zip" && !named("ticket")) ? "dir" : null;
    if (optional && !named(optional)) paths.push({ p: "/", own: false });
    if (c.req.method === "POST" && ROUTES_WITH_BODY.has(c.req.path) && !isRawRoute(c.req.method, c.req.path)) {
      if (Number(c.req.header("content-length") ?? "0") > MAX_JSON_BODY) return c.json({ error: "request body too large" }, 413);
      let body: Record<string, unknown>;
      try {
        const j = await c.req.json();
        if (!j || typeof j !== "object" || Array.isArray(j)) throw new Error("not an object");
        body = j as Record<string, unknown>;
      } catch {
        return c.json({ error: "request body cannot be read" }, 400);
      }
      const own = OWN_ENTRY[c.req.path] ?? [];
      for (const k of BODY_KEYS) for (const v of arr(body[k])) paths.push({ p: v || "/", own: own.includes(k) });
      const d = BODY_DEFAULTS[c.req.path];
      if (d && (body[d] === undefined || body[d] === "")) paths.push({ p: "/", own: false });
    }
    for (const { p, own } of paths) if (!insideGrants(root, grants, p, own)) return deny();
    return next();
  };
}
