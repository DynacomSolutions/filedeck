import fs from "node:fs/promises";
import { constants as fsc } from "node:fs";
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

/** Every volume of this node that has a trash store (the root plus each real mount point), with its trash directory. */
async function trashVolumes(root: string, procMounts: string): Promise<{ volume: string; dir: string; real: string }[]> {
  const text = await readMountTable(root, procMounts); // "" when unreadable: root only
  const cands = new Set<string>(["/"]);
  // Every real filesystem, not only the ones the drive list shows: an item trashed on a hidden volume lives there.
  for (const m of parseMounts(text, { all: true })) cands.add(m.mountpoint);
  const out: { volume: string; dir: string; real: string }[] = [];
  for (const volume of [...cands].sort()) {
    try {
      const v = resolveWrite(root, volume);
      const net = [...parseMounts(text, { all: true })].find((m) => m.mountpoint === volume);
      const dir = path.join(v.real, TRASH_DIR);
      const st = await (net && networkKind(net.fstype) ? withTimeout(fs.lstat(dir), 2000) : fs.lstat(dir));
      if (st.isDirectory()) out.push({ volume, dir, real: v.real });
    } catch {
      /* no trash here, or an unreachable mount */
    }
  }
  return out;
}

/** Every volume of this node that has a trash store: the root plus each real mount point. */
export async function listTrash(root: string, procMounts: string): Promise<TrashVolume[]> {
  const out: TrashVolume[] = [];
  for (const { volume, dir } of await trashVolumes(root, procMounts)) {
    try {
      out.push({ volume, ...(await readItems(dir)) });
    } catch {
      /* gone meanwhile */
    }
  }
  return out;
}

/**
 * Disk usage of one trash item, measured once and kept in its meta.json (an item never changes while it is in the trash). The walk holds one open folder
 * per level and never enters another device, so a huge item costs time, not memory.
 */
async function itemUsage(dir: string, id: string): Promise<{ id: string; deletedAt: number; disk: number }> {
  const item = path.join(dir, id);
  const metaFile = path.join(item, "meta.json");
  let meta: (ops.TrashMeta & { diskBytes?: number }) | undefined;
  try {
    meta = JSON.parse(await fs.readFile(metaFile, "utf8"));
  } catch {
    /* orphan: measured every time, never written */
  }
  const deletedAt = Number(meta?.deletedAt) || (await fs.lstat(item).catch(() => null))?.mtimeMs || 0;
  if (meta && typeof meta.diskBytes === "number") return { id, deletedAt, disk: meta.diskBytes };
  let disk = 0;
  const top = await fs.lstat(item);
  const dev = top.dev;
  // a file with more than one link is counted once (the inodes seen are kept only for those: few, except in hard-linked snapshot trees)
  const linked = new Set<number | bigint>();
  const walk = async (d: string, depth: number): Promise<void> => {
    const h = await fs.opendir(d, { bufferSize: 64 }).catch(() => null);
    if (!h) return;
    try {
      for (let e; (e = await h.read()); ) {
        const st = await fs.lstat(path.join(d, e.name)).catch(() => null);
        if (!st || st.dev !== dev) continue;
        if (!st.isDirectory() && st.nlink > 1) {
          if (linked.has(st.ino)) continue;
          linked.add(st.ino);
        }
        disk += Number(st.blocks) * 512;
        if (st.isDirectory() && depth < 256) await walk(path.join(d, e.name), depth + 1);
      }
    } finally {
      await h.close().catch(() => undefined);
    }
  };
  disk += Number(top.blocks) * 512;
  await walk(item, 0);
  if (meta) {
    // a new file renamed over the old one: a failed or cut-short write never leaves an empty meta.json (the item could not be restored),
    // and a reader sees the old file or the new one. O_EXCL: never through a link put in its place.
    const tmpFile = path.join(item, `.meta-${process.pid}-${Date.now()}.json`);
    try {
      const fh = await fs.open(tmpFile, fsc.O_WRONLY | fsc.O_CREAT | fsc.O_EXCL | fsc.O_NOFOLLOW, 0o600);
      try {
        await fh.writeFile(JSON.stringify({ ...meta, diskBytes: disk }));
      } finally {
        await fh.close();
      }
      await fs.rename(tmpFile, metaFile);
    } catch {
      await fs.rm(tmpFile, { force: true }).catch(() => undefined); // measured again next time
    }
  }
  return { id, deletedAt, disk };
}

export interface RetentionPolicy {
  /** items deleted longer ago than this are purged (0 = never by age) */
  maxAgeDays: number;
  /** cap on a volume's trash, as a percent of the volume's size and in bytes (0 = none; with both, the smaller) */
  maxPercent: number;
  maxBytes: number;
  /** volumes the agent may not change (read-only prefixes) */
  blocked?: (volume: string) => boolean;
}

/**
 * Automatic trash retention, for every volume's trash: items older than `maxAgeDays` go, then, while the trash is bigger than its cap, the oldest go first.
 * The names are read a batch at a time; only the age and size of each item are kept for the cap (a few dozen bytes per item).
 */
export async function applyRetention(root: string, procMounts: string, p: RetentionPolicy): Promise<{ volume: string; removed: number; freed: number; failed: number }[]> {
  const out: { volume: string; removed: number; freed: number; failed: number }[] = [];
  for (const { volume, dir, real } of await trashVolumes(root, procMounts)) {
    if (p.blocked?.(volume)) continue;
    const r = { volume, removed: 0, freed: 0, failed: 0 };
    try {
      r.failed += await clearPurged(root, dir);
      if (p.maxAgeDays > 0) {
        const e = await emptyTrash(root, volume, p.maxAgeDays);
        r.removed += e.removed;
        r.failed += e.failed;
      }
      let cap = p.maxBytes > 0 ? p.maxBytes : Infinity;
      if (p.maxPercent > 0) {
        const sf = await fs.statfs(real);
        cap = Math.min(cap, (sf.blocks * sf.bsize * p.maxPercent) / 100);
      }
      if (cap !== Infinity) {
        const items: { id: string; deletedAt: number; disk: number }[] = [];
        let total = 0;
        for await (const names of namesOf(dir, 256, (n) => ID.test(n)))
          for (const id of names) {
            const u = await itemUsage(dir, id).catch(() => null);
            if (!u) continue;
            items.push(u);
            total += u.disk;
          }
        if (total > cap) {
          items.sort((a, b) => a.deletedAt - b.deletedAt);
          for (const it of items) {
            if (total <= cap) break;
            try {
              await removeItem(root, dir, it.id);
              total -= it.disk;
              r.removed++;
              r.freed += it.disk;
            } catch {
              // Oldest first, and never past an item that cannot go: else one undeletable old item would empty the rest of the trash,
              // newest included, at every sweep. It is tried again next time (its remains are a purge folder now).
              r.failed++;
              break;
            }
          }
        }
      }
    } catch {
      r.failed++;
    }
    if (r.removed || r.failed) out.push(r);
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

/**
 * Items that a restore or a removal works on now (`<trash dir>/<id>`). A second operation on the same item is refused instead of run alongside: a removal
 * that deletes through open folder handles would carry on inside data that a restore has just moved back to its place.
 */
const busy = new Set<string>();
async function withItem<T>(dir: string, id: string, fn: () => Promise<T>): Promise<T> {
  const key = dir + "/" + id;
  if (busy.has(key)) throw new ops.FsError(409, "the item is being restored or removed");
  busy.add(key);
  try {
    return await fn();
  } finally {
    busy.delete(key);
  }
}
/** prefix of an item that is being removed: renamed out of the list first, so a removal cut short leaves nothing that looks restorable */
const PURGE = ".purge-";

/** Remove one item folder of the trash store, entering it through descriptors (nothing inside is followed). The caller holds the item (`withItem`). */
const removeHeld = (root: string, dir: string, id: string) =>
  pinDirW(root, dir, async (at) => {
    const doomed = path.join(at, PURGE + id);
    try {
      await fs.rename(path.join(at, id), doomed);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return; // gone already (as rmTree with force said before)
      throw e;
    }
    await rmTree(doomed, { force: true, guard: walkGuard(root) });
  });
const removeItem = (root: string, dir: string, id: string) => withItem(dir, id, () => removeHeld(root, dir, id));

/** Removals cut short (a crash, an entry that could not be deleted): tried again by every sweep. */
async function clearPurged(root: string, dir: string): Promise<number> {
  let failed = 0;
  for await (const names of namesOf(dir, 256, (n) => n.startsWith(PURGE) && ID.test(n.slice(PURGE.length))))
    for (const n of names)
      await pinDirW(root, dir, (at) => rmTree(path.join(at, n), { force: true, guard: walkGuard(root) })).catch(() => failed++);
  return failed;
}

export async function restoreItems(root: string, volume: string, ids: unknown, opts: RestoreOpts = {}): Promise<TrashResult[]> {
  const dir = await trashDir(root, volume);
  const policy = opts.conflict ?? "fail";
  if (!["fail", "rename", "replace"].includes(policy)) throw bad("unknown conflict policy");
  const out: TrashResult[] = [];
  for (const id of checkIds(ids)) {
    try {
      out.push(await withItem(dir, id, () => restoreHeld(root, dir, id, policy, opts)));
    } catch (e) {
      out.push({ id, ok: false, error: ops.mapError(e).message });
    }
  }
  return out;
}

async function restoreHeld(root: string, dir: string, id: string, policy: string, opts: RestoreOpts): Promise<TrashResult> {
  {
    {
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
            await removeHeld(root, dir, id);
            warning = undefined;
          }
        } else await removeHeld(root, dir, id);
        return { id, ok: true, path: path.posix.join(path.posix.dirname(dest.virtual), final), ...(warning ? { warning } : {}) };
      });
      return res;
    }
  }
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
