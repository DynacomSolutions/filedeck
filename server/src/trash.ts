import fs from "node:fs/promises";
import path from "node:path";
import * as ops from "./fsops.ts";
import { namesOf } from "./dirnames.ts";
import { networkKind, parseMounts, readMountTable } from "./mounts.ts";
import { TRASH_DIR, resolveWrite, virtualJoin } from "./paths.ts";
import { assertNotReserved, pinDirCreate, pinDirW, rmTree, walkGuard } from "./pinwalk.ts";

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
  const slice: string[] = [];
  let truncated = false;
  for await (const b of namesOf(dir, 256, (n) => ID.test(n))) {
    slice.push(...b);
    if (slice.length > MAX_TRASH_ITEMS) {
      truncated = true;
      slice.length = MAX_TRASH_ITEMS;
      break;
    }
  }
  const items: TrashItem[] = [];
  for (let i = 0; i < slice.length; i += 32) items.push(...(await Promise.all(slice.slice(i, i + 32).map((id) => readItem(dir, id)))));
  return { items, truncated };
}

async function readItem(dir: string, id: string): Promise<TrashItem> {
  try {
    const m = JSON.parse(await fs.readFile(path.join(dir, id, "meta.json"), "utf8")) as ops.TrashMeta;
    if (typeof m.name !== "string" || typeof m.originalPath !== "string") throw new Error("bad meta");
    return { id, name: m.name, originalPath: m.originalPath, deletedAt: Number(m.deletedAt) || 0, type: m.type, size: Number(m.size) || 0 };
  } catch {
    const st = await fs.lstat(path.join(dir, id)).catch(() => null);
    return { id, name: id, originalPath: "", deletedAt: st?.mtimeMs ?? 0, type: "other", size: 0, orphan: true };
  }
}

/** Every volume of this node that has a trash store: the root plus each real mount point. */
export async function listTrash(root: string, procMounts: string): Promise<TrashVolume[]> {
  const text = await readMountTable(root, procMounts); // "" when unreadable: root only
  const cands = new Set<string>(["/"]);
  // Every real filesystem, not only the ones the drive list shows: an item trashed on a hidden volume lives there.
  for (const m of parseMounts(text, { all: true })) cands.add(m.mountpoint);
  const out: TrashVolume[] = [];
  for (const volume of [...cands].sort()) {
    try {
      const v = resolveWrite(root, volume);
      const net = [...parseMounts(text, { all: true })].find((m) => m.mountpoint === volume);
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
  /** true for a path the caller must not change (a read-only volume, or a folder that contains one); checked on the computed destination */
  blocked?: (virtual: string) => boolean;
}
export interface TrashResult {
  id: string;
  ok: boolean;
  path?: string;
  error?: string;
  /** the destination exists (retry with a conflict policy) */
  conflict?: boolean;
  /** the item was restored, but something is left to do (its copy in the trash could not be removed) */
  warning?: string;
}

/** Remove one item folder of the trash store, entering it through descriptors (nothing inside is followed). */
const removeItem = (root: string, dir: string, id: string) => pinDirW(root, dir, (at) => rmTree(path.join(at, id), { force: true, guard: walkGuard(root) }));

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
      assertNotReserved(dest.virtual);
      if (dest.virtual === "/") throw bad("cannot restore onto the root");
      if (opts.blocked?.(dest.virtual)) throw new ops.FsError(403, "read-only volume");
      // The destination folder is created and held one component at a time, and the item is moved out of its own pinned
      // folder, so neither side can be swapped for a link between the checks and the move.
      const res = await pinDirCreate(root, path.dirname(dest.real), async (dstAt): Promise<TrashResult> => {
        const base = path.basename(dest.real);
        let final = base;
        if (await ops.exists(path.join(dstAt, base))) {
          if (policy === "fail") return { id, ok: false, conflict: true, error: "destination exists" };
          if (policy === "rename") final = await ops.uniqueName(dstAt, base);
          else await ops.trash(root, dest.virtual); // the replaced item stays recoverable
        }
        let warning: string | undefined;
        try {
          await pinDirW(root, path.join(dir, id), (srcAt) => ops.moveReal(path.join(srcAt, "data"), path.join(dstAt, final), false, root));
        } catch (e) {
          if (!(e instanceof ops.FsError && e.extra?.copyComplete === true)) throw e;
          // The item is back in place and its trash copy could not be removed (it was linked or copied, not renamed). The item stays in the
          // list for as long as its data is on disk; try once more to clear it, else say so.
          warning = `The item is restored. Its copy in the trash could not be removed: ${String(e.extra.reason)}. It is still listed in the trash; delete it there.`;
        }
        if (warning) {
          // One more try, the data first: when it still cannot go, `meta.json` is untouched and the item stays listed under its own name.
          const gone = await pinDirW(root, path.join(dir, id), (itemAt) => rmTree(path.join(itemAt, "data"), { force: true, guard: walkGuard(root) })).then(
            () => true,
            () => false,
          );
          if (gone) {
            await removeItem(root, dir, id);
            warning = undefined;
          }
        } else await removeItem(root, dir, id);
        return { id, ok: true, path: path.posix.join(path.posix.dirname(dest.virtual), final), ...(warning ? { warning } : {}) };
      });
      out.push(res);
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
      await removeItem(root, dir, id);
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
  // Every item is judged on its own age, however many there are (the listing is capped, the sweep is not).
  for await (const names of namesOf(dir, 256, (n) => ID.test(n))) {
    const ages = cutoff === Infinity ? null : await Promise.all(names.map((id) => readItem(dir, id)));
    for (const [k, id] of names.entries()) {
      if (ages && (ages[k] as TrashItem).deletedAt > cutoff) continue;
      try {
        await removeItem(root, dir, id);
        removed++;
      } catch {
        failed++;
      }
    }
  }
  return { removed, failed };
}
