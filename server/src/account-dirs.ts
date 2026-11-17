import { createHash } from "node:crypto";
import fsc from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { UserClaim } from "./auth/identity.ts";
import type { Config } from "./config.ts";
import type { LocalAccount } from "./local-accounts.ts";
import { spawn } from "node:child_process";
import { volumeRoot } from "./fsops.ts";
import type { Grant } from "./grant-guard.ts";
import { OWNER_NAME, TRASH_DIR, TRASH_OWNER, cleanVirtual, openChecked, resolveRead } from "./paths.ts";
import { hitsReadOnly } from "./readonly.ts";
import { sandboxInfo, spawnSandboxed, type Root } from "./sandbox.ts";

/**
 * The folders of an account's worker, and the Landlock rules of a virtual account's worker (sign-in part 2).
 *
 * - `tmp` (the worker's TMPDIR and HOME): `<area>/<key folder>/tmp`, below an area made new for each agent (root's alone, 0711). It goes
 *   when the agent stops.
 * - `thumbs`: `<FILEDECK_THUMB_DIR>/accounts/u<uid>`, one per uid: every system account with that uid and every virtual account that runs as
 *   it share it. A virtual account's Landlock rules give it this folder too, so it can read thumbnails made by the others, also of files
 *   outside its grants; no route reads the folder by path, so none is served. Emptied as the account once no worker runs as the uid.
 * - `index`: `<FILEDECK_INDEX_DIR>/accounts/<key folder>` (none without an index folder: the worker then keeps its index in its `tmp`).
 *   A virtual account's key folder holds a hash of its grants, so a listing cached under old grants is never served under new ones.
 * - `trash`: `<volume>/.filedeck-trash/<u<uid> | v-<owner>>`, the account's own trash folder on each volume (`accountTrashDir`), made by
 *   this process when a worker asks for it, and for a virtual account before its worker starts (its Landlock rules name it).
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
export type Hook = (step: "key" | "tmp" | "thumbs" | "index" | "trash", p: string) => void | Promise<void>;

/** The folders of one worker. `index` is empty when the agent has no index folder. */
export interface AccountDirs {
  tmp: string;
  thumbs: string;
  index: string;
  /** a virtual account's trash folders, one on each volume that holds one of its write grants (made before its worker starts) */
  trash?: string[];
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
export async function give(fh: fs.FileHandle, account: LocalAccount): Promise<void> {
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

/** `UnsafeFolders` unless the folder is this process's and not writable by group or others; it gets the search bits for others when it lacks them (it is ours, and the workers must pass through it). */
async function ownParent(fh: fs.FileHandle, shown: string): Promise<void> {
  const st = await fh.stat();
  if (st.uid !== myUid() || (st.mode & 0o022) !== 0) throw new UnsafeFolders(`${shown} has owner ${st.uid} and mode ${(st.mode & 0o7777).toString(8)}; it must be this process's (${myUid()}) and not writable by group or others`);
  if ((st.mode & 0o011) !== 0o011) await fh.chmod((st.mode & 0o7777) | 0o011);
}

/** The path that names `name` in the folder held by `fh` (or the folder itself): a later swap of any part of its path changes nothing. */
export const inHeld = (fh: { fd: number }, name = "") => `/proc/self/fd/${fh.fd}${name ? `/${name}` : ""}`;

/**
 * `<top>/accounts`, the parent of persistent account folders, held by descriptor. `top` (`<thumbDir>`, `<indexDir>`) is made 0711 when
 * missing, then opened without following a link at its last part, and must be this process's (root's) and not writable by group or others
 * (see `tightenTop` for the start-up step). `accounts` is made 0711 and opened through `top`'s descriptor, with the same check. Else
 * `UnsafeFolders`.
 */
export async function accountsParent(top: string): Promise<fs.FileHandle> {
  await fs.mkdir(top, { recursive: true, mode: 0o711 });
  const t = await openFolder(top);
  try {
    await ownParent(t, top);
    const shown = path.join(top, "accounts");
    await fs.mkdir(inHeld(t, "accounts"), { mode: 0o711 }).catch((e: NodeJS.ErrnoException) => {
      if (e.code !== "EEXIST") throw e;
    });
    const a = await openFolder(inHeld(t, "accounts"), shown);
    try {
      await ownParent(a, shown);
      return a;
    } catch (e) {
      await a.close();
      throw e;
    }
  } finally {
    await t.close();
  }
}

/**
 * At agent start, as root: a cache folder (`<thumbDir>`, `<indexDir>`) that is root's and writable by group or others (an emptyDir volume
 * is 0777) is made 0755 through a descriptor opened without following a link, and one line is logged. One that belongs to someone else, or
 * that has the sticky bit (a shared folder such as /tmp), is left as it is (logged for the sticky one; the workers' folders are then refused). Nothing happens when it is missing or the agent is not root.
 */
export function tightenTop(dir: string, log: (s: string) => void): void {
  if (!dir || myUid() !== 0) return;
  let fd: number;
  try {
    fd = fsc.openSync(dir, OPEN_DIR);
  } catch {
    return;
  }
  try {
    const st = fsc.fstatSync(fd);
    if (st.uid !== 0 || (st.mode & 0o022) === 0) return;
    if (st.mode & 0o1000) {
      // a shared folder (sticky, as /tmp) is never changed: the accounts' caches are refused there until the setting names another one
      log(`${dir} is mode ${(st.mode & 0o7777).toString(8)} (a shared folder); it is left as it is, and workers are refused until FILEDECK_THUMB_DIR or FILEDECK_INDEX_DIR names a folder of its own`);
      return;
    }
    fsc.fchmodSync(fd, 0o755);
    log(`${dir} was mode ${(st.mode & 0o7777).toString(8)}; made 0755 (it holds the accounts' caches)`);
  } finally {
    fsc.closeSync(fd);
  }
}

/**
 * At agent start (sign-in on): the temporary folder `dir` (a real path) that holds the workers' area must not let anyone else rename the
 * area or put another folder in its place. It must be root's (or this process's), and so must every folder above it, each of them sticky
 * when others may write to it (these are never changed); when others may write to it (an empty volume such as the
 * chart's `/tmp` is 0777) it must have the sticky bit, which is set here through a descriptor when the folder is this process's, with one
 * log line. Null when the folder is fine (now); else why the workers are refused (logged once: every start then answers 503 "worker folders
 * are not safe").
 */
export function workersParent(dir: string, log: (s: string) => void): string | null {
  const me = myUid();
  const refuse = (why: string) => {
    const s = `workers are refused: ${why}; set TMPDIR to a folder of root's (with the sticky bit when others may write to it)`;
    log(s);
    return s;
  };
  let fd: number;
  try {
    fd = fsc.openSync(dir, OPEN_DIR);
  } catch (e) {
    return refuse(`the temporary folder ${dir} cannot be opened (${(e as NodeJS.ErrnoException).code ?? (e as Error).message})`);
  }
  try {
    const st = fsc.fstatSync(fd);
    const mode = st.mode & 0o7777;
    const shown = `the temporary folder ${dir} has owner ${st.uid} and mode ${mode.toString(8)}`;
    if (st.uid !== 0 && st.uid !== me) return refuse(`${shown}; its owner could move the workers' folders`);
    // every folder above it too (never changed here): someone who could move one of them could move the whole temporary folder
    for (let d = path.dirname(dir); ; d = path.dirname(d)) {
      let a: fsc.Stats;
      try {
        a = fsc.lstatSync(d);
      } catch (e) {
        return refuse(`the folder ${d} above the temporary folder cannot be read (${(e as NodeJS.ErrnoException).code ?? (e as Error).message})`);
      }
      const m = a.mode & 0o7777;
      if ((a.uid !== 0 && a.uid !== me) || ((m & 0o022) !== 0 && (m & 0o1000) === 0))
        return refuse(`the folder ${d} above the temporary folder has owner ${a.uid} and mode ${m.toString(8)}; others could move the workers' folders`);
      if (d === path.dirname(d)) break;
    }
    if ((mode & 0o022) === 0 || mode & 0o1000) return null;
    if (st.uid !== me) return refuse(`${shown}; others may move the workers' folders`);
    fsc.fchmodSync(fd, mode | 0o1000);
    log(`${dir} was mode ${mode.toString(8)} (others could move the workers' folders in it); made ${(mode | 0o1000).toString(8)} (sticky)`);
    return null;
  } finally {
    fsc.closeSync(fd);
  }
}

/**
 * `<top>/accounts/<name>`, the account's own (0700), made when missing. The parent is checked and held (`accountsParent`); the folder is made
 * and opened through it. A new folder is ours until it is handed over through its descriptor; an existing one must already be the account's
 * and not writable by group or others, and is never changed.
 */
export async function cacheDir(top: string, name: string, account: LocalAccount, step: "thumbs" | "index", hook?: Hook): Promise<string> {
  const shown = path.join(top, "accounts", name);
  const p = await accountsParent(top);
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
  return OWNER_NAME.test(name) ? name : `h${createHash("sha256").update(name).digest("hex").slice(0, 16)}`;
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
 * Runs a Node `script` (`node -e`, with `args`) as `uid`/`gid`, with `dir` as its working folder, and gives back its exit code (null
 * when it was stopped), its output (at most `maxOut` bytes; past that it is stopped) and the start of its error output. The folder is
 * opened here without following a link and must still be `uid`'s; the launcher gets it by descriptor, so the program never resolves a
 * path through folders it may not pass. With Landlock here the program may write only that folder (and read what Node needs to run,
 * `runtimeRoots`). Without Landlock, when `uid` is this process and this process is not root, no user change is needed and the program
 * runs without the launcher. Throws for uid or gid 0, and when the folder cannot be opened or has another owner.
 */
export async function runInFolderAs(
  dir: string,
  uid: number,
  gid: number,
  script: string,
  args: string[],
  o: { timeoutMs?: number; maxOut?: number } = {},
): Promise<{ code: number | null; out: string; err: string }> {
  const me = myUid();
  if (uid === 0 || gid === 0) throw new Error(`${dir} has owner ${uid}:${gid}`);
  const fh = await fs.open(dir, OPEN_DIR);
  let child: import("node:child_process").ChildProcess;
  try {
    const st = await fh.stat();
    if (st.uid !== uid) throw new Error(`its owner changed to ${st.uid}`);
    const env = { PATH: process.env.PATH || "/usr/bin:/bin", LANG: "C.UTF-8" };
    // Under Landlock it may change the folder (by descriptor) and nothing else: one folder's owner may be the runAs account of
    // several virtual accounts, whose other folders it must not reach. Elsewhere the script itself follows no link.
    const confined = (await sandboxInfo()).state === "landlock";
    if (confined) {
      const rt = await runtimeRoots();
      child = await spawnSandboxed(process.execPath, ["-e", script, ...args], {
        ...(uid !== me ? { uid, gid } : {}),
        readWrite: [fh.fd],
        readOnly: rt.readOnly,
        readExec: rt.readExec,
        cwdFd: fh.fd,
        stdio: ["ignore", "pipe", "pipe"],
        env,
      });
    } else if (uid === me && me !== 0) {
      // (no privilege boundary: the account is this process)
      child = spawn(process.execPath, ["-e", script, ...args], { cwd: await fs.readlink(inHeld(fh)), env, stdio: ["ignore", "pipe", "pipe"] });
    } else {
      child = await spawnSandboxed(process.execPath, ["-e", script, ...args], { uid, gid, landlock: false, cwdFd: fh.fd, stdio: ["ignore", "pipe", "pipe"], env });
    }
  } finally {
    await fh.close().catch(() => {});
  }
  const maxOut = o.maxOut ?? 1 << 20;
  const out: Buffer[] = [];
  let outLen = 0;
  let err = "";
  child.stdout?.on("data", (d: Buffer) => {
    outLen += d.length;
    if (outLen > maxOut) child.kill("SIGKILL");
    else out.push(d);
  });
  child.stderr?.on("data", (d: Buffer) => {
    if (err.length < 500) err += d.toString("utf8");
  });
  const code = await new Promise<number | null>((res) => {
    const t = setTimeout(() => child.kill("SIGKILL"), o.timeoutMs ?? EMPTY_MS);
    t.unref();
    child.once("error", () => (clearTimeout(t), res(null)));
    child.once("close", (c) => (clearTimeout(t), res(c)));
  });
  return { code: outLen > maxOut ? null : code, out: Buffer.concat(out).toString("utf8"), err: err.trim().slice(0, 500) };
}

/**
 * Empties `dir` as its owner `uid`/`gid` (`runInFolderAs`). Without a change of user (the owner is this process, not root) it is done
 * here. True when the folder is empty. `shown` is the folder's name in the log.
 */
export async function emptyAs(dir: string, uid: number, gid: number, log: (s: string) => void, shown = dir): Promise<boolean> {
  const me = myUid();
  if (uid === me && me !== 0) {
    let ok = true;
    for (const n of await fs.readdir(dir)) await fs.rm(path.join(dir, n), { recursive: true, force: true }).catch((e: Error) => ((ok = false), log(`workers' area: ${e.message}`)));
    if (!ok) log(`workers' area: ${shown} could not be emptied; left`);
    return ok;
  }
  if (uid === 0 || gid === 0) {
    log(`workers' area: ${shown} has owner ${uid}:${gid}; left`);
    return false;
  }
  try {
    const r = await runInFolderAs(dir, uid, gid, EMPTY_SCRIPT, []);
    if (r.code === 0) return true;
    log(`workers' area: emptying ${shown} as ${uid} failed (${r.code === null ? "stopped" : `exit ${r.code}`}): ${r.err}; left`);
  } catch (e) {
    log(`workers' area: emptying ${shown} as ${uid} failed: ${(e as Error).message}; left`);
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
 *
 * With `held` (the area's descriptor, kept since the area was made) every step goes through that descriptor, never through the area's
 * path: the area lies in the temporary folder, where another user may rename it and put a link in its place. The area itself is removed
 * by its path only while that path still names the held folder.
 */
export async function removeArea(dir: string, log: (s: string) => void, onList?: (dir: string) => void, onEmpty?: (dir: string) => void, held?: number): Promise<void> {
  onList?.(dir);
  const at = held !== undefined ? inHeld({ fd: held }) : dir;
  let names: string[] = [];
  try {
    names = await fs.readdir(at);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
    log(`workers' area: ${dir}: ${(e as Error).message}; left`);
  }
  // (a key folder still root's: its start failed half-way, so it is root's alone and is walked like the area)
  for (const n of names) await removeEntry(path.join(at, n), log, (p) => removeArea(p, log, onList, onEmpty), onEmpty);
  if (held !== undefined) {
    const [a, b] = await Promise.all([fs.lstat(dir).catch(() => null), Promise.resolve(fsc.fstatSync(held))]);
    if (!a || !a.isDirectory() || a.dev !== b.dev || a.ino !== b.ino) {
      log(`workers' area: ${dir} no longer names the area (moved away or replaced); left`);
      return;
    }
  }
  await fs.rmdir(dir).catch((e: NodeJS.ErrnoException) => {
    if (e.code !== "ENOENT") log(`workers' area: ${dir}: ${e.message}; left`);
  });
}

/** `filedeck-workers-<pid>-<6 characters>`: a workers' area (`mkdtemp`), with the pid of the agent that made it */
export const AREA_NAME = /^filedeck-workers-([0-9]{1,10})-[A-Za-z0-9]{6}$/;

/** the areas this process has made (`ownArea`): an area with this process's pid that is not one of them is an earlier process's */
const ownAreas = new Set<string>();
/** Notes an area this process has made, so that `removeOldAreas` never takes it. */
export const ownArea = (p: string): void => void ownAreas.add(p);

const running = (pid: number): boolean => {
  // (an earlier process with this process's own pid, as after a container restart, has stopped)
  if (pid === process.pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
};

/**
 * At agent start: removes the workers' areas in `top` (the temporary folder) that agents which no longer run have left (a killed agent never
 * removes its own), other than `keep` and those this process has made. Only a real folder (not a link), this process's own and not writable by group or others, is taken,
 * and it is removed through its descriptor by `removeArea` (an account's folder in it is emptied as the account, never walked by root).
 * Never throws; what is left is logged.
 */
export async function removeOldAreas(top: string, keep: string, log: (s: string) => void, onEmpty?: (dir: string) => void): Promise<void> {
  let names: string[];
  try {
    names = await fs.readdir(top);
  } catch {
    return;
  }
  for (const n of names) {
    const m = AREA_NAME.exec(n);
    const p = path.join(top, n);
    if (!m || p === keep || ownAreas.has(p) || running(Number(m[1]))) continue;
    let fd: number;
    try {
      fd = fsc.openSync(p, OPEN_DIR);
    } catch {
      continue; // (a link, or gone)
    }
    try {
      const st = fsc.fstatSync(fd);
      if (st.uid !== myUid() || (st.mode & 0o022) !== 0) continue;
      await removeArea(p, log, undefined, onEmpty, fd);
    } catch (e) {
      log(`workers' area: ${p}: ${(e as Error).message}; left`);
    } finally {
      fsc.closeSync(fd);
    }
  }
}

/**
 * Removes the index folders of a virtual account's earlier grants (`v-<owner>-<hash>` in `<indexDir>/accounts`, other than `keep`), unless
 * `inUse` says a worker still uses one. The parent is held by descriptor (`accountsParent`) and every step goes through it; each folder is
 * removed the safe way (`removeEntry`: emptied as its owner, then `rmdir` here). Never throws.
 */
export async function removeOldIndexDirs(indexDir: string, owner: string, keep: string, inUse: (name: string) => boolean, log: (s: string) => void): Promise<string[]> {
  const re = new RegExp(`^v-${owner.replace(/[.]/g, "\\.")}-[0-9a-f]{16}$`);
  const gone: string[] = [];
  const say = (s: string) => log(s.replace("workers' area", "index folders"));
  let p: fs.FileHandle;
  try {
    p = await accountsParent(indexDir);
  } catch (e) {
    say(`index folders: ${(e as Error).message}`);
    return gone;
  }
  try {
    for (const n of await fs.readdir(inHeld(p))) {
      if (n === keep || !re.test(n) || inUse(n)) continue;
      // (a folder still root's is one whose hand-over failed: nothing of the account's is in it, so only an empty one is removed)
      if (await removeEntry(inHeld(p, n), say, (q) => fs.rmdir(q))) gone.push(n);
    }
  } catch (e) {
    say(`index folders: ${(e as Error).message}`);
  } finally {
    await p.close();
  }
  return gone;
}

/**
 * Empties the account caches `<top>/accounts/u<uid>` whose names `pick` accepts, each as its owner (`emptyAs`); the folders themselves stay.
 * Root never walks one. The parent is held by descriptor (`accountsParent`) and every step goes through it. A folder still this process's
 * own as root (its hand-over failed) holds nothing of an account's and is left. Nothing happens when `top` is missing. Gives the names of
 * the folders emptied; never throws (what fails is logged).
 */
export async function emptyCaches(top: string, pick: (name: string) => boolean, log: (s: string) => void): Promise<string[]> {
  const say = (s: string) => log(s.replace("workers' area", "thumbnail caches"));
  const done: string[] = [];
  if (!top || !(await fs.lstat(top).then(() => true, () => false))) return done;
  let p: fs.FileHandle;
  try {
    p = await accountsParent(top);
  } catch (e) {
    say(`thumbnail caches: ${(e as Error).message}`);
    return done;
  }
  try {
    for (const n of await fs.readdir(inHeld(p))) {
      if (!/^u[0-9]+$/.test(n) || !pick(n)) continue;
      const at = inHeld(p, n);
      const st = await fs.lstat(at).catch(() => null);
      if (!st?.isDirectory() || (myUid() === 0 && st.uid === 0)) continue;
      if (await emptyAs(at, st.uid, st.gid, say, path.join(top, "accounts", n))) done.push(n);
    }
  } catch (e) {
    say(`thumbnail caches: ${(e as Error).message}`);
  } finally {
    await p.close();
  }
  return done;
}

/** A request for a trash folder that is refused (400: not a volume root; 403: not this account's to have). */
export class TrashRefused extends Error {
  constructor(
    readonly status: 400 | 403,
    why: string,
  ) {
    super(why);
    this.name = "TrashRefused";
  }
}

/** an item of a trash store (or what is left of one whose removal was cut short) */
const TRASH_ITEM = /^(?:\.purge-)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Who a trash folder is for: taken from the worker's spec, never from what the worker asks. */
export interface TrashOwner {
  kind: "sys" | "virt";
  /** `u<uid>` or `v-<owner>` (`trashFolder`) */
  folder: string;
  account: LocalAccount;
  /** a virtual account's grants (compared form): the volume must hold one that allows writing */
  grants?: Grant[];
}

/**
 * `<volume>/.filedeck-trash/<folder>`, the account's own trash folder on one volume, made when missing (sign-in on). `volume` must be
 * the real path of a volume root inside the served root, as `volumeRoot` gives it (no link, no `..`), and not read-only; a virtual
 * account's must hold one of its write grants. Else `TrashRefused`.
 *
 * Every step goes through descriptors opened without following a link:
 * - the volume root is opened and checked by its descriptor (its own path, and a parent on another device unless it is the served root);
 * - `.filedeck-trash` is made (or opened) through it. It must be this process's (root's) and not sticky; it is made 0711 when its mode
 *   is anything else (an older one is 0700; workers must pass through it). Else `UnsafeFolders`.
 * - items at its top (trashed with sign-in off) move into `u0` (0700, root's) by rename, inside this process's own folders;
 * - the account's folder is made through the store's descriptor and handed to the account last (as `keyFolder`); one that is there
 *   already is never changed and must be the account's with no rights for group or others, else `UnsafeFolders` (the root route answers
 *   503 "trash folder is not safe").
 */
export async function accountTrashDir(cfg: { root: string; readOnly: string[] }, volume: string, who: TrashOwner, log: (s: string) => void, hook?: Hook): Promise<string> {
  const { account, folder } = who;
  if (account.uid === 0 || account.gid === 0) throw new TrashRefused(403, "no account on this machine");
  if (!TRASH_OWNER.test(folder) || folder === "u0" || (who.kind === "sys" ? folder !== `u${account.uid}` : !folder.startsWith("v-")))
    throw new TrashRefused(403, `${folder} is not this account's trash folder`);
  const root = path.resolve(cfg.root);
  if (!path.isAbsolute(volume) || path.resolve(volume) !== volume) throw new TrashRefused(400, "not a volume root");
  let vol: fs.FileHandle;
  try {
    vol = await openChecked(root, volume, fsc.constants.O_RDONLY | fsc.constants.O_DIRECTORY);
  } catch {
    throw new TrashRefused(400, "not a volume root");
  }
  try {
    // the descriptor names the path asked for (no link on the way), and that is a volume root
    if ((await fs.readlink(inHeld(vol))) !== volume) throw new TrashRefused(400, "not a volume root");
    if (volume !== root && (await fs.stat(inHeld(vol, ".."))).dev === (await vol.stat()).dev) throw new TrashRefused(400, "not a volume root");
    const virtual = "/" + path.relative(root, volume);
    if (hitsReadOnly(root, cfg.readOnly, virtual)) throw new TrashRefused(403, "read-only volume");
    if (who.kind === "virt") {
      let held = false;
      for (const g of who.grants ?? []) {
        if (!g.write || held) continue;
        try {
          const r = resolveRead(root, g.path);
          if (r.virtual !== grantPath(g.path)) continue; // (a grant through a link holds nothing, as in the worker's Landlock rules)
          held = (await volumeRoot(r.real, root)) === volume;
        } catch {
          /* a grant that cannot be reached holds nothing */
        }
      }
      // (a volume mounted inside a write grant is not one of the grant's own volume: there is no trash there for this account, and
      // nothing falls back to deleting without one, so the person is told to delete instead)
      if (!held) throw new TrashRefused(403, "no trash here for this account (none of its write grants starts on this volume); delete the item instead");
    }
    const me = myUid();
    const shown = path.join(volume, TRASH_DIR);
    await fs.mkdir(inHeld(vol, TRASH_DIR), { mode: 0o711 }).catch((e: NodeJS.ErrnoException) => {
      if (e.code !== "EEXIST") throw e;
    });
    const t = await openFolder(inHeld(vol, TRASH_DIR), shown);
    try {
      const st = await t.stat();
      if (st.uid !== me || st.mode & 0o1000) throw new UnsafeFolders(`${shown} has owner ${st.uid} and mode ${(st.mode & 0o7777).toString(8)}; it must be this process's (${me}) and not a shared folder`);
      if ((st.mode & 0o7777) !== 0o711) {
        await t.chmod(0o711);
        if (st.mode & 0o022) log(`${shown} was mode ${(st.mode & 0o7777).toString(8)}; made 0711`);
      }
      await moveLegacy(t, shown, log);
      // the account's own folder
      const mine = path.join(shown, folder);
      let made = true;
      try {
        await fs.mkdir(inHeld(t, folder), { mode: 0o700 });
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
        made = false;
      }
      if (made) await hook?.("trash", mine);
      const f = await openFolder(inHeld(t, folder), mine);
      try {
        if (made) {
          await expect(f, mine, me, 0o077);
          await give(f, account);
        } else await expect(f, mine, account.uid, 0o077);
      } finally {
        await f.close();
      }
      return mine;
    } finally {
      await t.close();
    }
  } finally {
    await vol.close();
  }
}

/** Items at the top of a trash store (`t`, held) move into its `u0` folder (root's own, 0700), made when missing. */
async function moveLegacy(t: fs.FileHandle, shown: string, log: (s: string) => void): Promise<void> {
  const items = (await fs.readdir(inHeld(t))).filter((n) => TRASH_ITEM.test(n));
  if (items.length === 0) return;
  const me = myUid();
  const u0 = path.join(shown, "u0");
  await fs.mkdir(inHeld(t, "u0"), { mode: 0o700 }).catch((e: NodeJS.ErrnoException) => {
    if (e.code !== "EEXIST") throw e;
  });
  const f = await openFolder(inHeld(t, "u0"), u0);
  try {
    await expect(f, u0, me, 0o077);
    for (const n of items)
      await fs.rename(inHeld(t, n), inHeld(f, n)).catch((e: NodeJS.ErrnoException) => {
        if (e.code !== "ENOENT") log(`${shown}/${n}: not moved to u0: ${e.code ?? e.message}`);
      });
  } finally {
    await f.close();
  }
}

/**
 * The trash folders a virtual account's worker needs before it starts (its Landlock rules can only name folders that exist): one on each
 * volume that holds one of its write grants, made by `accountTrashDir`. A grant that cannot be reached, or a volume whose folder cannot
 * be made, is left out and logged; the worker then cannot trash there.
 */
export async function virtualTrashDirs(cfg: { root: string; readOnly: string[] }, who: TrashOwner, log: (s: string) => void, hook?: Hook): Promise<string[]> {
  const root = path.resolve(cfg.root);
  const volumes = new Set<string>();
  for (const g of who.grants ?? []) {
    if (!g.write) continue;
    try {
      const r = resolveRead(root, g.path);
      if (r.virtual !== grantPath(g.path)) continue; // (a grant through a link is left out of the worker's rules too)
      volumes.add(await volumeRoot(r.real, root));
    } catch {
      /* missing: nothing to trash there */
    }
  }
  const out: string[] = [];
  for (const v of [...volumes].sort()) {
    try {
      out.push(await accountTrashDir(cfg, v, who, log, hook));
    } catch (e) {
      log(`worker of ${who.folder}: trash folder on ${v} left out: ${(e as Error).message}`);
    }
  }
  return out;
}

/** A grant's path in the one form paths are compared in (`/a/b`; `.` and repeated slashes dropped; `..` refused). */
export const grantPath = (p: string): string => "/" + cleanVirtual(p).join("/");

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
 * - each grant, resolved inside the served root (`resolveRead`) and opened as a folder without following a link at the last step, checked to
 *   be inside the root; read and write when the grant allows writing, else read only. A grant that is a link or runs through one (its
 *   resolved path is not the grant's own), or that cannot be opened (missing, not a folder, Filedeck's own), is left out and logged: the
 *   worker gets less, never more.
 * - read and write: the worker's own folders (`dirs`), opened the same way, and its trash folders (`dirs.trash`).
 * - read only: the mount table (`cfg.procMounts`, for the volumes and the read-only checks), and `runtimeRoots`.
 * Grants and folders are passed as descriptors, so the rule is attached to what was opened here, whatever happens to the path later. A
 * grant whose opened folder is not at its resolved path (a part of the path was changed into a link between the check and the open) is left
 * out and logged too. `afterResolve` is for the tests.
 */
export async function landlockRoots(
  cfg: Config,
  claim: UserClaim,
  dirs: AccountDirs,
  log: (s: string) => void = (s) => console.error(s),
  o: { afterResolve?: (real: string) => void | Promise<void> } = {},
): Promise<LandlockRoots> {
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
        // a grant that is a link or runs through one would follow it to wherever it leads at this moment: left out instead
        if (r.virtual !== grantPath(g.path)) throw new Error(`it leads to ${r.virtual} through a link`);
        await o.afterResolve?.(r.real);
        const fh = await openChecked(cfg.root, r.real, fsc.constants.O_RDONLY | fsc.constants.O_DIRECTORY);
        // a part of the path changed into a link between the check and the open: the folder opened is another one
        const at = await fs.readlink(inHeld(fh)).catch(() => "");
        if (at !== r.real) {
          await fh.close().catch(() => {});
          throw new Error(`it was opened at ${at || "an unknown place"}, not ${r.real} (its path changed meanwhile)`);
        }
        held.push(fh);
        (g.write ? readWrite : readOnly).push(fh.fd);
      } catch (e) {
        log(`worker of ${claim.name}: grant ${g.path} left out: ${(e as NodeJS.ErrnoException).code ?? (e as Error).message}`);
      }
    }
    for (const d of [dirs.tmp, dirs.thumbs, dirs.index]) {
      if (!d || (d !== dirs.tmp && d.startsWith(dirs.tmp + "/"))) continue; // (thumbnails kept in `tmp` are covered by its rule)
      const fh = await openFolder(d);
      held.push(fh);
      readWrite.push(fh.fd);
    }
    for (const d of dirs.trash ?? []) {
      // (one removed since it was made is left out: the worker then cannot trash on that volume)
      try {
        const fh = await openFolder(d);
        held.push(fh);
        readWrite.push(fh.fd);
      } catch (e) {
        log(`worker of ${claim.name}: trash folder ${d} left out: ${(e as Error).message}`);
      }
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
