import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { pipeline } from "node:stream/promises";
import type { Readable } from "node:stream";
import {
  PathError,
  TRASH_DIR,
  assertNotTrash,
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
}

export class FsError extends Error {
  constructor(
    public status: 400 | 403 | 404 | 409 | 413 | 500,
    message: string,
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
      try {
        const t = await fs.stat(resolveRead(root, e.path).real); // confined, never the container fs
        e.linkDir = t.isDirectory();
      } catch {
        e.linkDir = false;
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
  const st = await fs.stat(r.real);
  if (st.isDirectory()) throw new FsError(400, "is a directory");
  if (!st.isFile()) throw new FsError(400, "not a regular file");
  return { r, size: st.size, mtime: st.mtimeMs, mime: mimeFor(r.real) };
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

export function streamFile(real: string, range?: { start: number; end: number }): Readable {
  return createReadStream(real, range ? { start: range.start, end: range.end } : undefined);
}

export async function mkdir(root: string, p: string) {
  const r = resolveWrite(root, p);
  assertNotTrash(r.virtual);
  if (r.virtual === "/") throw new FsError(409, "already exists");
  await fs.mkdir(r.real);
  return r.virtual;
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
  try {
    await fs.rename(a.real, b.real);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EXDEV") throw e;
    await fs.cp(a.real, b.real, { recursive: true, errorOnExist: !overwrite, force: overwrite, verbatimSymlinks: true });
    await fs.rm(a.real, { recursive: true, force: true });
  }
  return b.virtual;
}

async function exists(real: string) {
  try {
    await fs.lstat(real);
    return true;
  } catch {
    return false;
  }
}

async function uniqueName(dirReal: string, name: string): Promise<string> {
  if (!(await exists(path.join(dirReal, name)))) return name;
  const dot = name.lastIndexOf(".");
  const [base, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
  for (let i = 1; i < 10000; i++) {
    const cand = `${base} (copy${i > 1 ? " " + i : ""})${ext}`;
    if (!(await exists(path.join(dirReal, cand)))) return cand;
  }
  throw new FsError(409, "cannot find a free name");
}

export async function copy(root: string, from: string, toDir: string) {
  const a = resolveWrite(root, from);
  const d = resolveRead(root, toDir);
  assertNotTrash(a.virtual);
  assertNotTrash(d.virtual);
  if (a.virtual === "/") throw new FsError(400, "cannot copy root");
  if (d.virtual === a.virtual || d.virtual.startsWith(a.virtual + "/")) throw new FsError(400, "cannot copy into itself");
  const name = await uniqueName(d.real, path.basename(a.real));
  await fs.cp(a.real, path.join(d.real, name), { recursive: true, errorOnExist: true, force: false, verbatimSymlinks: true });
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
  await fs.rename(r.real, path.join(dir, id, "data"));
  return meta;
}

export async function permanentDelete(root: string, p: string) {
  const r = resolveWrite(root, p);
  assertNotTrash(r.virtual);
  if (r.virtual === "/") throw new FsError(400, "cannot delete root");
  await fs.rm(r.real, { recursive: true });
}

export async function upload(
  root: string,
  dir: string,
  name: string,
  body: Readable,
  overwrite: boolean,
  maxBytes: number,
) {
  const d = resolveRead(root, dir);
  assertNotTrash(d.virtual);
  const target = resolveWrite(root, virtualJoin(d.virtual, name));
  if (!overwrite && (await exists(target.real))) {
    body.resume();
    throw new FsError(409, "destination exists");
  }
  const tmp = path.join(d.real, `.${name}.filedeck-${randomUUID().slice(0, 8)}.part`);
  let written = 0;
  const handle = await fs.open(tmp, "wx", 0o644);
  try {
    const out = handle.createWriteStream();
    body.on("data", (c: Buffer) => {
      written += c.length;
      if (written > maxBytes) body.destroy(new FsError(413, "upload too large"));
    });
    await pipeline(body, out);
    await fs.rename(tmp, target.real);
  } catch (e) {
    await fs.rm(tmp, { force: true });
    throw e;
  }
  return { path: target.virtual, size: written };
}
