import { lstatSync, readlinkSync } from "node:fs";
import path from "node:path";

/**
 * Path confinement. Every client path is a *virtual* absolute path ("/etc/hosts")
 * that maps to `<root>/etc/hosts`. Resolution is chroot-style and done by hand,
 * component by component, so a symlink can never lead outside the root:
 *
 *  - a literal ".." segment in the client path is rejected (400), never clamped
 *  - an absolute symlink target is re-based onto the root (on a host mounted at
 *    /host, "/etc/mtab -> /proc/self/mounts" must mean the HOST's /proc)
 *  - a relative symlink whose ".." would climb above the root is clamped at the
 *    root for reads, and rejected for writes (`escaped` is set)
 *  - the final component is only followed when `followFinal` is set; mutating
 *    operations act on the link itself
 *
 * A TOCTOU race between resolution and use remains possible for an attacker who
 * can already create symlinks on the volume; see HISTORY.md (T-symlinks).
 */
export class PathError extends Error {
  constructor(
    public status: 400 | 403 | 404,
    message: string,
  ) {
    super(message);
  }
}

export interface Resolved {
  /** Canonical virtual path ("/" rooted, no symlinks in intermediate parts) */
  virtual: string;
  /** Absolute path inside the root on the real filesystem */
  real: string;
  /** True if a symlink's ".." tried to climb above the root and was clamped */
  escaped: boolean;
}

const MAX_LINKS = 40;

export function cleanVirtual(input: string): string[] {
  if (typeof input !== "string" || input.includes("\0")) throw new PathError(400, "invalid path");
  if (input.length > 4096) throw new PathError(400, "path too long");
  const parts: string[] = [];
  for (const seg of input.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") throw new PathError(400, "'..' segments are not allowed");
    parts.push(seg);
  }
  return parts;
}

export function resolveInRoot(
  root: string,
  input: string,
  opts: { followFinal?: boolean } = {},
): Resolved {
  const pending = cleanVirtual(input).reverse(); // pop() = next segment
  const stack: string[] = [];
  let links = 0;
  let escaped = false;
  while (pending.length) {
    const seg = pending.pop() as string;
    if (seg === "." || seg === "") continue;
    if (seg === "..") {
      if (stack.length === 0) escaped = true;
      else stack.pop();
      continue;
    }
    const candidate = path.join(root, ...stack, seg);
    let isLink = false;
    try {
      isLink = lstatSync(candidate).isSymbolicLink();
    } catch {
      isLink = false; // missing component: remaining segments just append
    }
    if (isLink && (pending.length > 0 || opts.followFinal)) {
      if (++links > MAX_LINKS) throw new PathError(400, "too many symbolic links");
      const target = readlinkSync(candidate);
      if (target.includes("\0")) throw new PathError(400, "invalid link");
      if (path.isAbsolute(target)) stack.length = 0;
      const segs = target.split("/").filter((s) => s !== "" && s !== ".");
      for (let i = segs.length - 1; i >= 0; i--) pending.push(segs[i] as string);
    } else {
      stack.push(seg);
    }
  }
  const real = path.join(root, ...stack);
  // Belt and braces: the construction above cannot leave root, assert it.
  if (real !== root && !real.startsWith(root === "/" ? "/" : root + path.sep)) {
    throw new PathError(403, "path escapes root");
  }
  return { virtual: "/" + stack.join("/"), real, escaped };
}

/** Resolve for reading: symlinks are followed, clamped at the root. */
export function resolveRead(root: string, input: string): Resolved {
  return resolveInRoot(root, input, { followFinal: true });
}

/**
 * Resolve for mutation: the final component is NOT followed, and any escape via
 * a symlink's ".." is refused.
 */
export function resolveWrite(root: string, input: string): Resolved {
  const r = resolveInRoot(root, input, { followFinal: false });
  if (r.escaped) throw new PathError(403, "symlink escapes root");
  return r;
}

export function virtualJoin(dir: string, name: string): string {
  if (!name || name === "." || name === ".." || name.includes("/") || name.includes("\0")) {
    throw new PathError(400, "invalid name");
  }
  return (dir === "/" ? "" : dir) + "/" + name;
}

export const TRASH_DIR = ".filedeck-trash";

/** Mutations may never target the trash store directly (use the trash API). */
export function assertNotTrash(virtual: string): void {
  if (virtual.split("/").includes(TRASH_DIR)) throw new PathError(403, "trash is managed via the trash API");
}
