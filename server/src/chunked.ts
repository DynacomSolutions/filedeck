import fs from "node:fs/promises";
import { constants as C } from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import type { Readable } from "node:stream";
import { FsError, exists } from "./fsops.ts";
import { assertNotTrash, resolveRead, resolveWrite, virtualJoin } from "./paths.ts";

/**
 * Resumable chunked uploads. The client picks an id (a stable hash of the file's identity) and sends
 * the file in order as chunks. The bytes land in a hidden part file next to the destination
 * (`.<name>.filedeck-up-<id>.part`), so a restart of the browser, the hub or the connection resumes
 * from whatever the part file holds. The last chunk renames the part file into place atomically.
 */
const ID_RE = /^[0-9a-f]{8,64}$/;
const PART_RE = /^\..+\.filedeck-up-[0-9a-f]{8,64}\.part$/;
/** abandoned part files older than this are removed the next time the folder is used for an upload */
export const STALE_MS = 7 * 24 * 3600 * 1000;
/** most bytes one chunk request may carry */
export const MAX_CHUNK = 64 * 1024 * 1024;

const busy = new Set<string>();

interface Loc {
  dirReal: string;
  target: string;
  part: string;
}

function locate(root: string, dir: string, name: string, id: string): Loc {
  if (!ID_RE.test(id)) throw new FsError(400, "invalid upload id");
  const d = resolveRead(root, dir);
  assertNotTrash(d.virtual);
  const target = resolveWrite(root, virtualJoin(d.virtual, name)); // validates the name too
  const part = path.join(d.real, `.${name}.filedeck-up-${id}.part`);
  return { dirReal: d.real, target: target.real, part };
}

async function partSize(part: string): Promise<number> {
  try {
    const st = await fs.lstat(part);
    if (!st.isFile()) throw new FsError(409, "upload slot is not a file");
    return st.size;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw e;
  }
}

async function sweep(dirReal: string) {
  try {
    const now = Date.now();
    for (const n of await fs.readdir(dirReal)) {
      if (!PART_RE.test(n)) continue;
      const p = path.join(dirReal, n);
      const st = await fs.lstat(p).catch(() => null);
      if (st?.isFile() && now - st.mtimeMs > STALE_MS) await fs.rm(p, { force: true });
    }
  } catch {
    /* best effort */
  }
}

/** How many bytes of this upload the server already has, and whether the destination name is taken. */
export async function uploadStatus(root: string, dir: string, name: string, id: string) {
  const l = locate(root, dir, name, id);
  await sweep(l.dirReal);
  return { offset: await partSize(l.part), exists: await exists(l.target) };
}

export interface ChunkOpts {
  total: number;
  overwrite: boolean;
  mtimeMs?: number;
  maxBytes: number;
}

/**
 * Append one chunk at `offset`. The offset must equal the bytes already stored (409 with the stored
 * size otherwise, so the client resyncs). When the part file reaches `total` it is moved into place.
 */
export async function uploadChunk(root: string, dir: string, name: string, id: string, offset: number, body: Readable, o: ChunkOpts) {
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(o.total) || o.total < 0) {
    body.resume();
    throw new FsError(400, "offset and total must be non-negative integers");
  }
  if (o.total > o.maxBytes) {
    body.resume();
    throw new FsError(413, "upload too large");
  }
  const l = locate(root, dir, name, id);
  if (busy.has(l.part)) {
    body.resume();
    throw new FsError(409, "another chunk of this upload is in progress");
  }
  busy.add(l.part);
  try {
    const cur = await partSize(l.part);
    if (offset !== cur) {
      body.resume();
      throw new FsError(409, "offset mismatch", { offset: cur });
    }
    if (cur === 0 && !o.overwrite && (await exists(l.target))) {
      body.resume();
      throw new FsError(409, "destination exists");
    }
    const fh = await fs.open(l.part, C.O_WRONLY | C.O_APPEND | C.O_CREAT | C.O_NOFOLLOW, 0o644);
    let n = 0;
    try {
      body.on("data", (c: Buffer) => {
        n += c.length;
        if (n > MAX_CHUNK) body.destroy(new FsError(413, "chunk too large"));
        else if (cur + n > o.total) body.destroy(new FsError(400, "chunk runs past the declared size"));
      });
      await pipeline(body, fh.createWriteStream());
    } catch (e) {
      // keep what arrived intact (the next status call tells the client where to resume), except an overrun
      if (e instanceof FsError) await fs.truncate(l.part, cur).catch(() => undefined);
      throw e;
    }
    const size = cur + n;
    if (size < o.total) return { done: false as const, offset: size };
    if (!o.overwrite && (await exists(l.target))) throw new FsError(409, "destination exists");
    if (o.mtimeMs !== undefined && Number.isFinite(o.mtimeMs) && o.mtimeMs > 0) {
      const t = new Date(o.mtimeMs);
      await fs.utimes(l.part, t, t);
    }
    await fs.rename(l.part, l.target);
    const v = resolveRead(root, dir).virtual;
    return { done: true as const, offset: size, path: virtualJoin(v, name), size };
  } finally {
    busy.delete(l.part);
  }
}

/** Drop a partial upload. */
export async function uploadAbort(root: string, dir: string, name: string, id: string) {
  const l = locate(root, dir, name, id);
  if (busy.has(l.part)) throw new FsError(409, "a chunk of this upload is in progress");
  await fs.rm(l.part, { force: true });
}
