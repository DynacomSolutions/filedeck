import fs from "node:fs/promises";
import { constants as fsc } from "node:fs";
import path from "node:path";
import * as ops from "./fsops.ts";
import { namesOf } from "./dirnames.ts";
import { networkKind, parseMounts, readMountTable } from "./mounts.ts";
import { TRASH_DIR, TRASH_OWNER, resolveWrite, virtualJoin } from "./paths.ts";
import { assertNotReserved, pinDirCreate, pinDirW, rmTree, walkGuard } from "./pinwalk.ts";
import { runInFolderAs } from "./account-dirs.ts";
import { renameNoReplace } from "./noreplace.ts";
import { sandboxInfo } from "./sandbox.ts";
import { trashScope } from "./trash-scope.ts";

export { setTrashScope, type TrashScope } from "./trash-scope.ts";

/**
 * Sign-in on, each account has its own folder in each volume's trash store (`.filedeck-trash/u<uid>/`, `.filedeck-trash/v-<owner>/`,
 * owned by the account, 0700; the root process makes it: `accountTrashDir`). A worker has a scope (`setTrashScope`) and works in its
 * own folder only, as its account. Without a scope (sign-in off, the root process) the whole store is seen: the items at its top, and
 * those of every owner folder with ids `<folder>/<id>`. `u0` (items trashed with sign-in off, moved there when the first account folder
 * was made) is the root process's own; what is in any other owner folder is only removed by a process that runs as the folder's owner
 * (`runInFolderAs`), never walked by this process.
 */

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

/** The account's own folder of a volume's trash store with a scope, else the store itself. */
async function scopeDir(root: string, volume: string): Promise<string> {
  const store = await trashDir(root, volume);
  const s = trashScope();
  if (!s) return store;
  const dir = path.join(store, s.folder);
  const st = await fs.lstat(dir).catch(() => null);
  if (!st?.isDirectory()) throw new ops.FsError(404, "no trash on this volume");
  return dir;
}

/** a trash id: the item's own name, and (no scope) the owner folder it is in ("" for the top of the store) */
interface ItemId {
  full: string;
  sub: string;
  id: string;
}
const parseId = (x: unknown, scoped: boolean): ItemId | null => {
  if (typeof x !== "string") return null;
  if (ID.test(x)) return { full: x, sub: "", id: x };
  const at = x.indexOf("/");
  if (scoped || at < 0) return null;
  const sub = x.slice(0, at);
  const id = x.slice(at + 1);
  return TRASH_OWNER.test(sub) && ID.test(id) ? { full: x, sub, id } : null;
};
const checkIds = (ids: unknown): ItemId[] => {
  const scoped = trashScope() !== null;
  const out = Array.isArray(ids) && ids.length > 0 && ids.length <= 10000 ? ids.map((x) => parseId(x, scoped)) : [null];
  if (out.some((x) => x === null)) throw bad("ids must be a non-empty array of trash ids");
  return out as ItemId[];
};

/** The folder that holds an item: the store (or scope folder) itself, or one of its owner folders, which must be a real folder. */
async function itemFolder(base: string, sub: string): Promise<string> {
  if (!sub) return base;
  const dir = path.join(base, sub);
  const st = await fs.lstat(dir).catch(() => null);
  if (!st?.isDirectory()) throw new ops.FsError(404, "no such item in the trash");
  return dir;
}

const myUid = () => process.getuid?.() ?? 0;

/**
 * Whether an owner folder belongs to an account (its contents are then changed only as its owner): decided by its owner, for every
 * folder (`u0` included): one that is this process's own (`u0`, or one whose hand-over failed) is not.
 */
async function ownedByAccount(dir: string, sub: string): Promise<boolean> {
  if (!sub) return false;
  return (await fs.lstat(dir)).uid !== myUid();
}

/** an account's item may only be renamed out of its folder: a copy would end with this process removing the account's files */
const notHere = () => new ops.FsError(409, "the item cannot be moved there in one step; restore it signed in as its account, or choose another folder");

/**
 * Moves an account's item `from` to `to` in one step that never replaces anything: the no-replace rename, or (without it) for a file a
 * hard link, which fails when the name is taken, and then the removal of the old name. A folder without the no-replace rename, or a
 * file that cannot be linked, is refused: a check followed by a plain rename could replace what appears in between. Never a copy (not
 * across mounts, also not across two bind mounts of one filesystem, where `rename` gives EXDEV too).
 */
async function renameOnly(from: string, to: string): Promise<void> {
  const r = await renameNoReplace(from, to);
  if (r === "done") return;
  if (r === "exists") throw new ops.FsError(409, "destination exists");
  if (r === "xdev") throw notHere();
  const unsafe = () => new ops.FsError(409, "cannot restore safely here (this machine cannot move a folder without the risk of replacing one)");
  if ((await fs.lstat(from)).isDirectory()) throw unsafe();
  try {
    await fs.link(from, to);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "EEXIST") throw new ops.FsError(409, "destination exists");
    if (code === "EXDEV") throw notHere();
    throw unsafe();
  }
  // (if the old name stays, the item's folder is removed as its owner next, with it)
  await fs.unlink(from).catch(() => undefined);
}

/**
 * What runs as the owner of an account's trash folder, in that folder (sign-in on; see `runInFolderAs`):
 * - `survey <0|1>`: removes what removals cut short left (`.purge-<id>`), and prints `{items: [[id, deletedAt, diskBytes]], failed}`;
 *   with 1 each item's disk use is measured (once: it is kept in its meta.json, as `itemUsage` does), else it is 0;
 * - `remove <id>...`: removes the items in that order (each renamed to `.purge-<id>` first), stops at the first that cannot go, and
 *   prints `{removed: [id...]}`.
 * Nothing in it follows a link out of the folder: meta.json is opened without following a link (at the item and at the file) and only
 * as a regular file, a removal does not follow links, and the walk enters only real folders on the folder's own device. Under Landlock
 * it can open nothing but the folder (`runInFolderAs`).
 */
const OWNER_SCRIPT = `
const fs=require("fs"),path=require("path"),C=fs.constants;
const ID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,P=".purge-";
const [mode,...a]=process.argv.slice(1);
const out=(o)=>process.stdout.write(JSON.stringify(o));
if(mode==="survey"){
  const disk=a[0]==="1",items=[];let failed=0;
  for(const n of fs.readdirSync(".")){
    if(n.startsWith(P)&&ID.test(n.slice(P.length))){try{fs.rmSync(n,{recursive:true,force:true})}catch{failed++}continue}
    if(!ID.test(n))continue;
    let st;try{st=fs.lstatSync(n)}catch{continue}
    let meta=null;
    if(st.isDirectory()){let d=-1,f=-1;
      try{d=fs.openSync(n,C.O_RDONLY|C.O_DIRECTORY|C.O_NOFOLLOW);f=fs.openSync("/proc/self/fd/"+d+"/meta.json",C.O_RDONLY|C.O_NOFOLLOW|C.O_NONBLOCK);
        const s=fs.fstatSync(f);if(s.isFile()&&s.size<=1048576)meta=JSON.parse(fs.readFileSync(f,"utf8"))}catch{}
      for(const x of [f,d])if(x>=0)try{fs.closeSync(x)}catch{}}
    const at=Number(meta&&meta.deletedAt)||st.mtimeMs||0;let d=0;
    if(disk){
      if(meta&&typeof meta.diskBytes==="number")d=meta.diskBytes;
      else{
        const dev=st.dev,seen=new Set();d=Number(st.blocks)*512;
        const walk=(p,depth)=>{let es;try{es=fs.readdirSync(p)}catch{return}
          for(const e of es){let s;try{s=fs.lstatSync(path.join(p,e))}catch{continue}
            if(s.dev!==dev)continue;
            if(!s.isDirectory()&&s.nlink>1){if(seen.has(s.ino))continue;seen.add(s.ino)}
            d+=Number(s.blocks)*512;
            if(s.isDirectory()&&depth<256)walk(path.join(p,e),depth+1)}};
        if(st.isDirectory())walk(n,0);
        if(meta){const t=path.join(n,".meta-"+process.pid+"-"+Date.now()+".json");
          try{fs.writeFileSync(t,JSON.stringify({...meta,diskBytes:d}),{flag:"wx",mode:0o600});fs.renameSync(t,path.join(n,"meta.json"))}catch{try{fs.rmSync(t,{force:true})}catch{}}}
      }
    }
    items.push([n,at,d]);
  }
  out({items,failed});
}else if(mode==="remove"){
  const removed=[];
  for(const id of a){
    if(!ID.test(id))break;
    try{fs.renameSync(id,P+id)}catch(e){if(e.code!=="ENOENT"){console.error(e.message);break}removed.push(id);continue}
    try{fs.rmSync(P+id,{recursive:true,force:true})}catch(e){console.error(e.message);break}
    removed.push(id);
  }
  out({removed});
}else process.exit(2);
`;
/** how long one run as an account may take (a survey measures every item once) */
const OWNER_MS = 10 * 60_000;
/** ids per removal run (the list goes on its command line) */
const OWNER_BATCH = 1000;

/**
 * A virtual account's folder belongs to its runAs account, which may serve several virtual accounts: the script may run there only
 * under Landlock (limited to that folder). Without it such a folder is left alone.
 */
export class NeedsSandbox extends ops.FsError {
  constructor(dir: string) {
    super(409, `${path.basename(dir)}: a virtual account's trash folder needs the sandbox (Landlock) to be changed here`);
  }
}
const needsSandbox = async (dir: string) => path.basename(dir).startsWith("v-") && (await sandboxInfo()).state !== "landlock";

/** Runs `OWNER_SCRIPT` as the owner of `dir` (an account's trash folder) and gives back what it printed. */
async function asOwner(dir: string, args: string[]): Promise<unknown> {
  if (await needsSandbox(dir)) throw new NeedsSandbox(dir);
  const st = await fs.lstat(dir);
  if (!st.isDirectory()) throw new Error(`${dir} is not a folder`);
  const r = await runInFolderAs(dir, st.uid, st.gid, OWNER_SCRIPT, args, { timeoutMs: OWNER_MS, maxOut: 256 << 20 });
  if (r.code !== 0) throw new Error(`as its owner: ${r.code === null ? "stopped" : `exit ${r.code}`}${r.err ? `: ${r.err}` : ""}`);
  return JSON.parse(r.out);
}

/** Whether a folder has no entries (its names only are read). */
async function isEmpty(dir: string): Promise<boolean> {
  const h = await fs.opendir(dir, { bufferSize: 1 });
  try {
    return (await h.read()) === null;
  } finally {
    await h.close().catch(() => undefined);
  }
}

/** The items of an account's trash folder, as its owner sees them (and what earlier removals left is cleared). */
async function surveyAs(dir: string, disk: boolean): Promise<{ items: { id: string; deletedAt: number; disk: number }[]; failed: number }> {
  const o = (await asOwner(dir, ["survey", disk ? "1" : "0"])) as { items?: unknown; failed?: unknown };
  const items = Array.isArray(o.items) ? o.items : [];
  return {
    items: items.flatMap((x) => (Array.isArray(x) && typeof x[0] === "string" && ID.test(x[0]) ? [{ id: x[0], deletedAt: Number(x[1]) || 0, disk: Number(x[2]) || 0 }] : [])),
    failed: Number(o.failed) || 0,
  };
}

/** Removes items of an account's trash folder as its owner, in order, up to the first that cannot go; the ids removed. */
async function removeAs(dir: string, ids: string[]): Promise<string[]> {
  const done: string[] = [];
  for (let i = 0; i < ids.length; i += OWNER_BATCH) {
    const part = ids.slice(i, i + OWNER_BATCH);
    const o = (await asOwner(dir, ["remove", ...part])) as { removed?: unknown };
    const got = Array.isArray(o.removed) ? o.removed.filter((x): x is string => typeof x === "string" && part.includes(x)) : [];
    done.push(...got);
    if (got.length < part.length) break;
  }
  return done;
}

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

/**
 * An item's meta.json, read without following a link at the item or at the file (an owner folder is its account's, and this may be the
 * root process). At most 1 MiB.
 */
async function readMeta(dir: string, id: string): Promise<ops.TrashMeta> {
  const item = await fs.open(path.join(dir, id), fsc.O_RDONLY | fsc.O_DIRECTORY | fsc.O_NOFOLLOW);
  try {
    const fh = await fs.open(`/proc/self/fd/${item.fd}/meta.json`, fsc.O_RDONLY | fsc.O_NOFOLLOW | fsc.O_NONBLOCK);
    try {
      const st = await fh.stat();
      if (!st.isFile() || st.size > 1 << 20) throw new Error("bad meta");
      return JSON.parse(await fh.readFile("utf8")) as ops.TrashMeta;
    } finally {
      await fh.close();
    }
  } finally {
    await item.close();
  }
}

async function readItem(dir: string, id: string): Promise<TrashItem> {
  try {
    const m = await readMeta(dir, id);
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

/** The owner folders of a trash store (real folders whose name is `TRASH_OWNER`), sorted. */
async function ownerFolders(store: string): Promise<{ sub: string; dir: string }[]> {
  const out: { sub: string; dir: string }[] = [];
  for (const sub of (await fs.readdir(store)).filter((n) => TRASH_OWNER.test(n)).sort()) {
    const dir = path.join(store, sub);
    if ((await fs.lstat(dir).catch(() => null))?.isDirectory()) out.push({ sub, dir });
  }
  return out;
}

/**
 * Every volume of this node that has a trash store: the root plus each real mount point. With a scope, only the volumes where the
 * account has a folder, and only its items; without one, the items at the top of each store and those of every owner folder (ids
 * `<folder>/<id>`), at most `MAX_TRASH_ITEMS` per volume.
 */
export async function listTrash(root: string, procMounts: string): Promise<TrashVolume[]> {
  const out: TrashVolume[] = [];
  const s = trashScope();
  for (const { volume, dir } of await trashVolumes(root, procMounts)) {
    try {
      if (s) {
        const own = path.join(dir, s.folder);
        if ((await fs.lstat(own).catch(() => null))?.isDirectory()) out.push({ volume, ...(await readItems(own)) });
        continue;
      }
      const v = { volume, ...(await readItems(dir)) };
      for (const { sub, dir: d } of await ownerFolders(dir)) {
        if (v.truncated) break;
        const r = await readItems(d).catch(() => null);
        if (!r) continue;
        v.items.push(...r.items.map((i) => ({ ...i, id: `${sub}/${i.id}` })));
        if (r.truncated || v.items.length > MAX_TRASH_ITEMS) {
          v.truncated = true;
          v.items.length = Math.min(v.items.length, MAX_TRASH_ITEMS);
        }
      }
      out.push(v);
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
    meta = await readMeta(dir, id); // (never through a link)
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
  /** called with the `deletedAt` of every item that is still there after the age step (the caller sets its next deadline from the oldest) */
  seen?: (deletedAt: number) => void;
}

/**
 * Automatic trash retention, for every volume's trash: items older than `maxAgeDays` go, then, while the trash is bigger than its cap, the oldest go first.
 * The names are read a batch at a time; only the age and size of each item are kept for the cap (a few dozen bytes per item).
 *
 * Every folder of a store counts (its top, `u0`, and each account's folder), and the cap is for the whole store. The top and `u0` are
 * this process's own; an account's folder is measured and cleared by a process that runs as its owner (`surveyAs`, `removeAs`). Oldest
 * first, and in each folder never past an item that cannot go.
 */
export async function applyRetention(root: string, procMounts: string, p: RetentionPolicy): Promise<{ volume: string; removed: number; freed: number; failed: number }[]> {
  const out: { volume: string; removed: number; freed: number; failed: number }[] = [];
  for (const { volume, dir, real } of await trashVolumes(root, procMounts)) {
    if (p.blocked?.(volume)) continue;
    const r = { volume, removed: 0, freed: 0, failed: 0 };
    try {
      let cap = p.maxBytes > 0 ? p.maxBytes : Infinity;
      if (p.maxPercent > 0) {
        const sf = await fs.statfs(real);
        cap = Math.min(cap, (sf.blocks * sf.bsize * p.maxPercent) / 100);
      }
      const cutoff = p.maxAgeDays > 0 ? Date.now() - p.maxAgeDays * 86400_000 : -Infinity;
      /** what is left after the age step, for the cap: one entry per item, with the folder it is in */
      const items: { id: string; deletedAt: number; disk: number; f: number }[] = [];
      const folders = [{ sub: "", dir }, ...(await ownerFolders(dir))];
      const account: boolean[] = [];
      /** virtual accounts' folders left alone (no Landlock here) */
      const skipped: string[] = [];
      for (const [k, f] of folders.entries()) {
        try {
          account[k] = await ownedByAccount(f.dir, f.sub);
          if (account[k]) {
            if (await isEmpty(f.dir)) continue; // (no process to start for an empty folder)
            if (await needsSandbox(f.dir)) {
              account[k] = false;
              skipped.push(f.sub);
              folders[k] = { sub: f.sub, dir: "" }; // (left out of the cap too)
              continue;
            }
            const sv = await surveyAs(f.dir, cap !== Infinity);
            r.failed += sv.failed;
            const old = sv.items.filter((i) => i.deletedAt <= cutoff).map((i) => i.id);
            const gone = new Set(old.length ? await removeAs(f.dir, old) : []);
            r.removed += gone.size;
            r.failed += old.length - gone.size;
            for (const i of sv.items) if (!gone.has(i.id) && !old.includes(i.id)) {
              p.seen?.(i.deletedAt);
              if (cap !== Infinity) items.push({ ...i, f: k });
            }
            continue;
          }
          r.failed += await clearPurged(root, f.dir);
          if (p.maxAgeDays > 0) {
            const e = await emptyDir(root, f.dir, cutoff, p.seen);
            r.removed += e.removed;
            r.failed += e.failed;
          }
          if (cap !== Infinity)
            for await (const names of namesOf(f.dir, 256, (n) => ID.test(n)))
              for (const id of names) {
                const u = await itemUsage(f.dir, id).catch(() => null);
                if (u) items.push({ ...u, f: k });
              }
        } catch {
          r.failed++;
        }
      }
      if (skipped.length) console.error(JSON.stringify({ trashRetention: volume, skipped: skipped.join(" "), reason: "a virtual account's trash folder needs the sandbox (Landlock)" }));
      let total = items.reduce((t, i) => t + i.disk, 0);
      if (total > cap) {
        items.sort((a, b) => a.deletedAt - b.deletedAt);
        // the oldest, until what is left fits; then removed folder by folder, in that order
        const doomed: typeof items = [];
        for (const it of items) {
          if (total <= cap) break;
          doomed.push(it);
          total -= it.disk;
        }
        for (const [k, f] of folders.entries()) {
          const mine = doomed.filter((i) => i.f === k);
          if (!mine.length || !f.dir) continue;
          if (account[k]) {
            const gone = new Set(await removeAs(f.dir, mine.map((i) => i.id)).catch(() => [] as string[]));
            for (const i of mine) if (gone.has(i.id)) (r.removed++, (r.freed += i.disk));
            if (gone.size < mine.length) r.failed++;
            continue;
          }
          for (const it of mine) {
            try {
              await removeItem(root, f.dir, it.id);
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
  const base = await scopeDir(root, volume);
  const policy = opts.conflict ?? "fail";
  if (!["fail", "rename", "replace"].includes(policy)) throw bad("unknown conflict policy");
  const out: TrashResult[] = [];
  for (const x of checkIds(ids)) {
    try {
      const dir = await itemFolder(base, x.sub);
      const account = await ownedByAccount(dir, x.sub);
      out.push({ ...(await withItem(dir, x.id, () => restoreHeld(root, dir, x.id, policy, opts, account))), id: x.full });
    } catch (e) {
      out.push({ id: x.full, ok: false, error: ops.mapError(e).message });
    }
  }
  return out;
}

/** `account`: the item is in an account's folder (no scope): its data is only renamed out, and what is left is removed as the owner. */
async function restoreHeld(root: string, dir: string, id: string, policy: string, opts: RestoreOpts, account = false): Promise<TrashResult> {
  {
    {
      // an account's meta.json is the account's to write: without a scope its item goes only where the admin says
      if (account && !opts.toDir) throw new ops.FsError(403, "this item is in an account's trash folder: restore it signed in as its account, or choose a folder");
      const meta = await readMeta(dir, id);
      const data = path.join(dir, id, "data");
      await fs.lstat(data);
      const target = opts.toDir ? virtualJoin(resolveWrite(root, opts.toDir).virtual, meta.name) : meta.originalPath;
      const dest = resolveWrite(root, target);
      assertNotReserved(dest.virtual);
      if (dest.virtual === "/") throw bad("cannot restore onto the root");
      if (opts.blocked?.(dest.virtual)) throw new ops.FsError(403, "read-only volume");
      const s = trashScope();
      if (s?.mayRestore && !s.mayRestore(dest.virtual)) throw new ops.FsError(403, "outside your folders");
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
        if (account) {
          // only a rename (a copy across mounts would end with this process removing the account's files)
          await pinDirW(root, path.join(dir, id), (srcAt) => renameOnly(path.join(srcAt, "data"), path.join(dstAt, final)));
          if ((await removeAs(dir, [id])).length !== 1) warning = "The item is restored. Its folder in the trash could not be removed; it is still listed there.";
          return { id, ok: true, path: path.posix.join(path.posix.dirname(dest.virtual), final), ...(warning ? { warning } : {}) };
        }
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
  const base = await scopeDir(root, volume);
  const out: TrashResult[] = [];
  for (const x of checkIds(ids)) {
    try {
      const dir = await itemFolder(base, x.sub);
      if (await ownedByAccount(dir, x.sub))
        await withItem(dir, x.id, async () => {
          if (await needsSandbox(dir)) throw new NeedsSandbox(dir);
          if ((await removeAs(dir, [x.id])).length !== 1) throw new ops.FsError(500, "the item could not be removed");
        });
      else await removeItem(root, dir, x.id);
      out.push({ id: x.full, ok: true });
    } catch (e) {
      out.push({ id: x.full, ok: false, error: ops.mapError(e).message });
    }
  }
  return out;
}

/**
 * Delete everything in a volume's trash, or only items deleted more than `olderThanDays` ago. With a scope, the account's own folder;
 * without one, the whole store (each account's folder as its owner).
 */
export async function emptyTrash(root: string, volume: string, olderThanDays?: number): Promise<{ removed: number; failed: number }> {
  const base = await scopeDir(root, volume);
  const cutoff = olderThanDays !== undefined ? Date.now() - olderThanDays * 86400_000 : Infinity;
  if (olderThanDays !== undefined && !(olderThanDays >= 0)) throw bad("olderThanDays must be >= 0");
  const sum = await emptyDir(root, base, cutoff);
  if (trashScope()) return sum;
  const left: string[] = [];
  for (const f of await ownerFolders(base)) {
    try {
      if (!(await ownedByAccount(f.dir, f.sub))) {
        const e = await emptyDir(root, f.dir, cutoff);
        sum.removed += e.removed;
        sum.failed += e.failed;
        continue;
      }
      if (await needsSandbox(f.dir)) {
        left.push(f.sub);
        continue;
      }
      const old = (await surveyAs(f.dir, false)).items.filter((i) => cutoff === Infinity || i.deletedAt <= cutoff).map((i) => i.id);
      const gone = old.length ? await removeAs(f.dir, old) : [];
      sum.removed += gone.length;
      sum.failed += old.length - gone.length;
    } catch {
      sum.failed++;
    }
  }
  if (left.length) throw new ops.FsError(409, `the rest was emptied (${sum.removed} removed); ${left.join(", ")} needs the sandbox (Landlock) to be emptied here`);
  return sum;
}

/** Removes the items of one folder this process may change (the top of a store, `u0`, or a scope's own folder) deleted before `cutoff` (Infinity: all). */
async function emptyDir(root: string, dir: string, cutoff: number, seen?: (deletedAt: number) => void): Promise<{ removed: number; failed: number }> {
  let removed = 0;
  let failed = 0;
  // Every item is judged on its own age, however many there are (the listing is capped, the sweep is not).
  for await (const names of namesOf(dir, 256, (n) => ID.test(n))) {
    const ages = cutoff === Infinity ? null : await Promise.all(names.map((id) => readItem(dir, id)));
    for (const [k, id] of names.entries()) {
      if (ages && (ages[k] as TrashItem).deletedAt > cutoff) {
        seen?.((ages[k] as TrashItem).deletedAt);
        continue;
      }
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
