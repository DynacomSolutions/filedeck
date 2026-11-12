import { constants as C, type Dirent } from "node:fs";
import fs, { type FileHandle } from "node:fs/promises";
import path from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { direntsOf } from "./dirnames.ts";
import { PathError, TRASH_DIR, assertNotTrash, openChecked, pinDir } from "./paths.ts";
import { jobMayWrite } from "./readonly.ts";

/**
 * Walks that hold a descriptor for every folder they enter. The path handed to the next step names the folder through
 * that descriptor, so a folder swapped for a link (or for another folder) after it was listed is never entered: each
 * child is opened with O_NOFOLLOW and must be of the kind that was listed.
 * The callers pin the starting folder with `pinDir` / `pinParent` from paths.ts (or the checked variants below).
 */

const LINUX = process.platform === "linux";

/**
 * Deepest folder nesting a pinned walk follows. Each level holds one descriptor (at most 4096 at a time); a path of that
 * depth is already longer than the 4096 bytes most tools accept, so real trees stay far below it. Running out of
 * descriptors earlier is reported as "nested too deeply", never as an internal error.
 */
export const MAX_DEPTH = 4096;

export const tooDeep = () => new PathError(400, "folders nested too deeply to process");

/** The path that names the open folder `fh` (`real` where descriptors cannot be named). */
export const dirAt = (fh: FileHandle, real: string): string => (LINUX ? `/proc/self/fd/${fh.fd}` : real);

/** `fs.open` where running out of descriptors (very deep trees hold one or two per level) is the same clear error everywhere. */
export async function openFd(p: string, flags: number, mode?: number): Promise<FileHandle> {
  try {
    return await fs.open(p, flags, mode);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "EMFILE" || code === "ENFILE") throw tooDeep();
    throw e;
  }
}

/** A folder opened without following a link. */
export const openDir = (p: string): Promise<FileHandle> => openFd(p, C.O_RDONLY | C.O_NOFOLLOW | C.O_DIRECTORY);

/** Open the folder at `p` without following a link, and prove it is the entry that was listed. */
export async function openListedDir(p: string, listed: { dev: number; ino: number }): Promise<FileHandle> {
  const fh = await openDir(p);
  try {
    const s = await fh.stat();
    if (s.dev !== listed.dev || s.ino !== listed.ino) throw new PathError(400, "a folder changed while it was being processed");
    return fh;
  } catch (e) {
    await fh.close().catch(() => undefined);
    throw e;
  }
}

/* ---- read-only prefixes, checked on where a descriptor really points ---- */

/**
 * The read-only prefixes of the agent that is serving the request. The agent opens this scope around every request, so
 * two agents on one root (as in tests) never see each other's prefixes, and a helper called outside any request sees none.
 */
const SCOPE = new AsyncLocalStorage<{ root: string | null; prefixes: string[] }>();

/** Run `fn` (and everything it awaits) with `prefixes` (FILEDECK_READONLY) as the read-only prefixes of `root`. */
export const withReadOnly = <T>(root: string, prefixes: string[], fn: () => T): T => SCOPE.run({ root, prefixes }, fn);

/** Run `fn` for a caller that has no read-only prefixes at all (tests, tools): an explicit, empty scope for any root. */
export const withoutReadOnly = <T>(fn: () => T): T => SCOPE.run({ root: null, prefixes: [] }, fn);

/** The prefixes in force, or none. Without a scope for this root the answer is unknown, and unknown is refused: a caller that forgets the scope fails closed. */
const readOnlyOf = (root: string): string[] | undefined => {
  const sc = SCOPE.getStore();
  if (!sc || (sc.root !== null && sc.root !== root)) throw new PathError(403, "read-only state unknown: the operation was not run in a read-only scope");
  return sc.prefixes.length ? sc.prefixes : undefined;
};

/**
 * Refuse before anything is changed: `real` (a resolved location) lies in a read-only prefix, or with `contains` holds one.
 * The rule itself is `jobMayWrite` in readonly.ts; this only adds the error.
 */
export function assertMayChange(root: string, real: string, contains: boolean): void {
  const prefixes = readOnlyOf(root);
  if (prefixes && !jobMayWrite(root, prefixes, real, { contains, follow: true })) throw new PathError(403, "read-only volume");
}

/**
 * Refuse when the folder `at` (a `/proc/self/fd` path), or its entry `name`, lies in a read-only prefix (or holds one, with `contains`).
 * Looks at the location the descriptor resolves to now, after any link in an ancestor was followed; an entry is judged by its own name.
 */
export async function assertWritableAt(root: string, at: string, name?: string, contains = false): Promise<void> {
  const prefixes = readOnlyOf(root);
  if (!prefixes || !LINUX) return;
  const ok = name === undefined ? jobMayWrite(root, prefixes, at, { contains, follow: true }) : jobMayWrite(root, prefixes, path.join(at, name), { contains, follow: false });
  if (!ok) throw new PathError(403, "read-only volume");
}

/** `pinDir` for a folder that is about to be changed: refused when it resolves into a read-only prefix. */
export function pinDirW<T>(root: string, real: string, fn: (at: string) => Promise<T>): Promise<T> {
  return pinDir(root, real, async (at) => {
    await assertWritableAt(root, at);
    return fn(at);
  });
}

/** `pinParent` for an entry that is about to be changed: the entry itself must not lie in a read-only prefix, nor (unless `contains` is false) hold one. */
export function pinParentW<T>(root: string, real: string, fn: (at: string) => Promise<T>, contains = true): Promise<T> {
  const name = path.basename(real);
  return pinDir(root, path.dirname(real), async (dir) => {
    await assertWritableAt(root, dir, name, contains);
    return fn(path.join(dir, name));
  });
}

/** Check for each folder a recursive walk enters (the `at` path of its descriptor). */
export const walkGuard = (root: string) => (at: string) => assertWritableAt(root, at, undefined, true);

/**
 * `pinDir` that creates the missing folders on the way, one component at a time through the folder above, never
 * following a link. `real` must be inside `root`. The folder it ends in must not be read-only.
 */
export async function pinDirCreate<T>(root: string, real: string, fn: (at: string) => Promise<T>): Promise<T> {
  if (!LINUX) {
    await fs.mkdir(real, { recursive: true });
    return fn(real);
  }
  const rel = root === "/" ? real : path.relative(root, real);
  if (rel === ".." || rel.startsWith("../")) throw new PathError(403, "path escapes root");
  let cur = await openFd(root, C.O_RDONLY | C.O_DIRECTORY);
  try {
    for (const comp of rel.split("/").filter(Boolean)) {
      const p = `/proc/self/fd/${cur.fd}/${comp}`;
      await assertWritableAt(root, `/proc/self/fd/${cur.fd}`, comp); // never create a folder inside a read-only prefix
      await fs.mkdir(p).catch((e: NodeJS.ErrnoException) => {
        if (e.code !== "EEXIST") throw e;
      });
      const next = await openChecked(root, p, C.O_RDONLY | C.O_DIRECTORY);
      await cur.close().catch(() => undefined);
      cur = next;
    }
    await assertWritableAt(root, `/proc/self/fd/${cur.fd}`);
    return await fn(`/proc/self/fd/${cur.fd}`);
  } finally {
    await cur.close().catch(() => undefined);
  }
}

/* ---- reserved names ---- */

/** Prefix of the private staging folders made for copies. */
export const STAGING_PREFIX = ".filedeck-work-";
/** Name reserved for a per-volume private work folder. */
const WORK_DIR = ".filedeck-work";

/** Names of the agent's own working folders: never listed, copied, searched or used as a target (the trash store has its own check in paths.ts). */
export const isReservedName = (name: string): boolean => name === WORK_DIR || name.startsWith(STAGING_PREFIX);

/** `assertNotTrash` plus the working folders: no path may go through one. */
export function assertNotReserved(virtual: string): void {
  assertNotTrash(virtual);
  if (virtual.split("/").some(isReservedName)) throw new PathError(403, "this name is reserved for the file manager's own use");
}

/* ---- a private staging folder for building a copy ---- */

/** Random for this run of the process, never derived from the process id: a folder carrying it was made by this run. */
const RUN = randomBytes(6).toString("hex");
const ACTIVE = new Set<string>();
const SWEPT = new Map<string, number>(); // folder -> when it was last swept
const SWEEP_EVERY_MS = 3600 * 1000;
const IDLE_MS = 24 * 3600 * 1000;
const TOUCH_MS = 5 * 60 * 1000;

/**
 * Remove staging folders a crash left in the folder `parentAt`, when a copy uses the folder (at most once an hour per folder). Only a folder that is ours (owner,
 * private mode), holds nothing but the entry `staged`, and either carries this run's id (and is not in use) or has not changed
 * for a day is removed, whichever run (or process) made it: nothing else is ever emptied, whatever its name.
 */
async function sweep(parentAt: string): Promise<void> {
  let loc = parentAt;
  if (LINUX) loc = await fs.readlink(parentAt).catch(() => "");
  if (!loc || Date.now() - (SWEPT.get(loc) ?? 0) < SWEEP_EVERY_MS) return;
  if (SWEPT.size > 1000) SWEPT.clear();
  SWEPT.set(loc, Date.now());
  const uid = process.getuid?.();
  try {
    for await (const e of direntsOf(parentAt)) {
      if (!e.name.startsWith(STAGING_PREFIX) || ACTIVE.has(e.name) || !e.isDirectory()) continue;
      const p = path.join(parentAt, e.name);
      try {
        const fh = await openDir(p);
        try {
          const st = await fh.stat();
          if ((uid !== undefined && st.uid !== uid) || (st.mode & 0o077) !== 0) continue;
          const inner = await fs.readdir(dirAt(fh, p));
          if (inner.some((n) => n !== "staged")) continue;
          const staged = inner.length ? await fs.lstat(path.join(dirAt(fh, p), "staged")).catch(() => null) : null;
          const last = Math.max(st.mtimeMs, staged?.mtimeMs ?? 0);
          if (!e.name.startsWith(STAGING_PREFIX + RUN + "-") && Date.now() - last < IDLE_MS) continue;
          if (staged) await rmTree(path.join(dirAt(fh, p), "staged"), { force: true });
        } finally {
          await fh.close().catch(() => undefined);
        }
        await fs.rmdir(p);
      } catch {
        /* not ours to remove, or already gone */
      }
    }
  } catch {
    /* the folder could not be listed */
  }
}

/**
 * Build things in a private folder (`.filedeck-work-<run id>-<id>`, mode 0700, owned by this process) created inside the folder
 * `parentAt` (a pinned path), so the finished entry can be moved into place with one rename on the same filesystem. The folder
 * is opened at once, without following links, and used only if it is an empty folder of ours (a folder somebody renamed
 * onto the name would hold files): whoever may write to `parentAt` can neither enter it nor swap
 * it for something else. Afterwards only the entry that was built is removed, then the folder itself, which fails and is left
 * alone if anything else is in it. Inside it the entry to build is named `staged` (see `stagedEntry`).
 */
export async function withStaging<T>(parentAt: string, fn: (stage: string) => Promise<T>): Promise<T> {
  await sweep(parentAt);
  const name = `${STAGING_PREFIX}${RUN}-${randomUUID().slice(0, 12)}`;
  const p = path.join(parentAt, name);
  ACTIVE.add(name);
  await fs.mkdir(p, { mode: 0o700 }).catch((e) => {
    ACTIVE.delete(name);
    throw e;
  });
  let fh: FileHandle | undefined;
  let ours = false;
  let timer: NodeJS.Timeout | undefined;
  try {
    fh = await openDir(p);
    const s = await fh.stat();
    const uid = process.getuid?.();
    if ((uid !== undefined && s.uid !== uid) || (s.mode & 0o077) !== 0 || (await fs.readdir(dirAt(fh, p))).length > 0) {
      throw new PathError(403, "cannot make a private work folder here");
    }
    ours = true;
    // A running copy keeps its folder's times fresh, so another process never takes it for a leftover.
    const keep = fh;
    timer = setInterval(() => void keep.utimes(new Date(), new Date()).catch(() => undefined), TOUCH_MS);
    timer.unref();
    return await fn(dirAt(fh, p));
  } finally {
    if (timer) clearInterval(timer);
    if (fh && ours) await rmTree(stagedEntry(dirAt(fh, p)), { force: true }).catch(() => undefined);
    await fs.rmdir(p).catch(() => undefined); // not empty means it was never ours: left alone
    await fh?.close().catch(() => undefined);
    ACTIVE.delete(name);
  }
}

/** The entry built inside a staging folder. */
export const stagedEntry = (stage: string): string => path.join(stage, "staged");

/* ---- copy ---- */

export interface CopyTreeOpts {
  /** give every entry the modification time of its source */
  times?: boolean;
  /** give every entry the owner and group of its source (needs privilege; where it is refused the set-id bits are dropped) */
  owner?: boolean;
  /** receives the path of every working folder or trash store with content that the copy left out */
  skipped?: string[];
}

/**
 * Owner, then mode, then times, all through the descriptor of the new entry. The set-user-id and set-group-id bits are
 * kept only when the owner could be given to the entry as well: a file owned by someone else than the source's owner
 * never carries them. A folder keeps set-group-id either way.
 */
async function finish(h: FileHandle, st: { mode: number; uid: number; gid: number; atime: Date; mtime: Date }, o: CopyTreeOpts, dir = false): Promise<void> {
  let owned = false;
  if (o.owner) {
    try {
      await h.chown(st.uid, st.gid);
      owned = true;
    } catch {
      /* not allowed to give the entry away */
    }
  }
  // a folder keeps set-group-id (group inheritance of shared folders); a file never carries a set-id bit it was not given an owner for
  await h.chmod(owned ? st.mode & 0o7777 : st.mode & (dir ? 0o3777 : 0o1777));
  if (o.times) await h.utimes(st.atime, st.mtime).catch(() => undefined);
}

/**
 * Copy the entry at `src` to the new name `dst` (which must not exist) inside a staging folder. `src` must have a pinned
 * parent. Folders are entered through descriptors, files are copied from the descriptor that was checked into a file this
 * function created exclusively (0600) and finished through its own descriptor, links are copied as links.
 */
export async function copyTree(src: string, dst: string, o: CopyTreeOpts = {}, depth = 0): Promise<void> {
  if (depth > MAX_DEPTH) throw tooDeep();
  const st = await fs.lstat(src);
  if (st.isSymbolicLink()) {
    await fs.symlink(await fs.readlink(src), dst);
    if (o.owner) await fs.lchown(dst, st.uid, st.gid).catch(() => undefined);
    if (o.times) await fs.lutimes(dst, st.atime, st.mtime).catch(() => undefined);
  } else if (st.isDirectory()) {
    const sfh = await openListedDir(src, st);
    try {
      await fs.mkdir(dst, { mode: 0o700 }); // opened up to the source's mode once it is filled
      const dfh = await openDir(dst);
      try {
        if (!(await dfh.stat()).isDirectory()) throw new PathError(400, "a folder changed while it was being processed");
        const [s, d] = [dirAt(sfh, src), dirAt(dfh, dst)];
        // The folder is listed in one go so no listing handle is held while its sub-folders are copied (two descriptors per level: source and copy).
        // Files and links are copied a few at a time, sub-folders one after the other. Working folders are not part of the tree.
        let batch: Promise<void>[] = [];
        try {
          for (const e of await fs.readdir(s, { withFileTypes: true })) {
            if (e.name === TRASH_DIR || isReservedName(e.name)) {
              if (o.skipped && (!e.isDirectory() || (await fs.readdir(path.join(s, e.name)).catch(() => ["?"])).length > 0)) o.skipped.push(path.join(s, e.name));
              continue;
            }
            const [from, to] = [path.join(s, e.name), path.join(d, e.name)];
            if (e.isDirectory()) {
              await Promise.all(batch);
              batch = [];
              await copyTree(from, to, o, depth + 1);
            } else {
              batch.push(copyTree(from, to, o, depth + 1));
              if (batch.length >= 16) {
                await Promise.all(batch);
                batch = [];
              }
            }
          }
          await Promise.all(batch);
        } finally {
          await Promise.allSettled(batch); // none still running when the descriptors are closed
        }
        await finish(dfh, st, o, true);
      } finally {
        await dfh.close().catch(() => undefined);
      }
    } finally {
      await sfh.close().catch(() => undefined);
    }
  } else if (st.isFile()) {
    const sfh = await openFd(src, C.O_RDONLY | C.O_NOFOLLOW | C.O_NONBLOCK);
    try {
      const s = await sfh.stat();
      if (!s.isFile() || s.dev !== st.dev || s.ino !== st.ino) throw new PathError(400, "a file changed while it was being processed");
      const dfh = await openFd(dst, C.O_WRONLY | C.O_CREAT | C.O_EXCL | C.O_NOFOLLOW, 0o600);
      try {
        if (s.size > 0) await fs.copyFile(LINUX ? `/proc/self/fd/${sfh.fd}` : src, LINUX ? `/proc/self/fd/${dfh.fd}` : dst);
        await finish(dfh, st, o);
      } catch (e) {
        await fs.unlink(dst).catch(() => undefined);
        throw e;
      } finally {
        await dfh.close().catch(() => undefined);
      }
    } finally {
      await sfh.close().catch(() => undefined);
    }
  } else {
    throw new PathError(400, "cannot copy a special file");
  }
}

/* ---- delete ---- */

/** Up to `max` entries of the folder `at` (with their kinds from the listing), and whether that was all of them. */
async function readEntries(at: string, max: number): Promise<{ entries: Dirent[]; done: boolean }> {
  const d = await fs.opendir(at, { bufferSize: Math.min(max, 4096) }).catch((e: NodeJS.ErrnoException) => {
    throw e.code === "EMFILE" || e.code === "ENFILE" ? tooDeep() : e;
  });
  const entries: Dirent[] = [];
  let done = true;
  try {
    for await (const e of d) {
      entries.push(e);
      if (entries.length >= max) {
        done = false;
        break;
      }
    }
  } finally {
    await d.close().catch(() => undefined);
  }
  return { entries, done };
}

type Guard = (at: string) => Promise<void>;
const kindOf = async (e: Dirent, at: string): Promise<"dir" | "other"> => {
  if (e.isDirectory()) return "dir";
  if (e.isFile() || e.isSymbolicLink() || e.isFIFO() || e.isSocket() || e.isBlockDevice() || e.isCharacterDevice()) return "other";
  return (await fs.lstat(path.join(at, e.name))).isDirectory() ? "dir" : "other"; // the filesystem did not say
};

/** Remove everything inside the folder `at` (a descriptor path); nothing is followed. */
async function emptyDir(at: string, guard?: Guard, depth = 0): Promise<void> {
  if (depth > MAX_DEPTH) throw tooDeep();
  for (;;) {
    const { entries } = await readEntries(at, 32768);
    if (!entries.length) return;
    const dirs: string[] = [];
    const files: string[] = [];
    for (const e of entries) ((await kindOf(e, at)) === "dir" ? dirs : files).push(e.name);
    for (let i = 0; i < files.length; i += 64) {
      await Promise.all(
        files.slice(i, i + 64).map((n) =>
          fs.unlink(path.join(at, n)).catch((err: NodeJS.ErrnoException) => {
            if (err.code !== "ENOENT") throw err;
          }),
        ),
      );
    }
    for (const n of dirs) {
      const child = path.join(at, n);
      let fh: FileHandle;
      try {
        fh = await openDir(child);
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        if (code === "ENOENT") continue;
        if (code === "ELOOP" || code === "ENOTDIR") {
          await fs.unlink(child); // swapped for a link or a file since it was listed: remove that, never enter it
          continue;
        }
        throw e;
      }
      try {
        const sub = dirAt(fh, child);
        await guard?.(sub);
        await emptyDir(sub, guard, depth + 1);
      } finally {
        await fh.close().catch(() => undefined);
      }
      await fs.rmdir(child).catch((err: NodeJS.ErrnoException) => {
        if (err.code !== "ENOENT") throw err;
      });
    }
  }
}

/**
 * Remove the entry at `p` (parent pinned) and everything below it, entering folders through descriptors; links are
 * removed, never followed. Folders on other filesystems are entered like any other (as `rm -r` does).
 */
export async function rmTree(p: string, o: { force?: boolean; guard?: Guard } = {}): Promise<void> {
  try {
    const st = await fs.lstat(p);
    if (!st.isDirectory()) return await fs.unlink(p);
    const fh = await openListedDir(p, st);
    try {
      const at = dirAt(fh, p);
      await o.guard?.(at);
      await emptyDir(at, o.guard);
    } finally {
      await fh.close().catch(() => undefined);
    }
    await fs.rmdir(p);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT" && o.force) return;
    throw e;
  }
}
