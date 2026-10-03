import { constants } from "node:fs";
import fs, { type FileHandle } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { pipeline } from "node:stream/promises";
import type { Readable } from "node:stream";
import {
  PathError,
  TRASH_DIR,
  assertNotTrash,
  openChecked,
  pinDir,
  pinParent,
  resolveRead,
  resolveWrite,
  virtualJoin,
  type Resolved,
} from "./paths.ts";

export interface Entry {
  name: string;
  path: string;
  type: "file" | "dir" | "symlink" | "other";
  size: number;
  mtime: number;
  mode: number;
  /** For symlinks: whether the target resolves to a directory */
  linkDir?: boolean;
  /** For symlinks: the link text exactly as stored */
  target?: string;
  /** For symlinks: the target does not exist (inside this volume) */
  broken?: boolean;
}

export class FsError extends Error {
  constructor(
    public status: 400 | 401 | 403 | 404 | 409 | 413 | 415 | 428 | 429 | 500 | 501 | 502 | 504 | 507,
    message: string,
    public extra?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export function mapError(e: unknown): { status: number; message: string } {
  if (e instanceof PathError || e instanceof FsError) return { status: e.status, message: e.message };
  const code = (e as NodeJS.ErrnoException)?.code;
  switch (code) {
    case "ENOENT":
      return { status: 404, message: "not found" };
    case "ENOTDIR":
      return { status: 400, message: "not a directory" };
    case "EISDIR":
      return { status: 400, message: "is a directory" };
    case "EEXIST":
    case "ENOTEMPTY":
      return { status: 409, message: "already exists" };
    case "EACCES":
    case "EPERM":
    case "EROFS":
      return { status: 403, message: "permission denied" };
    case "ENOSPC":
      return { status: 507, message: "no space left on device" };
    case "EXDEV":
      return { status: 409, message: "cross-device operation" };
  }
  return { status: 500, message: "internal error" };
}

function kind(st: { isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean }): Entry["type"] {
  return st.isSymbolicLink() ? "symlink" : st.isDirectory() ? "dir" : st.isFile() ? "file" : "other";
}

async function toEntry(root: string, parentVirtual: string, parentReal: string, name: string): Promise<Entry | null> {
  try {
    const st = await fs.lstat(path.join(parentReal, name));
    const e: Entry = {
      name,
      path: virtualJoin(parentVirtual, name),
      type: kind(st),
      size: st.size,
      mtime: st.mtimeMs,
      mode: st.mode & 0o7777,
    };
    if (e.type === "symlink") {
      e.target = await fs.readlink(path.join(parentReal, name)).catch(() => undefined);
      try {
        const t = await fs.stat(resolveRead(root, e.path).real); // confined, never the container fs
        e.linkDir = t.isDirectory();
      } catch (err) {
        e.linkDir = false;
        e.broken = (err as NodeJS.ErrnoException).code === "ENOENT" || (err as NodeJS.ErrnoException).code === "ELOOP" || (err as NodeJS.ErrnoException).code === "ENOTDIR";
      }
    }
    return e;
  } catch {
    return null; // vanished between readdir and lstat
  }
}

export const MAX_LIST = 20000;

export async function list(root: string, p: string, hidden: boolean) {
  const r = resolveRead(root, p);
  const st = await fs.stat(r.real);
  if (!st.isDirectory()) throw new FsError(400, "not a directory");
  const names = await fs.readdir(r.real);
  const visible = names.filter((n) => n !== TRASH_DIR && (hidden || !n.startsWith(".")));
  const truncated = visible.length > MAX_LIST;
  const out: Entry[] = [];
  // bounded concurrency
  const batch = 64;
  const slice = visible.slice(0, MAX_LIST);
  for (let i = 0; i < slice.length; i += batch) {
    const got = await Promise.all(slice.slice(i, i + batch).map((n) => toEntry(root, r.virtual, r.real, n)));
    for (const g of got) if (g) out.push(g);
  }
  return { path: r.virtual, entries: out, truncated };
}

export async function stat(root: string, p: string) {
  const r = resolveWrite(root, p); // lstat semantics for the final component
  const parent = path.posix.dirname(r.virtual);
  const e = await toEntry(root, parent, path.dirname(r.real), path.basename(r.real));
  if (!e) throw new FsError(404, "not found");
  if (r.virtual === "/") e.path = "/";
  return e;
}

export interface Opened {
  r: Resolved;
  /** descriptor opened inside the root and checked there; close it, or stream it with `streamFile` */
  fh: FileHandle;
  size: number;
  mtime: number;
  mime: string;
}

const MIME: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp",
  avif: "image/avif", svg: "image/svg+xml", bmp: "image/bmp", ico: "image/x-icon",
  mp4: "video/mp4", m4v: "video/mp4", webm: "video/webm", mkv: "video/x-matroska", mov: "video/quicktime",
  mp3: "audio/mpeg", m4a: "audio/mp4", ogg: "audio/ogg", wav: "audio/wav", flac: "audio/flac", opus: "audio/ogg",
  pdf: "application/pdf", json: "application/json", html: "text/plain", htm: "text/plain",
  txt: "text/plain", md: "text/plain", log: "text/plain", csv: "text/plain", xml: "text/plain",
  yaml: "text/plain", yml: "text/plain", ts: "text/plain", js: "text/plain", css: "text/plain",
};

export function mimeFor(name: string): string {
  const ext = name.slice(name.lastIndexOf(".") + 1).toLowerCase();
  return MIME[ext] ?? "application/octet-stream";
}

export async function openFile(root: string, p: string): Promise<Opened> {
  const r = resolveRead(root, p);
  // O_NONBLOCK: a FIFO swapped in after resolution must not hang the open; the type is checked on the descriptor.
  const fh = await openChecked(root, r.real, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const st = await fh.stat();
    if (st.isDirectory()) throw new FsError(400, "is a directory");
    if (!st.isFile()) throw new FsError(400, "not a regular file");
    return { r, fh, size: st.size, mtime: st.mtimeMs, mime: mimeFor(r.real) };
  } catch (e) {
    await fh.close().catch(() => undefined);
    throw e;
  }
}

export function parseRange(header: string | undefined, size: number): { start: number; end: number } | "invalid" | null {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return "invalid";
  const [, a, b] = m;
  let start: number;
  let end: number;
  if (a === "" && b === "") return "invalid";
  if (a === "") {
    const n = Number(b);
    if (n === 0) return "invalid";
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = Number(a);
    end = b === "" ? size - 1 : Math.min(Number(b), size - 1);
  }
  if (start >= size || start > end) return "invalid";
  return { start, end };
}

export function streamFile(f: Pick<Opened, "fh">, range?: { start: number; end: number }): Readable {
  return f.fh.createReadStream(range ? { start: range.start, end: range.end } : undefined);
}

export async function mkdir(root: string, p: string) {
  const r = resolveWrite(root, p);
  assertNotTrash(r.virtual);
  if (r.virtual === "/") throw new FsError(409, "already exists");
  await pinParent(root, r.real, (at) => fs.mkdir(at));
  return r.virtual;
}

/**
 * Create a symbolic link at `p` pointing at `target` (stored verbatim: relative
 * stays relative, an absolute target is the host's own path). With `overwrite`
 * an existing *link* is retargeted atomically (temp link + rename); a regular
 * file or folder is never replaced.
 */
export async function symlink(root: string, p: string, target: string, overwrite = false) {
  const r = resolveWrite(root, p);
  assertNotTrash(r.virtual);
  if (r.virtual === "/") throw new FsError(409, "already exists");
  if (typeof target !== "string" || target === "" || target.includes("\0") || target.length > 4096) throw new FsError(400, "invalid link target");
  await pinParent(root, r.real, async (at) => {
    const cur = await fs.lstat(at).catch(() => null);
    if (!cur) return fs.symlink(target, at);
    if (!overwrite) throw new FsError(409, "already exists");
    if (!cur.isSymbolicLink()) throw new FsError(409, "exists and is not a symbolic link");
    const tmp = path.join(path.dirname(at), `.${path.basename(at)}.filedeck-ln-${randomUUID().slice(0, 8)}`);
    try {
      await fs.symlink(target, tmp);
      await fs.rename(tmp, at);
    } catch (e) {
      await fs.rm(tmp, { force: true });
      throw e;
    }
  });
  return stat(root, r.virtual);
}

export async function rename(root: string, from: string, to: string, overwrite = false) {
  const a = resolveWrite(root, from);
  const b = resolveWrite(root, to);
  assertNotTrash(a.virtual);
  assertNotTrash(b.virtual);
  if (a.virtual === "/" || b.virtual === "/") throw new FsError(400, "cannot move root");
  if (b.virtual === a.virtual) return b.virtual;
  if (b.virtual.startsWith(a.virtual + "/")) throw new FsError(400, "cannot move into itself");
  if (!overwrite && (await exists(b.real))) throw new FsError(409, "destination exists");
  await pinParent(root, a.real, (from) => pinParent(root, b.real, (to) => moveReal(from, to, overwrite)));
  return b.virtual;
}

/** rename(2), falling back to copy-beside + swap + remove when source and destination are on different devices. */
export async function moveReal(from: string, to: string, overwrite: boolean) {
  try {
    await fs.rename(from, to);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EXDEV") throw e;
    // Copy beside the destination first so a failure midway leaves nothing
    // at the real name and the temp tree can be removed; the source is only
    // deleted once the copy is complete and in place.
    const tmp = path.join(path.dirname(to), `.${path.basename(to)}.filedeck-part-${randomUUID()}`);
    try {
      await fs.cp(from, tmp, { recursive: true, errorOnExist: true, force: false, verbatimSymlinks: true });
      if (overwrite) await fs.rm(to, { recursive: true, force: true });
      await fs.rename(tmp, to);
    } catch (err) {
      await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
      throw err;
    }
    await fs.rm(from, { recursive: true, force: true });
  }
}

export async function exists(real: string) {
  try {
    await fs.lstat(real);
    return true;
  } catch {
    return false;
  }
}

export async function uniqueName(dirReal: string, name: string): Promise<string> {
  if (!(await exists(path.join(dirReal, name)))) return name;
  const dot = name.lastIndexOf(".");
  const [base, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
  for (let i = 1; i < 10000; i++) {
    const cand = `${base} (copy${i > 1 ? " " + i : ""})${ext}`;
    if (!(await exists(path.join(dirReal, cand)))) return cand;
  }
  throw new FsError(409, "cannot find a free name");
}

export interface CopyOpts {
  /** Replace an existing destination of the same name instead of picking a free "(copy)" name. A folder replaces the whole destination folder, it is not merged. */
  overwrite?: boolean;
  /** Keep the source's modification times (used by folder-diff sync so the copy compares equal). */
  preserveTimes?: boolean;
}

export async function copy(root: string, from: string, toDir: string, opts: CopyOpts = {}) {
  const a = resolveWrite(root, from);
  const d = resolveRead(root, toDir);
  assertNotTrash(a.virtual);
  assertNotTrash(d.virtual);
  if (a.virtual === "/") throw new FsError(400, "cannot copy root");
  if (d.virtual === a.virtual || d.virtual.startsWith(a.virtual + "/")) throw new FsError(400, "cannot copy into itself");
  const cpOpts = { recursive: true, errorOnExist: true, force: false, verbatimSymlinks: true, preserveTimestamps: opts.preserveTimes === true };
  if (!opts.overwrite) {
    const name = await uniqueName(d.real, path.basename(a.real));
    await fs.cp(a.real, path.join(d.real, name), cpOpts);
    return virtualJoin(d.virtual, name);
  }
  const name = path.basename(a.real);
  const dest = path.join(d.real, name);
  if (dest === a.real) throw new FsError(400, "source and destination are the same");
  // Copy beside the destination, then swap in: a failed copy never damages the existing file.
  const tmp = path.join(d.real, `.${name}.filedeck-part-${randomUUID()}`);
  try {
    await fs.cp(a.real, tmp, cpOpts);
    const [src, cur] = [await fs.lstat(tmp), await fs.lstat(dest).catch(() => null)];
    if (cur && !(src.isFile() && cur.isFile())) await fs.rm(dest, { recursive: true, force: true });
    await fs.rename(tmp, dest);
  } catch (e) {
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
    throw e;
  }
  return virtualJoin(d.virtual, name);
}

export async function move(root: string, from: string, toDir: string) {
  const a = resolveWrite(root, from);
  const d = resolveRead(root, toDir);
  return rename(root, a.virtual, virtualJoin(d.virtual, path.basename(a.real)));
}

/** Walk up until st_dev changes: the topmost directory on the same filesystem. */
export async function volumeRoot(real: string, root: string): Promise<string> {
  let cur = real;
  const dev = (await fs.lstat(cur)).dev;
  while (cur !== root) {
    const parent = path.dirname(cur);
    if ((await fs.lstat(parent)).dev !== dev) break;
    cur = parent;
  }
  return cur;
}

export interface TrashMeta {
  id: string;
  name: string;
  originalPath: string;
  deletedAt: number;
  type: Entry["type"];
  size: number;
}

export async function trash(root: string, p: string): Promise<TrashMeta> {
  const r = resolveWrite(root, p);
  assertNotTrash(r.virtual);
  if (r.virtual === "/") throw new FsError(400, "cannot trash root");
  const st = await fs.lstat(r.real);
  const vol = await volumeRoot(path.dirname(r.real), root);
  const dir = path.join(vol, TRASH_DIR);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const id = randomUUID();
  const meta: TrashMeta = {
    id,
    name: path.basename(r.real),
    originalPath: r.virtual,
    deletedAt: Date.now(),
    type: kind(st),
    size: st.size,
  };
  await fs.mkdir(path.join(dir, id));
  await fs.writeFile(path.join(dir, id, "meta.json"), JSON.stringify(meta));
  await pinParent(root, r.real, (at) => fs.rename(at, path.join(dir, id, "data")));
  return meta;
}

export async function permanentDelete(root: string, p: string) {
  const r = resolveWrite(root, p);
  assertNotTrash(r.virtual);
  if (r.virtual === "/") throw new FsError(400, "cannot delete root");
  await pinParent(root, r.real, (at) => fs.rm(at, { recursive: true }));
}

export async function upload(
  root: string,
  dir: string,
  name: string,
  body: Readable,
  overwrite: boolean,
  maxBytes: number,
  mtimeMs?: number,
) {
  const d = resolveRead(root, dir);
  assertNotTrash(d.virtual);
  const target = resolveWrite(root, virtualJoin(d.virtual, name));
  // Work through the pinned destination folder so it cannot be swapped for a link mid-upload.
  return pinDir(root, d.real, async (at) => {
    const dest = path.join(at, path.basename(target.real));
    if (!overwrite && (await exists(dest))) {
      body.resume();
      throw new FsError(409, "destination exists");
    }
    const tmp = path.join(at, `.${name}.filedeck-${randomUUID().slice(0, 8)}.part`);
    let written = 0;
    const handle = await fs.open(tmp, "wx", 0o644);
    try {
      const out = handle.createWriteStream();
      body.on("data", (c: Buffer) => {
        written += c.length;
        if (written > maxBytes) body.destroy(new FsError(413, "upload too large"));
      });
      await pipeline(body, out);
      if (mtimeMs !== undefined && Number.isFinite(mtimeMs) && mtimeMs > 0) {
        const t = new Date(mtimeMs);
        await fs.utimes(tmp, t, t);
      }
      await fs.rename(tmp, dest);
    } catch (e) {
      await fs.rm(tmp, { force: true });
      throw e;
    }
    return { path: target.virtual, size: written };
  });
}

export const MAX_EDIT = 5 * 1024 * 1024;

export const etagOf = (st: { mtimeMs: number; size: number; ino: number }) => `${st.mtimeMs}-${st.size}-${st.ino}`;

function assertText(buf: Buffer) {
  if (buf.subarray(0, 8192).includes(0)) throw new FsError(415, "binary file");
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(buf);
  } catch {
    throw new FsError(415, "file is not valid UTF-8 text");
  }
}

/** Read a small UTF-8 text file for the editor, with the etag used for conflict checks. */
export async function readText(root: string, p: string, maxBytes = MAX_EDIT) {
  const r = resolveRead(root, p);
  const fh = await openChecked(root, r.real, constants.O_RDONLY | constants.O_NONBLOCK);
  let st, buf;
  try {
    st = await fh.stat();
    if (!st.isFile()) throw new FsError(400, st.isDirectory() ? "is a directory" : "not a regular file");
    if (st.size > maxBytes) throw new FsError(413, "file too large to edit");
    buf = await fh.readFile();
  } finally {
    await fh.close().catch(() => undefined);
  }
  assertText(buf);
  return { path: r.virtual, content: buf.toString("utf8"), size: st.size, mtime: st.mtimeMs, etag: etagOf(st) };
}

/**
 * Atomic overwrite (temp file + rename in the same directory) with optimistic
 * concurrency: `ifMatch` must equal the file's current etag, otherwise 409 with
 * the current etag. `ifMatch === "*"` is rejected; `null` means create-only.
 */
export async function writeText(root: string, p: string, body: Buffer, ifMatch: string | null, maxBytes = MAX_EDIT) {
  const r = resolveRead(root, p); // follow a final symlink, confined to root
  assertNotTrash(r.virtual);
  if (r.virtual === "/") throw new FsError(400, "is a directory");
  if (body.length > maxBytes) throw new FsError(413, "content too large");
  assertText(body);
  return pinDir(root, path.dirname(r.real), async (dir) => {
    const at = path.join(dir, path.basename(r.real));
    let cur: Awaited<ReturnType<typeof fs.stat>> | null = null;
    try {
      cur = await fs.stat(at);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    if (cur && !cur.isFile()) throw new FsError(400, cur.isDirectory() ? "is a directory" : "not a regular file");
    if (ifMatch === null) {
      if (cur) throw new FsError(409, "file already exists", { etag: etagOf(cur), mtime: cur.mtimeMs });
    } else {
      if (!cur) throw new FsError(404, "not found");
      if (etagOf(cur) !== ifMatch) {
        throw new FsError(409, "file changed on disk since it was opened", { etag: etagOf(cur), mtime: cur.mtimeMs });
      }
    }
    const tmp = path.join(dir, `.${path.basename(r.real)}.filedeck-${randomUUID().slice(0, 8)}.part`);
    try {
      await fs.writeFile(tmp, body, { flag: "wx", mode: cur ? Number(cur.mode) & 0o7777 : 0o644 });
      if (cur) {
        await fs.chmod(tmp, Number(cur.mode) & 0o7777);
        await fs.chown(tmp, Number(cur.uid), Number(cur.gid)).catch(() => undefined);
      }
      await fs.rename(tmp, at);
    } catch (e) {
      await fs.rm(tmp, { force: true });
      throw e;
    }
    const st = await fs.stat(at);
    return { path: r.virtual, size: st.size, mtime: st.mtimeMs, etag: etagOf(st) };
  });
}
