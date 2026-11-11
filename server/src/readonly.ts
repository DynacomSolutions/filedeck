import type { MiddlewareHandler } from "hono";
import { lstatSync, realpathSync } from "node:fs";
import path from "node:path";
import { PathError, resolveInRoot } from "./paths.ts";
import { MAX_JSON_BODY, isRawRoute } from "./request-guard.ts";

/**
 * Read-only volumes: virtual path prefixes (FILEDECK_READONLY, comma separated)
 * under which this agent refuses every change. The check runs on the write
 * targets of each mutating route, after resolving them chroot-style, so a
 * symlink into a read-only volume does not get around it. Sources of a copy,
 * archive or size job are reads and stay allowed.
 */
export function parseReadOnly(s: string | undefined): string[] {
  const out: string[] = [];
  for (const raw of (s ?? "").split(",")) {
    const x = raw.trim();
    if (!x) continue;
    // `//`, `/./` and a trailing slash are cleaned; `..` is resolved; anything that is not an absolute path is refused
    // (an entry that silently protected nothing would be worse than a refusal to start).
    const parts: string[] = [];
    let ok = x.startsWith("/") && !x.includes("\0");
    for (const seg of ok ? x.split("/") : []) {
      if (seg === "" || seg === ".") continue;
      if (seg === "..") {
        if (parts.length === 0) ok = false;
        else parts.pop();
        continue;
      }
      parts.push(seg);
    }
    if (!ok) throw new Error(`FILEDECK_READONLY: "${x}" is not an absolute path inside the root (use entries such as /mnt/backup)`);
    out.push("/" + parts.join("/"));
  }
  return out;
}

const under = (v: string, prefix: string) => prefix === "/" || v === prefix || v.startsWith(prefix + "/");

/**
 * A read-only prefix as it is matched: the form written in the configuration and, when the prefix is or crosses a
 * symbolic link, the place it resolves to (both are checked); `fold` when that place is on a case-insensitive
 * filesystem (vfat, exFAT, some network shares), where the same file can be named in another case.
 */
export interface Form {
  p: string;
  fold: boolean;
}

const lower = (v: string) => v.toLowerCase();
const underF = (v: string, f: Form) => (f.fold ? under(lower(v), lower(f.p)) : under(v, f.p));

/** Whether the filesystem holding `real` answers to a name in another case (probed with the last name that has letters). */
function caseInsensitiveAt(real: string): boolean {
  try {
    const dir = path.dirname(real);
    const base = path.basename(real);
    const flipped = base === base.toUpperCase() ? base.toLowerCase() : base.toUpperCase();
    if (flipped === base) return false; // no letters to flip: cannot tell, treated as case-sensitive
    const a = lstatSync(real);
    const b = lstatSync(path.join(dir, flipped));
    return a.ino === b.ino && a.dev === b.dev;
  } catch {
    return false;
  }
}

/** The forms of the prefixes, resolved now (a link retargeted since the last request is followed to its new place). */
export function readOnlyForms(root: string, prefixes: string[]): Form[] {
  const out: Form[] = [];
  for (const p of prefixes) {
    let resolved: { virtual: string; real: string } | undefined;
    try {
      resolved = resolveInRoot(root, p, { followFinal: true });
    } catch (e) {
      if (!(e instanceof PathError)) throw e;
    }
    const fold = resolved ? caseInsensitiveAt(resolved.real) : false;
    out.push({ p, fold });
    if (resolved && resolved.virtual !== p) out.push({ p: resolved.virtual, fold });
  }
  return out;
}

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
export function hitsReadOnly(root: string, prefixes: string[], target: string, forms: Form[] = readOnlyForms(root, prefixes)): boolean {
  try {
    // both the link itself and where it leads count
    const own = resolveInRoot(root, target, { followFinal: false }).virtual;
    const far = resolveInRoot(root, target, { followFinal: true }).virtual;
    return forms.some((f) => underF(own, f) || underF(far, f));
  } catch (e) {
    if (!(e instanceof PathError)) throw e;
    return false;
  }
}

/** The paths a request would remove, move away or change recursively: an ancestor of a read-only prefix must not be among them. */
export function removalTargets(method: string, route: string, body: Record<string, unknown>, query: (k: string) => string | undefined = () => undefined): { paths: string[]; followFinal: boolean } {
  // an upload that replaces a file of the same name: the file is the target (a read-only file in an otherwise writable folder)
  if ((method === "PUT" && route === "/api/fs/upload") || (method === "PATCH" && route === "/api/upload/chunk")) {
    const dir = query("dir"), name = query("name");
    return { paths: query("overwrite") === "1" && dir !== undefined && name ? [`${dir.replace(/\/+$/, "")}/${name}`] : [], followFinal: false };
  }
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
    case "/api/fs/symlink":
      return { paths: body.overwrite === true ? b("path") : [], followFinal: false }; // replaces what is at `path`: a link or folder on the way to a prefix
    case "/api/fs/perms":
      return { paths: body.recursive === true ? b("path") : [], followFinal: true }; // a link is followed by the change
  }
  return { paths: [], followFinal: false };
}

/**
 * Destinations a copy or move would merge into or replace, when the request names only the folder and the
 * items: `toDir/<name>` for a copy that overwrites and for a move. Keep-both copies always pick a free name. (An
 * extract is judged where its plan is known: see `extractBlocked`.)
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
  }
  return [];
}

/** Whether `target` is a read-only prefix itself, lies under one, or contains one (removing or recursing into it would reach it). */
export function reachesReadOnly(root: string, prefixes: string[], target: string, followFinal = false, forms: Form[] = readOnlyForms(root, prefixes)): boolean {
  if (hitsReadOnly(root, prefixes, target, forms)) return true;
  try {
    const v = resolveInRoot(root, target, { followFinal }).virtual;
    const vs = followFinal ? [v, resolveInRoot(root, target, { followFinal: false }).virtual] : [v];
    return forms.some((f) => vs.some((x) => underF(f.p, { p: x, fold: f.fold })));
  } catch (e) {
    if (!(e instanceof PathError)) throw e;
    return false;
  }
}

/**
 * Whether a job that was accepted earlier may write at `real` now that it starts. The location is resolved again at
 * this moment (a folder swapped for a link after the request was checked is followed to where it leads), and refused
 * when it lies under a read-only prefix, or, with `contains`, holds one (a merge or recursive change would reach it).
 * `follow: false` keeps the last name as it is (a single entry is changed through a descriptor opened without following a link). A location that
 * is outside the root or cannot be resolved is refused, except when it does not exist (the job fails on its own then).
 * This is the function an operation calls on the location it has pinned.
 */
export function jobMayWrite(root: string, prefixes: string[], real: string, opts: { contains: boolean; follow?: boolean }): boolean {
  if (prefixes.length === 0) return true;
  let at: string;
  let rootReal: string;
  try {
    rootReal = realpathSync(root);
    at = opts.follow === false ? path.join(realpathSync(path.dirname(real)), path.basename(real)) : realpathSync(real);
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "ENOENT";
  }
  const rel = path.relative(rootReal, at);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return false;
  const virtual = "/" + rel.split(path.sep).filter(Boolean).join("/");
  const forms = readOnlyForms(root, prefixes);
  return !forms.some((f) => underF(virtual, f) || (opts.contains && underF(f.p, { p: virtual, fold: f.fold })));
}

/**
 * Whether an extract with this plan would merge into or replace anything of a read-only volume. `destVirtual` is the
 * resolved destination folder (a link to it has been followed) and `archiveName` the name of the archive file itself
 * (not of a link to it), which names the subfolder. Policy `rename` (keep both) always picks free names.
 */
export function extractBlocked(root: string, prefixes: string[], plan: { destVirtual: string; archiveName: string; subfolder: boolean; overwrite: string }, base: (archiveName: string) => string): boolean {
  if (plan.overwrite === "rename" || prefixes.length === 0) return false;
  const target = plan.subfolder ? `${plan.destVirtual.replace(/\/+$/, "")}/${base(plan.archiveName)}` : plan.destVirtual;
  return reachesReadOnly(root, prefixes, target, true);
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
    const forms = readOnlyForms(root, prefixes); // resolved once per request, at the time of the request
    if (writeTargets(c.req.method, c.req.path, (k) => c.req.query(k), body).some((t) => hitsReadOnly(root, prefixes, t, forms))) return c.json({ error: "read-only volume" }, 403);
    const rm = removalTargets(c.req.method, c.req.path, body, (k) => c.req.query(k));
    if (rm.paths.some((t) => reachesReadOnly(root, prefixes, t, rm.followFinal, forms))) return c.json({ error: "read-only volume" }, 403);
    if (mergeTargets(c.req.method, c.req.path, body).some((t) => reachesReadOnly(root, prefixes, t, false, forms))) return c.json({ error: "read-only volume" }, 403);
    return next();
  };
}

export function isReadOnly(prefixes: string[], mountpoint: string): boolean {
  return prefixes.some((p) => under(mountpoint, p));
}
