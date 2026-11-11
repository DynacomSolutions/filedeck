import { constants as C } from "node:fs";
import fs, { type FileHandle } from "node:fs/promises";
import path from "node:path";
import { namesOf } from "./dirnames.ts";
import { PathError, openChecked } from "./paths.ts";

/**
 * Walks that hold a descriptor for every folder they enter. The path handed to the next step names the folder through
 * that descriptor, so a folder swapped for a link (or for another folder) after it was listed is never entered: each
 * child is opened with O_NOFOLLOW and must be the very entry that was listed (same device and inode).
 * The callers pin the starting folder with `pinDir` / `pinParent` from paths.ts.
 */

const LINUX = process.platform === "linux";

/** Deepest folder nesting a pinned walk follows (one descriptor per level). */
export const MAX_DEPTH = 512;

const changed = () => new PathError(400, "a folder changed while it was being processed");
const tooDeep = () => new PathError(400, "folder nesting too deep");

/** The path that names the open folder `fh` (`real` where descriptors cannot be named). */
export const dirAt = (fh: FileHandle, real: string): string => (LINUX ? `/proc/self/fd/${fh.fd}` : real);

/** Open the folder at `p` without following a link, and prove it is the entry that was listed. */
export async function openListedDir(p: string, listed: { dev: number; ino: number }): Promise<FileHandle> {
  const fh = await fs.open(p, C.O_RDONLY | C.O_NOFOLLOW | C.O_DIRECTORY);
  try {
    const s = await fh.stat();
    if (s.dev !== listed.dev || s.ino !== listed.ino) throw changed();
    return fh;
  } catch (e) {
    await fh.close().catch(() => undefined);
    throw e;
  }
}

/**
 * `pinDir` that creates the missing folders on the way, one component at a time through the folder above, never
 * following a link. `real` must be inside `root`.
 */
export async function pinDirCreate<T>(root: string, real: string, fn: (at: string) => Promise<T>): Promise<T> {
  if (!LINUX) {
    await fs.mkdir(real, { recursive: true });
    return fn(real);
  }
  const rel = root === "/" ? real : path.relative(root, real);
  if (rel === ".." || rel.startsWith("../")) throw new PathError(403, "path escapes root");
  let cur = await fs.open(root, C.O_RDONLY | C.O_DIRECTORY);
  try {
    for (const comp of rel.split("/").filter(Boolean)) {
      const p = `/proc/self/fd/${cur.fd}/${comp}`;
      await fs.mkdir(p).catch((e: NodeJS.ErrnoException) => {
        if (e.code !== "EEXIST") throw e;
      });
      const next = await openChecked(root, p, C.O_RDONLY | C.O_DIRECTORY);
      await cur.close().catch(() => undefined);
      cur = next;
    }
    return await fn(`/proc/self/fd/${cur.fd}`);
  } finally {
    await cur.close().catch(() => undefined);
  }
}

export interface CopyTreeOpts {
  /** give every entry the modification time of its source */
  times?: boolean;
  /** give every entry the owner and group of its source (needs privilege; refused changes are ignored) */
  owner?: boolean;
}

/**
 * Copy the entry at `src` to the new name `dst` (which must not exist). Both paths must have a pinned parent. Folders are
 * entered through descriptors, files are copied from the descriptor that was checked, links are copied as links.
 */
export async function copyTree(src: string, dst: string, o: CopyTreeOpts = {}, depth = 0): Promise<void> {
  if (depth > MAX_DEPTH) throw tooDeep();
  const st = await fs.lstat(src);
  if (st.isSymbolicLink()) {
    await fs.symlink(await fs.readlink(src), dst);
  } else if (st.isDirectory()) {
    const sfh = await openListedDir(src, st);
    try {
      await fs.mkdir(dst, { mode: 0o700 }); // opened up to the source's mode once it is filled
      const dfh = await fs.open(dst, C.O_RDONLY | C.O_NOFOLLOW | C.O_DIRECTORY);
      try {
        const [s, d] = [dirAt(sfh, src), dirAt(dfh, dst)];
        for await (const names of namesOf(s, 256)) for (const n of names) await copyTree(path.join(s, n), path.join(d, n), o, depth + 1);
        if (o.owner) await fs.lchown(dst, st.uid, st.gid).catch(() => undefined);
        await dfh.chmod(st.mode & 0o7777);
      } finally {
        await dfh.close().catch(() => undefined);
      }
    } finally {
      await sfh.close().catch(() => undefined);
    }
    if (o.times) await fs.lutimes(dst, st.atime, st.mtime).catch(() => undefined);
    return;
  } else if (st.isFile()) {
    const fh = await fs.open(src, C.O_RDONLY | C.O_NOFOLLOW | C.O_NONBLOCK);
    try {
      const s = await fh.stat();
      if (!s.isFile() || s.dev !== st.dev || s.ino !== st.ino) throw changed();
      await fs.copyFile(LINUX ? `/proc/self/fd/${fh.fd}` : src, dst, C.COPYFILE_EXCL);
    } finally {
      await fh.close().catch(() => undefined);
    }
  } else {
    throw new PathError(400, "cannot copy a special file");
  }
  if (o.owner) await fs.lchown(dst, st.uid, st.gid).catch(() => undefined);
  if (o.times) await fs.lutimes(dst, st.atime, st.mtime).catch(() => undefined);
}

/** Remove the entry at `p` (parent pinned) and everything below it, entering folders through descriptors; links are removed, never followed. */
export async function rmTree(p: string, o: { force?: boolean } = {}, depth = 0): Promise<void> {
  if (depth > MAX_DEPTH) throw tooDeep();
  try {
    const st = await fs.lstat(p);
    if (!st.isDirectory()) return await fs.unlink(p);
    const fh = await openListedDir(p, st);
    try {
      const d = dirAt(fh, p);
      for await (const names of namesOf(d, 256)) for (const n of names) await rmTree(path.join(d, n), { force: true }, depth + 1);
    } finally {
      await fh.close().catch(() => undefined);
    }
    await fs.rmdir(p);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT" && o.force) return;
    throw e;
  }
}
