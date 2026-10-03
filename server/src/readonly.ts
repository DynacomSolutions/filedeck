import type { MiddlewareHandler } from "hono";
import { PathError, resolveInRoot } from "./paths.ts";

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

export function readOnlyGuard(root: string, prefixes: string[]): MiddlewareHandler {
  return async (c, next) => {
    if (prefixes.length === 0 || ["GET", "HEAD", "OPTIONS"].includes(c.req.method)) return next();
    let body: Record<string, unknown> = {};
    if ((c.req.header("content-type") ?? "").includes("json")) {
      try {
        const j = await c.req.raw.clone().json();
        if (j && typeof j === "object") body = j as Record<string, unknown>;
      } catch {
        /* the route reports the bad body itself */
      }
    }
    for (const t of writeTargets(c.req.method, c.req.path, (k) => c.req.query(k), body)) {
      let hit = false;
      try {
        // both the link itself and where it leads count
        const own = resolveInRoot(root, t, { followFinal: false }).virtual;
        const far = resolveInRoot(root, t, { followFinal: true }).virtual;
        hit = prefixes.some((p) => under(own, p) || under(far, p));
      } catch (e) {
        if (!(e instanceof PathError)) throw e; // a bad path is the route's 400
      }
      if (hit) return c.json({ error: "read-only volume" }, 403);
    }
    return next();
  };
}

export function isReadOnly(prefixes: string[], mountpoint: string): boolean {
  return prefixes.some((p) => under(mountpoint, p));
}
