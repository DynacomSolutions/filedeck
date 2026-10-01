import fs from "node:fs/promises";
import path from "node:path";
import * as ops from "./fsops.ts";
import { networkKind, parseMounts } from "./mounts.ts";
import { TRASH_DIR, assertNotTrash, resolveWrite, virtualJoin } from "./paths.ts";

export interface TrashItem extends ops.TrashMeta {
  /** meta.json missing or unreadable: the item can still be deleted but not restored */
  orphan?: boolean;
}
export interface TrashVolume {
  /** virtual path of the volume root ("/" or a mount point) that holds `.filedeck-trash` */
  volume: string;
  items: TrashItem[];
  truncated: boolean;
}

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const MAX_TRASH_ITEMS = 5000;

const bad = (m: string) => new ops.FsError(400, m);
const withTimeout = <T,>(p: Promise<T>, ms: number) =>
  Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(new Error("timeout")), ms).unref())]);

/** The real trash directory of a volume, which must exist and be a plain directory (never a link). */
async function trashDir(root: string, volume: string): Promise<string> {
  const v = resolveWrite(root, volume);
  const dir = path.join(v.real, TRASH_DIR);
  let st;
  try {
    st = await fs.lstat(dir);
  } catch {
    throw new ops.FsError(404, "no trash on this volume");
  }
  if (!st.isDirectory()) throw new ops.FsError(404, "no trash on this volume");
  return dir;
}

const checkIds = (ids: unknown): string[] => {
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > 10000 || ids.some((x) => typeof x !== "string" || !ID.test(x))) throw bad("ids must be a non-empty array of trash ids");
  return ids as string[];
};

async function readItems(dir: string): Promise<{ items: TrashItem[]; truncated: boolean }> {
  const names = (await fs.readdir(dir)).filter((n) => ID.test(n));
  const truncated = names.length > MAX_TRASH_ITEMS;
  const items: TrashItem[] = [];
  const slice = names.slice(0, MAX_TRASH_ITEMS);
  for (let i = 0; i < slice.length; i += 32) {
    const got = await Promise.all(
      slice.slice(i, i + 32).map(async (id): Promise<TrashItem> => {
        try {
          const m = JSON.parse(await fs.readFile(path.join(dir, id, "meta.json"), "utf8")) as ops.TrashMeta;
          if (typeof m.name !== "string" || typeof m.originalPath !== "string") throw new Error("bad meta");
          return { id, name: m.name, originalPath: m.originalPath, deletedAt: Number(m.deletedAt) || 0, type: m.type, size: Number(m.size) || 0 };
        } catch {
          const st = await fs.lstat(path.join(dir, id)).catch(() => null);
          return { id, name: id, originalPath: "", deletedAt: st?.mtimeMs ?? 0, type: "other", size: 0, orphan: true };
        }
      }),
    );
    items.push(...got);
  }
  return { items, truncated };
}

/** Every volume of this node that has a trash store: the root plus each real mount point. */
export async function listTrash(root: string, procMounts: string): Promise<TrashVolume[]> {
  let text = "";
  try {
    text = await fs.readFile(procMounts, "utf8");
  } catch {
    /* no mount table: root only */
  }
  const cands = new Set<string>(["/"]);
  for (const m of parseMounts(text)) cands.add(m.mountpoint);
  const out: TrashVolume[] = [];
  for (const volume of [...cands].sort()) {
    try {
      const v = resolveWrite(root, volume);
      const net = [...parseMounts(text)].find((m) => m.mountpoint === volume);
      const dir = path.join(v.real, TRASH_DIR);
      const st = await (net && networkKind(net.fstype) ? withTimeout(fs.lstat(dir), 2000) : fs.lstat(dir));
      if (!st.isDirectory()) continue;
      out.push({ volume, ...(await readItems(dir)) });
    } catch {
      /* no trash here, or an unreachable mount */
    }
  }
  return out;
}

export interface RestoreOpts {
  /** what to do when the destination exists: refuse (default), keep both, or move the existing one to the trash first */
  conflict?: "fail" | "rename" | "replace";
  /** restore into this folder (keeping the name) instead of the original location */
  toDir?: string;
}
export interface TrashResult {
  id: string;
  ok: boolean;
  path?: string;
  error?: string;
  /** the destination exists (retry with a conflict policy) */
  conflict?: boolean;
}

export async function restoreItems(root: string, volume: string, ids: unknown, opts: RestoreOpts = {}): Promise<TrashResult[]> {
  const dir = await trashDir(root, volume);
  const policy = opts.conflict ?? "fail";
  if (!["fail", "rename", "replace"].includes(policy)) throw bad("unknown conflict policy");
  const out: TrashResult[] = [];
  for (const id of checkIds(ids)) {
    try {
      const meta = JSON.parse(await fs.readFile(path.join(dir, id, "meta.json"), "utf8")) as ops.TrashMeta;
      const data = path.join(dir, id, "data");
      await fs.lstat(data);
      const target = opts.toDir ? virtualJoin(resolveWrite(root, opts.toDir).virtual, meta.name) : meta.originalPath;
      const dest = resolveWrite(root, target);
      assertNotTrash(dest.virtual);
      if (dest.virtual === "/") throw bad("cannot restore onto the root");
      await fs.mkdir(path.dirname(dest.real), { recursive: true });
      let finalReal = dest.real;
      if (await ops.exists(dest.real)) {
        if (policy === "fail") {
          out.push({ id, ok: false, conflict: true, error: "destination exists" });
          continue;
        }
        if (policy === "rename") {
          const name = await ops.uniqueName(path.dirname(dest.real), path.basename(dest.real));
          finalReal = path.join(path.dirname(dest.real), name);
        } else {
          await ops.trash(root, dest.virtual); // the replaced item stays recoverable
        }
      }
      await ops.moveReal(data, finalReal, false);
      await fs.rm(path.join(dir, id), { recursive: true, force: true });
      out.push({ id, ok: true, path: path.posix.join(path.posix.dirname(dest.virtual), path.basename(finalReal)) });
    } catch (e) {
      out.push({ id, ok: false, error: ops.mapError(e).message });
    }
  }
  return out;
}

export async function deleteItems(root: string, volume: string, ids: unknown): Promise<TrashResult[]> {
  const dir = await trashDir(root, volume);
  const out: TrashResult[] = [];
  for (const id of checkIds(ids)) {
    try {
      await fs.rm(path.join(dir, id), { recursive: true, force: true });
      out.push({ id, ok: true });
    } catch (e) {
      out.push({ id, ok: false, error: ops.mapError(e).message });
    }
  }
  return out;
}

/** Delete everything in a volume's trash, or only items deleted more than `olderThanDays` ago. */
export async function emptyTrash(root: string, volume: string, olderThanDays?: number): Promise<{ removed: number; failed: number }> {
  const dir = await trashDir(root, volume);
  const cutoff = olderThanDays !== undefined ? Date.now() - olderThanDays * 86400_000 : Infinity;
  if (olderThanDays !== undefined && !(olderThanDays >= 0)) throw bad("olderThanDays must be >= 0");
  let removed = 0;
  let failed = 0;
  const { items } = await readItems(dir);
  const all = (await fs.readdir(dir)).filter((n) => ID.test(n)).length;
  const keep = new Set(items.filter((i) => i.deletedAt > cutoff).map((i) => i.id));
  const names = items.length === all ? items.map((i) => i.id) : (await fs.readdir(dir)).filter((n) => ID.test(n));
  for (const id of names) {
    if (keep.has(id)) continue;
    try {
      await fs.rm(path.join(dir, id), { recursive: true, force: true });
      removed++;
    } catch {
      failed++;
    }
  }
  return { removed, failed };
}
