import { createHash } from "node:crypto";
import fsc from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { UserClaim } from "./auth/identity.ts";
import type { Config } from "./config.ts";
import type { LocalAccount } from "./local-accounts.ts";
import { openChecked, resolveRead } from "./paths.ts";
import { sandboxInfo, spawnSandboxed, type Root } from "./sandbox.ts";

/**
 * The folders of an account's worker, and the Landlock rules of a virtual account's worker (sign-in part 2).
 *
 * - `tmp` (the worker's TMPDIR and HOME): `<area>/<key folder>/tmp`, below an area made new for each agent (root's alone, 0711). It goes
 *   when the agent stops.
 * - `thumbs`: `<FILEDECK_THUMB_DIR>/u<uid>`, one per uid (accounts with one uid have the same rights, so they may share the cache).
 * - `index`: `<FILEDECK_INDEX_DIR>/accounts/<key folder>` (none without an index folder: the worker then keeps its index in its `tmp`).
 *   A virtual account's key folder holds a hash of its grants, so a listing cached under old grants is never served under new ones.
 * Both caches survive a restart of the agent. Their parents (`<FILEDECK_THUMB_DIR>` and `<FILEDECK_INDEX_DIR>/accounts`) must be this
 * process's (root's) and not writable by group or others; they are made 0711 when missing.
 *
 * Rules for every account folder (the area is root's, and so are the parents of the caches, so only the last path part can change):
 * - a folder this call makes is set up while it is still this process's own, through a descriptor opened without following a link, and
 *   handed to the account last;
 * - a folder that is there already is never changed: it must be the account's and not writable by group or others, else `UnsafeFolders`
 *   (the gate answers 503 "worker folders are not safe");
 * - root never walks into a folder an account owns: such a folder is emptied by a process that runs as the account, and root only removes
 *   the empty folder (`emptyAs`).
 */

/** A worker folder that this process did not make just now is not the account's own and private, or is not a folder at all. */
export class UnsafeFolders extends Error {
  constructor(why: string) {
    super(why);
    this.name = "UnsafeFolders";
  }
}

export const OPEN_DIR = fsc.constants.O_RDONLY | fsc.constants.O_DIRECTORY | fsc.constants.O_NOFOLLOW;

/** Called after each mkdir (tests swap things in there). */
export type Hook = (step: "key" | "tmp" | "thumbs" | "index", p: string) => void | Promise<void>;

/** The folders of one worker. `index` is empty when the agent has no index folder. */
export interface AccountDirs {
  tmp: string;
  thumbs: string;
  index: string;
}

/** Opens a folder without following a link; a link, a file or a missing entry is `UnsafeFolders`. */
export async function openFolder(dir: string, shown = dir): Promise<fs.FileHandle> {
  try {
    return await fs.open(dir, OPEN_DIR);
  } catch (e) {
    throw new UnsafeFolders(`${shown}: ${(e as NodeJS.ErrnoException).code ?? (e as Error).message}`);
  }
}

/** `UnsafeFolders` unless the folder's owner is `uid` and its mode lets nobody else in (`mask`: the bits that must be clear). */
async function expect(fh: fs.FileHandle, dir: string, uid: number, mask: number): Promise<void> {
  const st = await fh.stat();
  if (st.uid !== uid || (st.mode & mask) !== 0) throw new UnsafeFolders(`${dir} has owner ${st.uid} and mode ${(st.mode & 0o7777).toString(8)}; expected owner ${uid}`);
}

const myUid = () => process.getuid?.() ?? 0;

/** Gives a folder this process has just made to the account, through its descriptor (owner only as root), mode 0700. */
async function give(fh: fs.FileHandle, account: LocalAccount): Promise<void> {
  if (myUid() === 0) await fh.chown(account.uid, account.gid);
  await fh.chmod(0o700);
}

/**
 * The key folder of an account below the workers' area, and its `tmp`, both 0700 and the account's.
 *
 * A new key folder is made and filled while it is still this process's own: the key folder, then `tmp` (made, opened without following a
 * link, checked to be ours and closed to others, then given to the account through the descriptor), and only then the key folder itself is
 * given to the account (through the descriptor opened right after its mkdir). The area is root's alone (0711), so no one else can make or
 * swap anything in it or in the new key folder meanwhile; the checks after each open are a second guard.
 *
 * A key folder that is already there is never changed: it and its `tmp` must be the account's and not writable by group or others, else
 * `UnsafeFolders`. A `tmp` missing there is refused too, not made: the key folder is the account's by then, so a folder made in it could be
 * swapped between the mkdir and the open.
 */
export async function keyFolder(dir: string, account: LocalAccount, hook?: Hook): Promise<string> {
  const me = myUid();
  const tmp = path.join(dir, "tmp");
  let made = true;
  try {
    await fs.mkdir(dir, { mode: 0o700 });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    made = false;
  }
  if (!made) {
    for (const d of [dir, tmp]) {
      const fh = await openFolder(d);
      try {
        await expect(fh, d, account.uid, 0o022);
      } finally {
        await fh.close();
      }
    }
    return tmp;
  }
  await hook?.("key", dir);
  const key = await openFolder(dir);
  try {
    await expect(key, dir, me, 0o077);
    await fs.mkdir(tmp, { mode: 0o700 }).catch((e: NodeJS.ErrnoException) => {
      throw e.code === "EEXIST" ? new UnsafeFolders(`${tmp} is there already`) : e;
    });
    await hook?.("tmp", tmp);
    const fh = await openFolder(tmp);
    try {
      await expect(fh, tmp, me, 0o077);
      await give(fh, account);
    } finally {
      await fh.close();
    }
    await give(key, account); // last: from here on the account may change what is in it
  } finally {
    await key.close();
  }
  return tmp;
}

/**
 * The parent of persistent account folders (`<thumbDir>`, `<indexDir>/accounts`), opened without following a link at its last part and held:
 * it must be this process's (root's) and not writable by group or others, else `UnsafeFolders`. A missing one is made 0711 (with its missing
 * parents). One that lacks the search bits for others gets them (it is ours, and the workers must pass through it to their folders).
 */
async function cacheParent(dir: string): Promise<fs.FileHandle> {
  await fs.mkdir(dir, { recursive: true, mode: 0o711 });
  const fh = await openFolder(dir);
  try {
    const st = await fh.stat();
    if (st.uid !== myUid() || (st.mode & 0o022) !== 0) throw new UnsafeFolders(`${dir} has owner ${st.uid} and mode ${(st.mode & 0o7777).toString(8)}; it must be this process's (${myUid()}) and not writable by group or others`);
    if ((st.mode & 0o011) !== 0o011) await fh.chmod((st.mode & 0o7777) | 0o011);
    return fh;
  } catch (e) {
    await fh.close();
    throw e;
  }
}

/** The path that names `name` in the folder held by `fh`: a later swap of any part of the parent's path changes nothing. */
const inHeld = (fh: fs.FileHandle, name: string) => `/proc/self/fd/${fh.fd}/${name}`;

/**
 * `<parent>/<name>`, the account's own (0700), made when missing. The parent is checked and held (`cacheParent`); the folder is made and
 * opened through it. A new folder is ours until it is handed over through its descriptor; an existing one must already be the account's and
 * not writable by group or others, and is never changed.
 */
export async function cacheDir(parent: string, name: string, account: LocalAccount, step: "thumbs" | "index", hook?: Hook): Promise<string> {
  const shown = path.join(parent, name);
  const p = await cacheParent(parent);
  try {
    let made = true;
    try {
      await fs.mkdir(inHeld(p, name), { mode: 0o700 });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      made = false;
    }
    if (made) await hook?.(step, shown);
    const fh = await openFolder(inHeld(p, name), shown);
    try {
      if (made) {
        await expect(fh, shown, myUid(), 0o077);
        await give(fh, account);
      } else await expect(fh, shown, account.uid, 0o022);
    } finally {
      await fh.close();
    }
  } finally {
    await p.close();
  }
  return shown;
}

/**
 * The owner part of a virtual account's folder names (`v-<this>`, also its trash folder): its name when it fits the folder name rule
 * (Task 8's `TRASH_OWNER`), else `h` and 16 hex of its hash.
 */
export function virtOwner(name: string): string {
  return /^[a-z_][a-z0-9_.-]{0,31}$/.test(name) ? name : `h${createHash("sha256").update(name).digest("hex").slice(0, 16)}`;
}

/** The trash folder of an account: `u<uid>` for a system account, `v-<owner>` for a virtual one. */
export function trashFolder(claim: UserClaim, account: LocalAccount): string {
  return claim.kind === "sys" ? `u${account.uid}` : `v-${virtOwner(claim.name)}`;
}

/**
 * The folder name of one key (in the workers' area and in the index folder): the trash folder name, and for a virtual account its grants
 * hash as well. Two system names with one uid share `u<uid>` (they are the same user to the kernel).
 */
export function keyDir(claim: UserClaim, account: LocalAccount, key: string): string {
  const owner = trashFolder(claim, account);
  return claim.kind === "sys" ? owner : `${owner}-${key.slice(key.lastIndexOf(":") + 1)}`;
}

/** The folder name of a `virt:<name>:<hash>` key (null for any other key). */
export function virtKeyDir(key: string): string | null {
  const m = /^virt:(.*):([0-9a-f]{16})$/.exec(key);
  return m ? `v-${virtOwner(m[1]!)}-${m[2]}` : null;
}

/** what the removal runs as a folder's owner, in that folder (its working folder): removes everything in it, and exits 1 if anything is left */
const EMPTY_SCRIPT =
  'const fs=require("fs");let bad=0;' +
  'for(const n of fs.readdirSync(".")){try{fs.rmSync(n,{recursive:true,force:true})}catch(e){bad++;console.error(e.message)}}' +
  "process.exit(bad?1:0)";
const EMPTY_MS = 30_000;

/**
 * Empties `dir` as its owner `uid`/`gid`: through the sandbox launcher, which gets the folder as its working folder by descriptor (opened
 * here without following a link), so the removal never resolves a path through folders it may not pass (a key folder still root's).
 * Without a change of user (the owner is this process, not root) it is done here. True when the folder is empty.
 */
export async function emptyAs(dir: string, uid: number, gid: number, log: (s: string) => void): Promise<boolean> {
  const me = myUid();
  if (uid === me && me !== 0) {
    let ok = true;
    for (const n of await fs.readdir(dir)) await fs.rm(path.join(dir, n), { recursive: true, force: true }).catch((e: Error) => ((ok = false), log(`workers' area: ${e.message}`)));
    if (!ok) log(`workers' area: ${dir} could not be emptied; left`);
    return ok;
  }
  if (uid === 0 || gid === 0) {
    log(`workers' area: ${dir} has owner ${uid}:${gid}; left`);
    return false;
  }
  let fh: fs.FileHandle | undefined;
  try {
    fh = await fs.open(dir, OPEN_DIR);
    const st = await fh.stat();
    if (st.uid !== uid) throw new Error(`its owner changed to ${st.uid}`);
    const child = await spawnSandboxed(process.execPath, ["-e", EMPTY_SCRIPT], {
      uid,
      gid,
      landlock: false,
      cwdFd: fh.fd,
      stdio: ["ignore", "ignore", "pipe"],
      env: { PATH: process.env.PATH || "/usr/bin:/bin", LANG: "C.UTF-8" },
    });
    await fh.close();
    fh = undefined;
    let err = "";
    child.stderr?.on("data", (d: Buffer) => {
      if (err.length < 500) err += d.toString("utf8");
    });
    const code = await new Promise<number | null>((res) => {
      const t = setTimeout(() => child.kill("SIGKILL"), EMPTY_MS);
      t.unref();
      child.once("error", () => (clearTimeout(t), res(null)));
      child.once("exit", (c) => (clearTimeout(t), res(c)));
    });
    if (code === 0) return true;
    log(`workers' area: emptying ${dir} as ${uid} failed (${code === null ? "stopped" : `exit ${code}`}): ${err.trim().slice(0, 500)}; left`);
  } catch (e) {
    log(`workers' area: emptying ${dir} as ${uid} failed: ${(e as Error).message}; left`);
  } finally {
    await fh?.close().catch(() => {});
  }
  return false;
}

/**
 * Removes one entry of a folder that is this process's own (so the entry cannot be swapped under us): a link or a file is unlinked (that
 * follows nothing), a folder still this process's own as root is walked by `own`, and a folder of another owner is emptied as that owner
 * (`emptyAs`) and then removed with `rmdir`. False when it is left (logged).
 */
async function removeEntry(p: string, log: (s: string) => void, own: (p: string) => Promise<void>, onEmpty?: (dir: string) => void): Promise<boolean> {
  try {
    const st = await fs.lstat(p);
    if (!st.isDirectory()) await fs.unlink(p);
    else if (myUid() === 0 && st.uid === 0) await own(p);
    else if ((onEmpty?.(p), await emptyAs(p, st.uid, st.gid, log))) await fs.rmdir(p);
    else return false;
    return true;
  } catch (e) {
    log(`workers' area: ${p}: ${(e as Error).message}; left`);
    return false;
  }
}

/**
 * Removes the workers' area without ever walking a folder that an account owns: an account could swap a folder in it for a link while
 * root walks it by path, and root would then remove what the link points to. A folder owned by someone else (a key folder or its
 * subfolders) is emptied by a process that runs as its owner, and then only the empty folder is removed here (`rmdir`, in a folder
 * that is this process's own, so the entry cannot be swapped). Only this process's own folders are listed here. Whatever cannot be
 * removed is logged and left; there is no fallback to a removal by root.
 */
export async function removeArea(dir: string, log: (s: string) => void, onList?: (dir: string) => void, onEmpty?: (dir: string) => void): Promise<void> {
  onList?.(dir);
  let names: string[] = [];
  try {
    names = await fs.readdir(dir);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
    log(`workers' area: ${dir}: ${(e as Error).message}; left`);
  }
  // (a key folder still root's: its start failed half-way, so it is root's alone and is walked like the area)
  for (const n of names) await removeEntry(path.join(dir, n), log, (p) => removeArea(p, log, onList, onEmpty), onEmpty);
  await fs.rmdir(dir).catch((e: NodeJS.ErrnoException) => {
    if (e.code !== "ENOENT") log(`workers' area: ${dir}: ${e.message}; left`);
  });
}

/**
 * Removes the index folders of a virtual account's earlier grants (`v-<owner>-<hash>` in `<indexDir>/accounts`, other than `keep`), unless
 * `inUse` says a worker still uses one. Each is removed the safe way (`removeEntry`: emptied as its owner, then `rmdir` here). Never throws.
 */
export async function removeOldIndexDirs(accounts: string, owner: string, keep: string, inUse: (name: string) => boolean, log: (s: string) => void): Promise<string[]> {
  const re = new RegExp(`^v-${owner.replace(/[.]/g, "\\.")}-[0-9a-f]{16}$`);
  const gone: string[] = [];
  let names: string[];
  try {
    names = await fs.readdir(accounts);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") log(`index folders: ${accounts}: ${(e as Error).message}`);
    return gone;
  }
  for (const n of names) {
    if (n === keep || !re.test(n) || inUse(n)) continue;
    // (a folder still root's is one whose hand-over failed: nothing of the account's is in it, so only an empty one is removed)
    const own = (p: string) => fs.rmdir(p);
    if (await removeEntry(path.join(accounts, n), (s) => log(s.replace("workers' area", "index folders")), own)) gone.push(n);
  }
  return gone;
}

/** The Landlock roots of a virtual account's worker, as the launcher takes them. `release` closes the descriptors once the start is over. */
export interface LandlockRoots {
  readOnly: Root[];
  readWrite: Root[];
  readExec: Root[];
  release(): void;
}

/** the folders the launcher already allows to every confined program (see filedeck-sandbox.c): what lies below them needs no rule here */
const SYSTEM = ["/usr", "/lib", "/lib64", "/bin", "/sbin"];
const underSystem = (p: string) => SYSTEM.some((s) => p === s || p.startsWith(s + "/"));
const exists = (p: string) => fs.stat(p).then(() => true, () => false);

/**
 * What a worker needs to run, beside the launcher's own system folders (the same for every worker, so found once):
 * - read only: the server package (its code), each `node_modules` folder Node may load from (the package's and those of its parents, as a
 *   workspace has), OpenSSL's configuration (Node does not start when it exists and cannot be read), `/dev/urandom` (7-Zip opens it) and
 *   the worker's own `/proc/self` (its memory cgroup, its status);
 * - read and execute: the Node program when it is not below the system folders (a version manager's), and the sandbox launcher the
 *   worker starts its helpers through when it is not there either (development; in the image both are below /usr). Run from source
 *   (development), the `node_modules` folders are read and execute instead: tsx starts esbuild's program from there.
 * The helpers themselves (git, bsdtar, 7zz, ffmpeg, qpdf) are below /usr in the image, which the launcher allows already.
 */
let runtime: Promise<{ readOnly: string[]; readExec: string[] }> | undefined;
export function runtimeRoots(): Promise<{ readOnly: string[]; readExec: string[] }> {
  runtime ??= (async () => {
    const pkg = path.resolve(import.meta.dirname, "..");
    const readOnly = [pkg];
    const readExec: string[] = [];
    const fromSource = import.meta.url.endsWith(".ts");
    for (let d = pkg; ; d = path.dirname(d)) {
      const nm = path.join(d, "node_modules");
      if (await exists(nm)) (fromSource ? readExec : readOnly).push(nm);
      if (d === path.dirname(d)) break;
    }
    for (const f of ["/etc/ssl/openssl.cnf", "/dev/urandom"]) if (await exists(f)) readOnly.push(f);
    // (by path, opened by the launcher: `/proc/self` is then the launcher's own folder there, which is the worker's after the exec)
    readOnly.push("/proc/self");
    // the program file alone, not its folder or an install prefix guessed from it (`<home>/bin/node` would give the whole home folder);
    // it loads its libraries from the system folders
    const node = await fs.realpath(process.execPath);
    if (!underSystem(node)) readExec.push(node);
    const helper = (await sandboxInfo()).helper;
    if (helper) {
      const real = await fs.realpath(helper).catch(() => null);
      if (real && !underSystem(real)) readExec.push(real);
    }
    return { readOnly, readExec };
  })();
  runtime.catch(() => (runtime = undefined));
  return runtime;
}

/**
 * The Landlock roots of a virtual account's worker:
 * - each grant, resolved inside the served root (`resolveRead`: links in it are followed and kept inside the root, so a grant names the folder
 *   it leads to at this moment) and opened as a folder without following a link at the last step, checked to be inside the root; read and
 *   write when the grant allows writing, else read only. A grant that cannot be opened (missing, not a folder, Filedeck's own) is left out
 *   and logged: the worker gets less, never more.
 * - read and write: the worker's own folders (`dirs`), opened the same way.
 * - read only: the mount table (`cfg.procMounts`, for the volumes and the read-only checks), and `runtimeRoots`.
 * Grants and folders are passed as descriptors, so the rule is attached to what was opened here, whatever happens to the path later.
 */
export async function landlockRoots(cfg: Config, claim: UserClaim, dirs: AccountDirs, log: (s: string) => void = (s) => console.error(s)): Promise<LandlockRoots> {
  const held: fs.FileHandle[] = [];
  const release = () => {
    for (const fh of held.splice(0)) void fh.close().catch(() => {});
  };
  try {
    const readOnly: Root[] = [];
    const readWrite: Root[] = [];
    const readExec: Root[] = [];
    for (const g of claim.grants ?? []) {
      try {
        const r = resolveRead(cfg.root, g.path);
        const fh = await openChecked(cfg.root, r.real, fsc.constants.O_RDONLY | fsc.constants.O_DIRECTORY);
        held.push(fh);
        (g.write ? readWrite : readOnly).push(fh.fd);
      } catch (e) {
        log(`worker of ${claim.name}: grant ${g.path} left out: ${(e as NodeJS.ErrnoException).code ?? (e as Error).message}`);
      }
    }
    for (const d of [dirs.tmp, dirs.thumbs, dirs.index]) {
      if (!d) continue;
      const fh = await openFolder(d);
      held.push(fh);
      readWrite.push(fh.fd);
    }
    if (cfg.procMounts && (await exists(cfg.procMounts))) readOnly.push(cfg.procMounts);
    const rt = await runtimeRoots();
    readOnly.push(...rt.readOnly);
    readExec.push(...rt.readExec);
    return { readOnly, readWrite, readExec, release };
  } catch (e) {
    release();
    throw e;
  }
}
