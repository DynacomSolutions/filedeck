import type { MiddlewareHandler } from "hono";
import { PathError, resolveInRoot } from "./paths.ts";
import path from "node:path";
import { archiveBase } from "./archive.ts";
import { MAX_JSON_BODY, isRawRoute } from "./request-guard.ts";

/**
 * Read-only volumes: virtual path prefixes (FILEDECK_READONLY, comma separated)
 * under which this agent refuses every change. The check runs on the write
 * targets of each mutating route, after resolving them chroot-style, so a
 * symlink into a read-only volume does not get around it. Sources of a copy,
 * archive or size job are reads and stay allowed.
 */
export function parseReadOnly(s: string | undefined): string[] {
  return (s ?? "")
    .split(",")
    .map((x) => x.trim())
    .filter((x) => x.startsWith("/"))
    .map((x) => x.replace(/\/+$/, "") || "/");
}

const under = (v: string, prefix: string) => prefix === "/" || v === prefix || v.startsWith(prefix + "/");

const arr = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : typeof v === "string" ? [v] : []);

/** The paths a mutating request would change (empty for reads and for unknown routes). */
export function writeTargets(method: string, route: string, query: (k: string) => string | undefined, body: Record<string, unknown>): string[] {
  const q = (k: string) => arr(query(k));
  const b = (k: string) => arr(body[k]);
  if (method === "PUT" && route === "/api/fs/write") return q("path");
  if (method === "PUT" && route === "/api/fs/upload") return q("dir");
  if (method === "PATCH" && route === "/api/upload/chunk") return q("dir");
  if (method === "DELETE" && route === "/api/upload") return q("dir");
  if (method !== "POST") return [];
  switch (route) {
    case "/api/fs/mkdir":
    case "/api/fs/symlink":
    case "/api/fs/perms":
      return b("path");
    case "/api/fs/rename":
      return [...b("from"), ...b("to")];
    case "/api/fs/move":
      return [...b("from"), ...b("toDir")];
    case "/api/fs/copy":
      return b("toDir");
    case "/api/fs/trash":
    case "/api/fs/delete":
      return b("paths");
    case "/api/trash/restore":
      return [...b("volume"), ...b("toDir")];
    case "/api/trash/delete":
    case "/api/trash/empty":
      return b("volume");
    case "/api/jobs/compress":
      return [...b("dir"), ...b("destDir")];
    case "/api/jobs/extract":
      return b("destDir");
  }
  return [];
}

/** Whether changing `target` would touch a read-only volume (a bad path is the caller's own 400). */
export function hitsReadOnly(root: string, prefixes: string[], target: string): boolean {
  try {
    // both the link itself and where it leads count
    const own = resolveInRoot(root, target, { followFinal: false }).virtual;
    const far = resolveInRoot(root, target, { followFinal: true }).virtual;
    return prefixes.some((p) => under(own, p) || under(far, p));
  } catch (e) {
    if (!(e instanceof PathError)) throw e;
    return false;
  }
}

/** The paths a request would remove, move away or change recursively: an ancestor of a read-only prefix must not be among them. */
export function removalTargets(method: string, route: string, body: Record<string, unknown>): { paths: string[]; followFinal: boolean } {
  if (method !== "POST") return { paths: [], followFinal: false };
  const b = (k: string) => arr(body[k]);
  switch (route) {
    case "/api/fs/delete":
    case "/api/fs/trash":
      return { paths: b("paths"), followFinal: false };
    case "/api/fs/rename":
      return { paths: [...b("from"), ...(body.overwrite === true ? b("to") : [])], followFinal: false };
    case "/api/fs/move":
      return { paths: b("from"), followFinal: false };
    case "/api/fs/perms":
      return { paths: body.recursive === true ? b("path") : [], followFinal: true }; // a link is followed by the change
  }
  return { paths: [], followFinal: false };
}

/**
 * Destinations a copy, move or extract would merge into or replace, when the request names only the folder and the
 * items: `toDir/<name>` for a copy that overwrites and for a move, and for an extract that merges (policy overwrite or
 * skip) the folder itself, or the folder named after the archive. Keep-both copies and extracts always pick a free name.
 * Refused when such a destination is, or contains, a read-only prefix. (The hub's job queue reaches the same routes:
 * its per-file uploads and folder creation are checked on their own folder, its removals by `removalTargets`.)
 */
export function mergeTargets(method: string, route: string, body: Record<string, unknown>): string[] {
  if (method !== "POST") return [];
  const dirs = (k: string) => arr(body[k]).map((p) => path.posix.basename(p.replace(/\/+$/, "")));
  const into = (toDir: string, names: string[]) => names.filter(Boolean).map((n) => `${toDir.replace(/\/+$/, "")}/${n}`);
  const toDir = typeof body.toDir === "string" ? body.toDir : undefined;
  switch (route) {
    case "/api/fs/copy":
      return toDir !== undefined && body.overwrite === true ? into(toDir, dirs("from")) : [];
    case "/api/fs/move":
      return toDir !== undefined ? into(toDir, dirs("from")) : [];
    case "/api/jobs/extract": {
      const policy = body.overwrite ?? "rename";
      if (policy === "rename" || typeof body.destDir !== "string") return [];
      return body.subfolder === false || typeof body.path !== "string" ? [body.destDir] : into(body.destDir, [archiveBase(path.posix.basename(body.path))]);
    }
  }
  return [];
}

/** Whether `target` is a read-only prefix itself, lies under one, or contains one (removing or recursing into it would reach it). */
export function reachesReadOnly(root: string, prefixes: string[], target: string, followFinal = false): boolean {
  if (hitsReadOnly(root, prefixes, target)) return true;
  try {
    const v = resolveInRoot(root, target, { followFinal }).virtual;
    const vs = followFinal ? [v, resolveInRoot(root, target, { followFinal: false }).virtual] : [v];
    return prefixes.some((p) => vs.some((x) => under(p, x)));
  } catch (e) {
    if (!(e instanceof PathError)) throw e;
    return false;
  }
}

/** POST routes whose paths come from the JSON body (see writeTargets). */
const BODY_ROUTES = new Set([
  "/api/fs/mkdir", "/api/fs/symlink", "/api/fs/perms", "/api/fs/rename", "/api/fs/move", "/api/fs/copy", "/api/fs/trash", "/api/fs/delete",
  "/api/trash/restore", "/api/trash/delete", "/api/trash/empty", "/api/jobs/compress", "/api/jobs/extract",
]);

export function readOnlyGuard(root: string, prefixes: string[]): MiddlewareHandler {
  return async (c, next) => {
    if (prefixes.length === 0 || ["GET", "HEAD", "OPTIONS"].includes(c.req.method)) return next();
    let body: Record<string, unknown> = {};
    // The body is read whatever its content type. On a route that takes its paths from the body, a body that cannot be
    // read (too large for the guard's own limit, not JSON) is refused: the guard never passes what it could not check.
    if (!isRawRoute(c.req.method, c.req.path) && c.req.method === "POST" && BODY_ROUTES.has(c.req.path)) {
      if (Number(c.req.header("content-length") ?? "0") > MAX_JSON_BODY) return c.json({ error: "request body too large" }, 413);
      try {
        const j = await c.req.raw.clone().json();
        if (!j || typeof j !== "object" || Array.isArray(j)) throw new Error("not an object");
        body = j as Record<string, unknown>;
      } catch {
        return c.json({ error: "request body cannot be read" }, 400);
      }
    }
    if (writeTargets(c.req.method, c.req.path, (k) => c.req.query(k), body).some((t) => hitsReadOnly(root, prefixes, t))) return c.json({ error: "read-only volume" }, 403);
    const rm = removalTargets(c.req.method, c.req.path, body);
    if (rm.paths.some((t) => reachesReadOnly(root, prefixes, t, rm.followFinal))) return c.json({ error: "read-only volume" }, 403);
    if (mergeTargets(c.req.method, c.req.path, body).some((t) => reachesReadOnly(root, prefixes, t))) return c.json({ error: "read-only volume" }, 403);
    return next();
  };
}

export function isReadOnly(prefixes: string[], mountpoint: string): boolean {
  return prefixes.some((p) => under(mountpoint, p));
}
