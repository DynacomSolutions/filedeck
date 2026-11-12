import { spawn, type ChildProcess } from "node:child_process";
import { constants as C } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import fsSync from "node:fs";
import { randomBytes } from "node:crypto";
import { createInterface } from "node:readline";
import { PassThrough, type Readable } from "node:stream";
import { FsError, volumeRoot } from "./fsops.ts";
import { networkKind, parseMounts, readMountTable } from "./mounts.ts";
import { direntsOf } from "./dirnames.ts";
import type { JobCtl } from "./jobs.ts";
import { TRASH_DIR, WORK_DIR, isReservedName, assertNotTrash, openChecked, resolveRead, resolveWrite, virtualJoin } from "./paths.ts";
import { readTar, TarError, type TarHeader } from "./tar.ts";
import { PasswordError, haveSevenZip, listSz, runSz, szFailure, validPassword, verifyPassword } from "./sevenzip.ts";

/**
 * Archive support. bsdtar (libarchive) does format decoding/encoding for zip,
 * tar.*, 7z; everything security relevant happens here in JS:
 *
 *  - extraction converts ANY input to a pax tar stream (`bsdtar -cf - @archive`)
 *    and writes it through `extractTar`, which validates every entry name,
 *    never creates links, devices or setuid bits, writes with O_NOFOLLOW|O_EXCL
 *    into a private staging directory and enforces entry/byte caps on the bytes
 *    actually written (not on declared sizes);
 *  - paths on the volume go through the same resolve* functions as every other
 *    operation.
 */

export class ArchiveError extends FsError {
  constructor(status: number, message: string) {
    super(status as 400, message);
  }
}

export interface ArchiveLimits {
  maxEntries: number;
  maxBytes: number;
}

export const bsdtar = () => process.env.FILEDECK_BSDTAR || "bsdtar";
const ENV = { ...process.env, LC_ALL: "C.UTF-8", LANG: "C.UTF-8" };

export const FORMATS = {
  zip: { ext: ".zip", args: ["--format", "zip"], encrypt: true, split: true },
  "tar.gz": { ext: ".tar.gz", args: ["-z"], encrypt: false, split: false },
  "tar.zst": { ext: ".tar.zst", args: ["--zstd"], encrypt: false, split: false },
  "tar.xz": { ext: ".tar.xz", args: ["--xz"], encrypt: false, split: false },
  "7z": { ext: ".7z", args: ["--format", "7zip"], encrypt: true, split: true },
} as const;
export type Format = keyof typeof FORMATS;

const ZSTD_LEVEL = [1, 1, 2, 3, 5, 7, 9, 12, 15, 19];
/** bsdtar `--options` for a 0-9 level (0 = store where the format has it, else fastest). */
export function levelOptions(format: Format, level: number | undefined): string | undefined {
  if (level === undefined) return undefined;
  const n = Math.max(0, Math.min(9, Math.floor(level)));
  switch (format) {
    case "zip":
      return n === 0 ? "zip:compression=store" : `zip:compression=deflate,zip:compression-level=${n}`;
    case "tar.gz":
      return `gzip:compression-level=${Math.max(1, n)}`;
    case "tar.xz":
      return `xz:compression-level=${n}`;
    case "tar.zst":
      return `zstd:compression-level=${ZSTD_LEVEL[n]}`;
    case "7z":
      return n === 0 ? "7zip:compression=copy" : `7zip:compression=lzma2,7zip:compression-level=${n}`;
  }
}

const EXTRACT_EXT = [".tar.gz", ".tar.bz2", ".tar.xz", ".tar.zst", ".tar.lz4", ".tgz", ".tbz2", ".txz", ".tzst", ".tar", ".zip", ".7z", ".7z.001", ".zip.001", ".jar", ".war", ".whl", ".rar"];
export const isArchiveName = (n: string) => EXTRACT_EXT.some((e) => n.toLowerCase().endsWith(e));
export function archiveBase(n: string): string {
  const low = n.toLowerCase();
  const e = EXTRACT_EXT.find((x) => low.endsWith(x));
  const b = e ? n.slice(0, n.length - e.length) : n;
  // "..tar" would give "." (the destination itself): such a name, or the reserved trash name, falls back to a plain one
  return !b || b === "." || b === ".." || isReservedName(b) || /[\\/\0]/.test(b) ? "extracted" : b;
}

/** Never read into an archive: another volume's trash store or work folder (a selected folder can be a mount root). */
const RESERVED_EXCLUDES = [TRASH_DIR, WORK_DIR];

function tool(
  args: string[],
  opts: {
    cwd?: string;
    stdin?: boolean;
    /** an open file handed to the tool as descriptor 3 (read it as /dev/fd/3) */
    fd?: number;
    /** an open file the tool writes its standard output to (so it needs no write access by name) */
    out?: number;
    /** run as this user and group, supplementary groups cleared (only effective when the agent is root) */
    runAs?: { uid: number; gid: number };
  } = {},
): ChildProcess {
  const child = spawn(bsdtar(), args, {
    cwd: opts.cwd,
    env: ENV,
    stdio: [opts.stdin ? "pipe" : "ignore", opts.out ?? "pipe", "pipe", ...(opts.fd === undefined ? [] : [opts.fd])],
    ...(opts.runAs ? { uid: opts.runAs.uid, gid: opts.runAs.gid } : {}),
  });
  return child;
}

/** Collect the tail of a child's stderr and resolve on exit. */
function watch(child: ChildProcess, onLine?: (l: string) => void) {
  let tail = "";
  const lines = createInterface({ input: child.stderr as Readable });
  lines.on("line", (l) => {
    if (onLine) onLine(l);
    tail = (tail + "\n" + l).slice(-2000);
  });
  const done = new Promise<{ code: number | null; err: string }>((resolve) => {
    child.on("error", (e) => {
      const missing = (e as NodeJS.ErrnoException).code === "ENOENT";
      resolve({ code: -1, err: missing ? "archive tools are not installed in this image" : e.message });
    });
    child.on("close", (code) => setImmediate(() => resolve({ code, err: tail.trim() })));
  });
  return done;
}

/** Kill and drop the pipes: an unread stdout would otherwise keep 'close' from ever firing. */
function terminate(child: ChildProcess) {
  child.kill("SIGKILL");
  child.stdout?.destroy();
}

function killOnAbort(child: ChildProcess, signal: AbortSignal) {
  const k = () => terminate(child);
  if (signal.aborted) k();
  else signal.addEventListener("abort", k, { once: true });
  child.on("close", () => signal.removeEventListener("abort", k));
}

/* ------------------------------------------------------------------ names */

/**
 * Validate an archive entry name and return its path segments. Anything that
 * could land outside the extraction directory aborts the whole extraction.
 */
export function safeSegments(name: string): string[] {
  if (name.includes("\0")) throw new ArchiveError(400, "unsafe archive entry: NUL in name");
  if (name.length > 4096) throw new ArchiveError(400, "unsafe archive entry: name too long");
  if (/^[\\/]/.test(name) || /^[A-Za-z]:/.test(name)) throw new ArchiveError(400, `unsafe archive entry: absolute path "${name}"`);
  const out: string[] = [];
  for (const seg of name.split(/[\\/]/)) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") throw new ArchiveError(400, `unsafe archive entry: path traversal "${name}"`);
    if (seg.length > 255) throw new ArchiveError(400, "unsafe archive entry: name component too long");
    out.push(seg);
  }
  return out;
}

/* ---------------------------------------------------------------- extract */

export interface ExtractResult {
  files: number;
  dirs: number;
  bytes: number;
  skipped: { symlinks: number; hardlinks: number; special: number };
}

async function ensureDir(base: string, segs: string[]): Promise<string> {
  let cur = base;
  for (const s of segs) {
    cur = path.join(cur, s);
    let st = await fs.lstat(cur).catch(() => null);
    if (!st) {
      await fs.mkdir(cur, { mode: 0o755 });
      st = await fs.lstat(cur);
    }
    if (!st.isDirectory() || st.isSymbolicLink()) throw new ArchiveError(400, "archive entry collides with a non-directory");
  }
  return cur;
}

/**
 * Write a tar stream into `base` (an existing, private, empty directory).
 * Exported for tests: it is the only code that turns entry names into paths.
 */
export async function extractTar(
  src: Readable,
  base: string,
  limits: ArchiveLimits,
  ctl: Pick<JobCtl, "signal" | "progress">,
  filter?: (name: string) => boolean,
): Promise<ExtractResult> {
  const res: ExtractResult = { files: 0, dirs: 0, bytes: 0, skipped: { symlinks: 0, hardlinks: 0, special: 0 } };
  let entries = 0;
  try {
    for await (const { h, body, skipBody } of readTar(src)) {
      if (ctl.signal.aborted) throw new Error("canceled");
      const segs = safeSegments(h.name);
      if (++entries > limits.maxEntries) throw new ArchiveError(413, `archive has more than ${limits.maxEntries} entries`);
      ctl.progress.entries = entries;
      if (segs.length === 0) {
        await skipBody();
        continue;
      }
      if (segs.some(isReservedName)) throw new ArchiveError(400, "unsafe archive entry: reserved name");
      if (filter && !filter(segs.join("/"))) {
        await skipBody(); // not selected (names were validated above, so a hostile entry still aborts)
        continue;
      }
      if (h.type === "symlink" || h.type === "hardlink" || h.type === "other") {
        // Links and device nodes are never created: a link is the usual
        // second stage of a zip-slip, and a hostile target is indistinguishable
        // from a benign one without knowing the final tree.
        if (h.type === "symlink") res.skipped.symlinks++;
        else if (h.type === "hardlink") res.skipped.hardlinks++;
        else res.skipped.special++;
        await skipBody();
        continue;
      }
      ctl.progress.current = segs.join("/");
      if (h.type === "dir") {
        await ensureDir(base, segs);
        res.dirs++;
        await skipBody();
        continue;
      }
      if (res.bytes + h.size > limits.maxBytes) throw new ArchiveError(413, "archive expands beyond the size limit");
      const parent = await ensureDir(base, segs.slice(0, -1));
      const target = path.join(parent, segs[segs.length - 1]!);
      const existing = await fs.lstat(target).catch(() => null);
      if (existing) {
        if (existing.isDirectory()) throw new ArchiveError(400, "archive entry collides with a directory");
        await fs.unlink(target); // later entry wins, as in tar
      }
      const fh = await fs.open(target, C.O_WRONLY | C.O_CREAT | C.O_EXCL | C.O_NOFOLLOW, ((h.mode & 0o777) | 0o600) & ~0o022);
      try {
        for await (const chunk of body()) {
          if (ctl.signal.aborted) throw new Error("canceled");
          res.bytes += chunk.length;
          if (res.bytes > limits.maxBytes) throw new ArchiveError(413, "archive expands beyond the size limit");
          ctl.progress.bytes = res.bytes;
          await fh.write(chunk);
        }
      } finally {
        await fh.close();
      }
      if (h.mtime !== 0) {
        // a Date, not a number: Node treats a negative number (a date before 1970) as "now"
        const when = new Date(h.mtime * 1000);
        await fs.lutimes(target, when, when).catch(() => undefined);
      }
      res.files++;
    }
  } catch (e) {
    if (e instanceof TarError) throw new ArchiveError(400, `corrupt archive: ${e.message}`);
    throw e;
  }
  return res;
}

export interface ListedEntry {
  name: string;
  type: "file" | "dir" | "symlink" | "other";
  size: number;
  date: string;
  link?: string;
  /** zip/7z: the entry's data is encrypted */
  encrypted?: boolean;
}

const LIST_RE = /^([-dlhcbpsw?])[-rwxsStTlL+@.]{9,10}\s+\d+\s+\S+\s+\S+\s+(\d+)\s+(\w{3}\s+\d{1,2}\s+(?:\d{1,2}:\d{2}|\d{4}))\s(.*)$/;

export function parseListLine(line: string): ListedEntry | null {
  const m = LIST_RE.exec(line);
  if (!m) return null;
  const [, t, size, date, rest] = m as unknown as [string, string, string, string, string];
  const type = t === "-" ? "file" : t === "d" ? "dir" : t === "l" ? "symlink" : t === "h" ? "file" : "other";
  let name = rest;
  let link: string | undefined;
  if (t === "l") {
    const i = rest.indexOf(" -> ");
    if (i >= 0) {
      name = rest.slice(0, i);
      link = rest.slice(i + 4);
    }
  } else if (t === "h") {
    const i = rest.indexOf(" link to ");
    if (i >= 0) name = rest.slice(0, i);
  }
  return { name, type, size: Number(size), date, link };
}

/** Stream archive listing; `onEntry` returns false to stop early. */
export async function streamList(
  real: string,
  signal: AbortSignal,
  onEntry: (e: ListedEntry) => boolean | void,
  /** read the archive from this open file (as /dev/fd/3) instead of by name */
  fd?: number,
): Promise<{ stopped: boolean }> {
  const child = tool(["-tvf", fd === undefined ? real : "/dev/fd/3"], { fd });
  killOnAbort(child, signal);
  const done = watch(child);
  let stopped = false;
  const rl = createInterface({ input: child.stdout as Readable });
  // A killed child's destroyed stdout never ends, so readline would wait for ever: close it on abort.
  const closeRl = () => rl.close();
  if (signal.aborted) closeRl();
  else signal.addEventListener("abort", closeRl, { once: true });
  for await (const line of rl) {
    const e = parseListLine(line);
    if (!e) continue; // continuation of a name with a newline, or noise
    if (onEntry(e) === false) {
      stopped = true;
      terminate(child);
      break;
    }
  }
  signal.removeEventListener("abort", closeRl);
  const { code, err } = await done;
  // a listing cut short by the deadline (or an abort) is an error, never a complete-looking partial list
  if (!stopped && signal.aborted) throw signal.reason instanceof ArchiveError ? signal.reason : new ArchiveError(408, "listing the archive took too long");
  if (!stopped && code !== 0) throw new ArchiveError(400, `cannot read archive: ${err.split("\n")[0] || "unsupported format"}`);
  return { stopped };
}

const SZ_EXT = [".zip", ".7z", ".7z.001", ".zip.001", ".jar", ".war", ".whl"];
/** Formats whose entries 7-Zip can encrypt and that bsdtar cannot read when encrypted. */
const szCapable = (name: string) => SZ_EXT.some((e) => name.toLowerCase().endsWith(e)) && haveSevenZip();

export async function listArchive(root: string, p: string, limit = 5000, password?: string) {
  const r = resolveRead(root, p);
  const st = await fs.stat(r.real);
  if (!st.isFile()) throw new ArchiveError(400, "not a regular file");
  const signal = AbortSignal.timeout(30_000);
  if (szCapable(r.real)) {
    try {
      const l = await listSz(r.real, password, signal, limit);
      // a supplied password for an encrypted archive is checked now, so a wrong one is a clear 401 (and a right one can be saved)
      if (l.encrypted && password) await verifyPassword(r.real, l.entries, password, signal);
      let total = 0;
      const entries: ListedEntry[] = l.entries.map((e) => {
        if (e.type === "file") total += e.size;
        return { name: e.name, type: e.type, size: e.size, date: e.date, ...(e.encrypted ? { encrypted: true } : {}) };
      });
      return { path: r.virtual, entries, truncated: l.truncated, bytes: total, encrypted: l.encrypted, passwordUsed: l.encrypted && !!password };
    } catch (e) {
      if (e instanceof PasswordError) throw e; // else: let bsdtar try (and report) the format
      if (signal.aborted) throw new ArchiveError(408, "listing the archive took too long");
    }
  }
  const entries: ListedEntry[] = [];
  let total = 0;
  const { stopped } = await streamList(r.real, signal, (e) => {
    if (entries.length >= limit) return false;
    entries.push(e);
    total += e.type === "file" ? e.size : 0;
  });
  return { path: r.virtual, entries, truncated: stopped, bytes: total, encrypted: false, passwordUsed: false };
}

export type OverwritePolicy = "rename" | "overwrite" | "skip";
export const OVERWRITE_POLICIES: readonly OverwritePolicy[] = ["rename", "overwrite", "skip"];

export interface ExtractOptions {
  overwrite?: OverwritePolicy;
  /** archive entry names (or folders) to extract; empty = everything */
  entries?: string[];
  password?: string;
}

export interface ExtractPlan {
  /** the served root: every destination is pinned and checked against it */
  root: string;
  archiveReal: string;
  archiveName: string;
  destReal: string;
  destVirtual: string;
  subfolder: boolean;
  overwrite: OverwritePolicy;
  entries: string[];
  /** never serialised: lives only in this closure and the 7-Zip child's stdin */
  password?: string;
  /** encrypted zip/7z: extracted by 7-Zip into staging, then sanitised, instead of the bsdtar tar pipeline */
  viaSz: boolean;
}

/** Predicate for "is this entry (by its clean relative path) selected": the entry itself or anything below a selected folder. */
export function selector(entries: string[] | undefined): ((name: string) => boolean) | undefined {
  const sel = (entries ?? []).map((e) => e.replace(/\\/g, "/").replace(/^(\.\/)+/, "").replace(/\/+$/, "")).filter(Boolean);
  if (!sel.length) return undefined;
  const set = new Set(sel);
  return (name) => {
    if (set.has(name)) return true;
    for (let i = name.lastIndexOf("/"); i > 0; i = name.lastIndexOf("/", i - 1)) if (set.has(name.slice(0, i))) return true;
    return false;
  };
}

export async function prepareExtract(root: string, archive: string, destDir: string, subfolder: boolean, o: ExtractOptions = {}): Promise<ExtractPlan> {
  const a = resolveRead(root, archive);
  assertNotTrash(a.virtual);
  const st = await fs.stat(a.real);
  if (!st.isFile()) throw new ArchiveError(400, "not a regular file");
  const d = resolveRead(root, destDir);
  assertNotTrash(d.virtual);
  const ds = await fs.stat(d.real);
  if (!ds.isDirectory()) throw new ArchiveError(400, "destination is not a directory");
  const overwrite = o.overwrite ?? "rename";
  if (!OVERWRITE_POLICIES.includes(overwrite)) throw new ArchiveError(400, "unknown overwrite policy");
  if (o.entries && (o.entries.length > 10000 || o.entries.some((e) => typeof e !== "string" || e.includes("\0")))) throw new ArchiveError(400, "invalid entry selection");
  // Encrypted zip/7z: detect it and check the password now, so a wrong one is a 401 on the request instead of a failed job.
  let viaSz = false;
  // Split volumes (name.7z.001, name.zip.001) only make sense to 7-Zip: bsdtar would see the first part alone.
  const split = /\.(7z|zip)\.001$/i.test(a.real);
  if (split && !haveSevenZip()) throw new ArchiveError(501, "split archives need 7-Zip, which is not installed in this image");
  if (split) viaSz = true;
  if (szCapable(a.real)) {
    const signal = AbortSignal.timeout(60_000);
    let l;
    try {
      l = await listSz(a.real, o.password, signal, 2000);
    } catch (e) {
      if (e instanceof PasswordError) throw e;
    }
    if (l?.encrypted) {
      await verifyPassword(a.real, l.entries, o.password, signal);
      viaSz = true;
    }
  }
  const usePassword = viaSz && !!o.password;
  return { root, archiveReal: a.real, archiveName: path.basename(a.real), destReal: d.real, destVirtual: d.virtual, subfolder, overwrite, entries: o.entries ?? [], password: usePassword ? o.password : undefined, viaSz };
}

async function exists(p: string) {
  return fs.lstat(p).then(() => true, () => false);
}
const LINUX = process.platform === "linux";

/**
 * Run `fn` with a path that names the directory `real` through a held descriptor, so the name
 * cannot be swapped for something else while `fn` works. The entry must be a real directory (a
 * final link is refused) that lives inside the root.
 */
async function pinned<T>(root: string, real: string, fn: (at: string) => Promise<T>): Promise<T> {
  if (!LINUX) return fn(real);
  const fh = await openChecked(root, real, C.O_RDONLY | C.O_DIRECTORY);
  try {
    return await fn(`/proc/self/fd/${fh.fd}`);
  } finally {
    await fh.close().catch(() => undefined);
  }
}

/* ------------------------------------------------------- private work area */

/**
 * Staging for extraction, and the file being written by compression, live in a private work folder that
 * is never in a folder the user serves. It is chosen per volume, like the trash store: `.filedeck-work` at
 * the root of the destination's volume, so results are moved into place with a rename and nothing is copied
 * across filesystems. A folder is accepted only if it is a real directory owned by this agent with mode 0700,
 * and every ancestor is owned by root or this user and cannot be renamed into by anyone else (a sticky folder
 * is fine). Nobody who can write below the volume root can then swap it, whatever 7-Zip or bsdtar do with
 * the path of their working directory.
 *
 * Only when no such folder can be made (a volume root others can write to, a read-only volume) does the job
 * stage in the temp work folder (`FILEDECK_WORK_DIR`, default a per-user folder under the temp directory),
 * after checking that the known size fits there.
 */
const ownedByMe = (uid: number) => {
  const me = process.getuid?.();
  return uid === 0 || uid === me;
};

/** The real path of `dir` when it is an acceptable private folder; throws otherwise. With `create` it is made (mode 0700) when missing. */
async function privateDir(dir: string, create: boolean): Promise<string> {
  const me = process.getuid?.();
  if (create) await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const st = await fs.lstat(dir);
  if (!st.isDirectory() || (me !== undefined && st.uid !== me) || (st.mode & 0o077) !== 0) throw new ArchiveError(500, "the work folder for archives is not private to this agent");
  const real = await fs.realpath(dir);
  for (let d = path.dirname(real); ; d = path.dirname(d)) {
    const a = await fs.stat(d);
    if (!ownedByMe(a.uid) || ((a.mode & 0o022) !== 0 && (a.mode & 0o1000) === 0)) throw new ArchiveError(500, "the work folder for archives sits below a folder others can change");
    if (d === path.dirname(d)) break;
  }
  return real;
}

/** This process's identity in staging names: random at start, so two agents (a rolling update, a shared mount) never share one. */
const PROC_ID = randomBytes(6).toString("hex");
const HOST = os.hostname().toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 24) || "host";
/** `<host>.<process id>.<x|c|s>.<random>`: what a job's staging folder is called; `<name>.alive` beside it is its heartbeat. */
const STAGING = /^[a-z0-9-]+\.[0-9a-f]{12}\.[xcs]\.[A-Za-z0-9]{6}$/;
/** Staging nobody has touched (folder or heartbeat) for this long is a crashed run's. Liveness is never judged by process ids: they mean nothing across containers and machines. */
const idleMs = () => (Number(process.env.FILEDECK_WORK_IDLE_SECONDS) > 0 ? Number(process.env.FILEDECK_WORK_IDLE_SECONDS) : 86_400) * 1000;

let workRootP: Promise<string> | undefined;
let workRootKey = "";
/**
 * The temp work folder: the fallback. With `FILEDECK_WORK_DIR` that folder (it must pass the private test);
 * without it a fresh `mkdtemp` folder per start, never a predictable name another user could have taken.
 */
function workRoot(): Promise<string> {
  const want = process.env.FILEDECK_WORK_DIR || "";
  if (!workRootP || workRootKey !== want) {
    workRootKey = want;
    workRootP = (want ? privateDir(want, true) : makeTempWorkRoot()).then(async (real) => (await sweepDir(real), real));
    workRootP.catch(() => undefined);
  }
  return workRootP;
}

const TEMP_WORK = /^filedeck-work-[A-Za-z0-9]{6}$/;
async function makeTempWorkRoot(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "filedeck-work-"));
  const real = await privateDir(dir, false);
  process.once("exit", () => {
    try {
      fsSync.rmdirSync(real); // only when empty
    } catch {
      /* in use or already gone */
    }
  });
  // folders of earlier starts that nobody uses any more
  void (async () => {
    const me = process.getuid?.();
    for (const n of await fs.readdir(os.tmpdir()).catch(() => [] as string[])) {
      const d = path.join(os.tmpdir(), n);
      if (!TEMP_WORK.test(n) || d === dir) continue;
      try {
        const st = await fs.lstat(d);
        if (!st.isDirectory() || st.uid !== me || (st.mode & 0o077) !== 0) continue;
        await sweepDir(d);
        if (Date.now() - st.mtimeMs > idleMs() && !(await fs.readdir(d)).length) await fs.rmdir(d);
      } catch {
        /* not ours to look at */
      }
    }
  })();
  return real;
}

/** The per-volume work folder for a destination, or null when the volume cannot have an acceptable one. */
const volumeWorks = new Map<string, string>();
async function volumeWork(root: string, destReal: string): Promise<string | null> {
  let made: string | undefined;
  try {
    const vol = await volumeRoot(destReal, root);
    const hit = volumeWorks.get(vol);
    if (hit) {
      await privateDir(hit, false); // still acceptable?
      return hit;
    }
    const dir = path.join(vol, WORK_DIR);
    if (!(await fs.lstat(dir).then(() => true, () => false))) made = dir;
    const real = await privateDir(dir, true);
    made = undefined;
    await sweepDir(real);
    volumeWorks.set(vol, real);
    return real;
  } catch {
    if (made) await fs.rmdir(made).catch(() => undefined); // a folder we just made and then refused
    return null;
  }
}

const swept = new Set<string>();
/**
 * Remove staging of crashed runs from an accepted work folder: entries that are not this process's own and that
 * neither the folder nor its heartbeat file has touched for a long time. A running job refreshes its heartbeat,
 * so another agent's live job (a rolling update, a shared mount) is never removed; process ids are never consulted.
 */
async function sweepDir(real: string) {
  if (swept.has(real)) return;
  swept.add(real);
  const old = (st: { mtimeMs: number } | null) => !st || Date.now() - st.mtimeMs > idleMs();
  for (const n of await fs.readdir(real).catch(() => [] as string[])) {
    if (n.includes(`.${PROC_ID}.`)) continue;
    const staging = n.endsWith(".alive") ? n.slice(0, -6) : n;
    if (!STAGING.test(staging)) continue;
    const dir = path.join(real, staging);
    const [d, m] = await Promise.all([fs.lstat(dir).catch(() => null), fs.lstat(`${dir}.alive`).catch(() => null)]);
    if (n.endsWith(".alive") && d) continue; // handled with its folder
    if (old(d) && old(m)) {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
      await fs.rm(`${dir}.alive`, { force: true }).catch(() => undefined);
    }
  }
}

/** Start-up sweep: the temp work folder and the `.filedeck-work` of the root and of every local mount; nothing else is looked at. */
export async function sweepWorkArea(root: string, procMounts: string): Promise<void> {
  try {
    await workRoot();
  } catch (e) {
    console.error("archive work folder:", (e as Error).message);
  }
  try {
    const text = await readMountTable(root, procMounts);
    const vols = new Set<string>(["/"]);
    for (const m of parseMounts(text, { all: true })) if (!networkKind(m.fstype)) vols.add(m.mountpoint);
    for (const v of vols) {
      try {
        const dir = path.join(resolveWrite(root, v).real, WORK_DIR);
        if (await fs.lstat(dir).then((st) => st.isDirectory(), () => false)) await sweepDir(await privateDir(dir, false));
      } catch {
        /* not accessible or not acceptable: left alone */
      }
    }
  } catch (e) {
    console.error("archive work folders:", (e as Error).message);
  }
}

interface Work {
  /** the folder by name (private: nobody else can reach it) */
  dir: string;
  /** the folder through a held descriptor */
  at: string;
  /** true when this is the temp fallback (data will be copied into the destination) */
  fallback: boolean;
  /** free bytes in the fallback folder; undefined for a per-volume folder */
  free?: number;
  /** remove it; never throws */
  done: () => Promise<void>;
}
/**
 * A private work folder for a job that writes into `destReal`. `need` is the number of bytes the job is known to
 * need (compress: the size of the selection); when staging falls back to the temp volume and it cannot hold that,
 * the job fails at once. A heartbeat file beside the folder is refreshed while the job runs.
 */
async function makeWork(tag: string, root: string, destReal: string, need?: number): Promise<Work> {
  let base = await volumeWork(root, destReal);
  let fallback = false;
  let free: number | undefined;
  if (!base) {
    base = await workRoot();
    fallback = true;
    const sf = await fs.statfs(base).catch(() => null);
    if (sf) free = sf.bavail * sf.bsize;
    if (need !== undefined && free !== undefined && need > free) {
      throw new ArchiveError(507, `not enough room to stage this job: it needs ${need} bytes free in the work folder (${base}) and has ${free}; set FILEDECK_WORK_DIR to a larger volume`);
    }
  }
  const dir = await fs.mkdtemp(path.join(base, `${HOST}.${PROC_ID}.${tag}.`));
  const marker = `${dir}.alive`;
  let fh: import("node:fs/promises").FileHandle | undefined;
  let beat: NodeJS.Timeout | undefined;
  const done = async () => {
    if (beat) clearInterval(beat);
    await fh?.close().catch(() => undefined);
    fh = undefined;
    await fs.rm(dir, { recursive: true, force: true }).catch((e) => console.error("archive work folder cleanup:", (e as Error).message));
    await fs.rm(marker, { force: true }).catch(() => undefined);
  };
  try {
    await fs.writeFile(marker, "");
    beat = setInterval(() => void fs.lutimes(marker, new Date(), new Date()).catch(() => undefined), Math.max(1000, Math.min(60_000, idleMs() / 4)));
    beat.unref();
    let at = dir;
    if (LINUX) {
      fh = await fs.open(dir, C.O_RDONLY | C.O_DIRECTORY | C.O_NOFOLLOW);
      at = `/proc/self/fd/${fh.fd}`;
    }
    return { dir, at, fallback, free, done };
  } catch (e) {
    await done();
    throw e;
  }
}

/** Create the first free `name`, `name (2)`, ... as a new directory in `dirAt`; mkdir fails on an existing name, so two writers never share one. */
async function makeFreeDir(dirAt: string, name: string): Promise<string> {
  const dot = name.lastIndexOf(".");
  const [b, e] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
  for (let i = 1; i < 10000; i++) {
    const c = i === 1 ? name : `${b} (${i})${e}`;
    try {
      await fs.mkdir(path.join(dirAt, c), { mode: 0o755 });
      return c;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
  }
  throw new ArchiveError(409, "cannot find a free name");
}

/** What a move needs: the served root, and (when the agent is root) the owner and group new entries get: the destination folder's. */
interface Mv {
  root: string;
  own?: { uid: number; gid: number };
  /** set on placed files (an archive read as root is not left world-readable) */
  mode?: number;
}
/** Owner and group of a pinned folder, when this process can hand ownership out (root). */
async function ownerOf(at: string): Promise<Mv["own"]> {
  if (process.getuid?.() !== 0) return undefined;
  const st = await fs.stat(at); // `at` is a held descriptor's path: this is the folder itself
  return { uid: st.uid, gid: st.gid };
}
/** Give the entry at `p` the destination's owner and group, through an open descriptor (a link put there is never followed). */
async function chownEntry(mv: Mv, p: string, dir: boolean): Promise<void> {
  if (!mv.own && mv.mode === undefined) return;
  const fh = await fs.open(p, C.O_RDONLY | C.O_NOFOLLOW | C.O_NONBLOCK | (dir ? C.O_DIRECTORY : 0)).catch(() => null);
  if (!fh) return;
  try {
    const st = await fh.stat();
    if (dir ? st.isDirectory() : st.isFile()) {
      if (mv.own) await fh.chown(mv.own.uid, mv.own.gid).catch(() => undefined);
      if (!dir && mv.mode !== undefined) await fh.chmod(mv.mode).catch(() => undefined);
    }
  } finally {
    await fh.close().catch(() => undefined);
  }
}

/** Create the (new, empty) folder `to` content from `from`: pinned, owned like the destination, children moved by `child`, source removed. */
async function fillDir(mv: Mv, from: string, to: string, child: (mv: Mv, from: string, toAt: string, name: string) => Promise<unknown>): Promise<void> {
  await pinned(mv.root, to, async (toAt) => {
    if (mv.own) await fs.chown(toAt, mv.own.uid, mv.own.gid).catch(() => undefined); // toAt names the folder itself
    for (const n of await fs.readdir(from)) await child(mv, path.join(from, n), toAt, n);
  });
  await fs.rmdir(from);
}
/** Put the file `from` at `to` without replacing anything: hard link, or an exclusive copy across filesystems; the source is then removed. */
async function placeFile(mv: Mv, from: string, to: string): Promise<void> {
  const st = await fs.lstat(from);
  try {
    await fs.link(from, to);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") throw e;
    await fs.copyFile(from, to, C.COPYFILE_EXCL);
    await fs.lutimes(to, st.atime, st.mtime).catch(() => undefined); // the entry itself, never what a link put there points at
  }
  await chownEntry(mv, to, false);
  await fs.unlink(from);
}

/**
 * Move `from` (trusted, private staging) to `to` (a child of a pinned directory) without ever replacing
 * something that is already there: EEXIST is raised instead. A file is hard-linked into place and the
 * source removed (copied exclusively when the destination is another filesystem); a folder is created
 * with mkdir, pinned, and filled the same way.
 */
async function moveExcl(mv: Mv, from: string, to: string): Promise<void> {
  const st = await fs.lstat(from);
  if (st.isDirectory()) {
    await fs.mkdir(to, { mode: 0o755 });
    await fillDir(mv, from, to, (m, f, toAt, n) => moveExcl(m, f, path.join(toAt, n)));
    return;
  }
  await placeFile(mv, from, to);
}

/**
 * Keep both: move to the first free `name`, `name (2)`, ... in `destAt`. The top-level name is decided once, by the
 * atomic create; clashes below it are resolved the same way inside that folder, so one tree is never split in two.
 */
async function moveFree(mv: Mv, from: string, destAt: string, name: string): Promise<string> {
  const dot = name.lastIndexOf(".");
  const [b, e] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
  const isDir = (await fs.lstat(from)).isDirectory();
  for (let i = 1; i < 10000; i++) {
    const c = i === 1 ? name : `${b} (${i})${e}`;
    const to = path.join(destAt, c);
    try {
      if (isDir) await fs.mkdir(to, { mode: 0o755 });
      else await placeFile(mv, from, to);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      continue;
    }
    if (isDir) await fillDir(mv, from, to, (m, f, toAt, n) => moveFree(m, f, toAt, n));
    return c;
  }
  throw new ArchiveError(409, "cannot find a free name");
}

interface MergeStats {
  replaced: number;
  skippedExisting: number;
}
/**
 * Merge `src` (staging, trusted) into the existing folder `dst` under the overwrite/skip policy. Never follows a link in `dst`:
 * `dst` is a pinned directory path, and each existing folder is pinned before it is entered. Nothing is created over an entry
 * that appeared after it was looked at: that entry is kept and counted as skipped.
 */
async function mergeInto(mv: Mv, src: string, dst: string, policy: "overwrite" | "skip", stats: MergeStats): Promise<void> {
  for (const n of await fs.readdir(src)) {
    const s = path.join(src, n);
    const t = path.join(dst, n);
    const ss = await fs.lstat(s);
    const ts = await fs.lstat(t).catch(() => null);
    try {
      if (!ts) {
        await moveExcl(mv, s, t);
      } else if (ss.isDirectory() && ts.isDirectory()) {
        await pinned(mv.root, t, (tAt) => mergeInto(mv, s, tAt, policy, stats));
      } else if (policy === "skip" || ts.isDirectory() || ss.isDirectory()) {
        stats.skippedExisting++; // a file never replaces a folder (or the reverse): that would delete data
      } else {
        await fs.unlink(t); // a symlink here is replaced itself, not followed
        await moveExcl(mv, s, t);
        stats.replaced++;
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      stats.skippedExisting++;
    }
  }
}

/**
 * Walk a directory 7-Zip wrote and make it as trustworthy as the tar pipeline's
 * output: no links or special files, caps on entries/bytes, permission bits
 * dropped, unselected files removed.
 */
async function sanitizeTree(base: string, limits: ArchiveLimits, filter: ((n: string) => boolean) | undefined, ctl: Pick<JobCtl, "signal" | "progress">): Promise<ExtractResult> {
  const res: ExtractResult = { files: 0, dirs: 0, bytes: 0, skipped: { symlinks: 0, hardlinks: 0, special: 0 } };
  let entries = 0;
  const walk = async (dir: string, rel: string): Promise<boolean> => {
    let kept = false;
    for await (const { name: n } of direntsOf(dir)) {
      if (ctl.signal.aborted) throw new Error("canceled");
      if (++entries > limits.maxEntries) throw new ArchiveError(413, `archive has more than ${limits.maxEntries} entries`);
      const p = path.join(dir, n);
      const r = rel ? `${rel}/${n}` : n;
      const st = await fs.lstat(p);
      if (st.isSymbolicLink()) {
        res.skipped.symlinks++;
        await fs.unlink(p);
      } else if (st.isDirectory()) {
        const sub = await walk(p, r);
        if (filter && !sub && !filter(r)) await fs.rmdir(p);
        else {
          res.dirs++;
          kept = true;
          await fs.chmod(p, 0o755);
        }
      } else if (st.isFile() && st.nlink === 1) {
        if (filter && !filter(r)) {
          await fs.unlink(p);
          continue;
        }
        res.bytes += st.size;
        if (res.bytes > limits.maxBytes) throw new ArchiveError(413, "archive expands beyond the size limit");
        await fs.chmod(p, ((st.mode & 0o777) | 0o600) & ~0o022);
        res.files++;
        kept = true;
      } else {
        if (st.isFile()) res.skipped.hardlinks++;
        else res.skipped.special++;
        await fs.unlink(p);
      }
    }
    return kept;
  };
  await walk(base, "");
  ctl.progress.bytes = res.bytes;
  return res;
}

/** What the extraction tools read: the archive as an open file (checked when the job starts), or a private copy of a split set's parts. */
interface Source {
  /** the name to give the tool */
  arg: string;
  /** descriptor to hand over as 3 (arg is then /dev/fd/3) */
  fd?: number;
  /** 7-Zip format for a descriptor (no extension to go by) */
  type?: string;
  done: () => Promise<void>;
}
const SPLIT = /\.(7z|zip)\.001$/i;
const szType = (n: string) => (/\.(zip|jar|war|whl)$/i.test(n) ? "zip" : /\.7z$/i.test(n) ? "7z" : undefined);

/**
 * Open the archive now and keep it open: the tools read that file, not whatever the name points at later, so
 * a folder's owner swapping the archive for a link between the request and the job changes nothing. Split volumes
 * are found through the pinned folder, each part opened without following links and checked to be a regular
 * file inside the root, and copied into a private folder (7-Zip finds the other parts by name).
 */
async function openSource(plan: ExtractPlan): Promise<Source> {
  const real = plan.archiveReal;
  const notFile = () => new ArchiveError(400, "not a regular file");
  if (!SPLIT.test(real)) {
    const fh = await openChecked(plan.root, real, C.O_RDONLY);
    try {
      if (!(await fh.stat()).isFile()) throw notFile();
    } catch (e) {
      await fh.close().catch(() => undefined);
      throw e;
    }
    return { arg: "/dev/fd/3", fd: fh.fd, type: szType(real), done: () => fh.close().catch(() => undefined) };
  }
  const work = await makeWork("s", plan.root, plan.destReal);
  try {
    const base = path.basename(real).slice(0, -4);
    await pinned(plan.root, path.dirname(real), async (dirAt) => {
      for (let i = 1; ; i++) {
        const name = `${base}.${String(i).padStart(3, "0")}`;
        let fh;
        try {
          fh = await openChecked(plan.root, path.join(dirAt, name), C.O_RDONLY);
        } catch (e) {
          if (i > 1 && (e as NodeJS.ErrnoException).code === "ENOENT") return;
          throw e;
        }
        try {
          if (!(await fh.stat()).isFile()) throw notFile();
          await fs.copyFile(LINUX ? `/proc/self/fd/${fh.fd}` : path.join(dirAt, name), path.join(work.dir, name), C.COPYFILE_EXCL);
        } finally {
          await fh.close().catch(() => undefined);
        }
      }
    });
  } catch (e) {
    await work.done();
    throw e;
  }
  return { arg: path.join(work.dir, path.basename(real)), done: work.done };
}

/** Extract an encrypted zip/7z with 7-Zip into `staging`; names and links are vetted from the listing first. */
async function extractViaSz(plan: ExtractPlan, src: Source, staging: string, limits: ArchiveLimits, ctl: JobCtl, signal: AbortSignal, free?: number): Promise<ExtractResult> {
  const via = src.fd === undefined ? undefined : { fd: src.fd, type: src.type };
  const l = await listSz(src.arg, plan.password, signal, Infinity, via);
  const sizes = new Map<string, number>();
  const skip: string[] = [];
  let bytes = 0;
  for (const e of l.entries) {
    const segs = safeSegments(e.name); // the whole archive is refused if any name is hostile
    if (segs.some(isReservedName)) throw new ArchiveError(400, "unsafe archive entry: reserved name");
    if (e.type === "symlink" || e.type === "other") skip.push(e.name);
    if (e.type === "file") bytes += e.size;
    sizes.set(segs.join("/"), e.size);
    if (sizes.size > limits.maxEntries) throw new ArchiveError(413, "archive exceeds the configured limits");
    if (bytes > limits.maxBytes) throw new ArchiveError(413, "archive exceeds the configured limits");
  }
  if (free !== undefined && bytes > free) throw new ArchiveError(507, `not enough room to stage this archive: it needs ${bytes} bytes free in the work folder and has ${free}; set FILEDECK_WORK_DIR to a larger volume`);
  ctl.progress.totalEntries = sizes.size;
  ctl.progress.totalBytes = bytes;
  const args = ["x", "-aoa", "-spd", ...(via?.type ? [`-t${via.type}`] : []), "-bb1", "-bso1", "-bsp0", ...skip.map((n) => `-x!${n}`), "--", src.arg];
  // 7-Zip writes into its working directory, which is the pinned staging folder (a held descriptor path cannot be passed as -o: the child has no such descriptor)
  const proc = runSz(args, {
    cwd: staging,
    fd: src.fd,
    password: plan.password,
    signal,
    onLine: (line) => {
      const m = /^[-+U] (.+)$/.exec(line);
      if (!m) return;
      const rel = m[1]!.replace(/\/$/, "");
      ctl.progress.entries++;
      ctl.progress.current = rel;
    },
  });
  const { code, text } = await proc.done;
  if (ctl.signal.aborted) throw new Error("canceled");
  if (code !== 0) szFailure(code, text, plan.password, "extraction failed");
  return sanitizeTree(staging, limits, selector(plan.entries), { signal, progress: ctl.progress });
}

export async function runExtract(plan: ExtractPlan, limits: ArchiveLimits, ctl: JobCtl) {
  // The destination is pinned for the whole job: later renames of the folder, or of anything above it, change nothing here.
  return pinned(plan.root, plan.destReal, (dest) => extractInto(dest, plan, limits, ctl));
}

async function extractInto(dest: string, plan: ExtractPlan, limits: ArchiveLimits, ctl: JobCtl) {
  const src = await openSource(plan);
  try {
    return await extractStaged(dest, plan, src, limits, ctl);
  } finally {
    await src.done();
  }
}

async function extractStaged(dest: string, plan: ExtractPlan, src: Source, limits: ArchiveLimits, ctl: JobCtl) {
  // Staging is in the private work folder, held by descriptor, so nobody who can write to the destination can reach it.
  const work = await makeWork("x", plan.root, plan.destReal);
  const staging = work.at;
  const mv: Mv = { root: plan.root, own: await ownerOf(dest).catch(() => undefined) };
  const ac = new AbortController();
  const stop = () => ac.abort();
  ctl.signal.addEventListener("abort", stop, { once: true });
  try {
    let result: ExtractResult;
    if (plan.viaSz) {
      result = await extractViaSz(plan, src, staging, limits, ctl, ac.signal, work.free);
    } else {
      // Totals for the progress bar come from a parallel listing; extraction
      // itself never trusts them.
      const scan = streamList(src.arg, ac.signal, (e) => {
        ctl.progress.totalEntries++;
        if (e.type === "file") ctl.progress.totalBytes += e.size;
        if (ctl.progress.totalBytes > limits.maxBytes || ctl.progress.totalEntries > limits.maxEntries) {
          ac.abort(new ArchiveError(413, "archive exceeds the configured limits"));
          return false;
        }
        if (work.free !== undefined && ctl.progress.totalBytes > work.free) {
          ac.abort(new ArchiveError(507, `not enough room to stage this archive: it needs ${ctl.progress.totalBytes} bytes free in the work folder and has ${work.free}; set FILEDECK_WORK_DIR to a larger volume`));
          return false;
        }
      }, src.fd).catch(() => undefined);
      const child = tool(["--format=pax", "-cf", "-", "@" + src.arg], { fd: src.fd });
      killOnAbort(child, ac.signal);
      const done = watch(child);
      try {
        result = await extractTar(child.stdout as Readable, staging, limits, { signal: ac.signal, progress: ctl.progress }, selector(plan.entries));
      } catch (e) {
        terminate(child);
        await done;
        if (ac.signal.reason instanceof ArchiveError) throw ac.signal.reason;
        throw e;
      }
      const { code, err } = await done;
      await scan;
      if (ac.signal.reason instanceof ArchiveError) throw ac.signal.reason;
      if (ctl.signal.aborted) throw new Error("canceled");
      if (code !== 0) throw new ArchiveError(400, `cannot read archive: ${err.split("\n")[0] || "unsupported format"}`);
    }
    if (ac.signal.reason instanceof ArchiveError) throw ac.signal.reason;
    if (plan.entries.length && result.files + result.dirs === 0) throw new ArchiveError(400, "none of the selected entries were found in the archive");
    const stats: MergeStats = { replaced: 0, skippedExisting: 0 };
    let finalVirtual: string;
    const root = plan.root;
    if (plan.subfolder) {
      const base = archiveBase(plan.archiveName);
      const existing = plan.overwrite !== "rename" ? await fs.lstat(path.join(dest, base)).catch(() => null) : null;
      if (existing?.isDirectory()) {
        await pinned(root, path.join(dest, base), (at) => mergeInto(mv, staging, at, plan.overwrite as "overwrite" | "skip", stats));
        finalVirtual = virtualJoin(plan.destVirtual, base);
      } else {
        // a new folder made through the pinned destination, then filled from the pinned staging folder
        const name = await makeFreeDir(dest, base);
        await pinned(root, path.join(dest, name), async (at) => {
          if (mv.own) await fs.chown(at, mv.own.uid, mv.own.gid).catch(() => undefined);
          for (const n of await fs.readdir(staging)) await moveFree(mv, path.join(staging, n), at, n); // fresh folder: a clash can only be a concurrent writer
        });
        finalVirtual = virtualJoin(plan.destVirtual, name);
      }
    } else if (plan.overwrite === "rename") {
      for (const n of await fs.readdir(staging)) await moveFree(mv, path.join(staging, n), dest, n);
      finalVirtual = plan.destVirtual;
    } else {
      await mergeInto(mv, staging, dest, plan.overwrite, stats);
      finalVirtual = plan.destVirtual;
    }
    ctl.progress.bytes = result.bytes;
    return { ...result, ...stats, path: finalVirtual };
  } finally {
    ctl.signal.removeEventListener("abort", stop);
    await work.done(); // a cleanup problem is logged there; it never turns a finished job into a failed one
  }
}

/* --------------------------------------------------------------- compress */

export interface CompressOptions {
  /** 0-9 (0 = store where the format has it) */
  level?: number;
  /** zip (AES-256) and 7z only; never logged, never stored */
  password?: string;
  /** 7z only: also encrypt file names and the directory */
  encryptHeaders?: boolean;
  /** split into volumes of this many bytes (zip and 7z) */
  splitBytes?: number;
  /** glob patterns of paths to leave out */
  exclude?: string[];
  /** where the archive is written (default: the folder of the items) */
  destDir?: string;
}

export interface CompressPlan {
  root: string;
  dirReal: string;
  dirVirtual: string;
  names: string[];
  format: Format;
  outName: string;
  outReal: string;
  outVirtual: string;
  level?: number;
  password?: string;
  encryptHeaders: boolean;
  splitBytes?: number;
  exclude: string[];
  viaSz: boolean;
}

export async function prepareSelection(root: string, dir: string, names: string[]) {
  const d = resolveRead(root, dir);
  assertNotTrash(d.virtual);
  if (!names.length || names.length > 10000) throw new ArchiveError(400, "select between 1 and 10000 items");
  const seen = new Set<string>();
  for (const n of names) {
    const v = virtualJoin(d.virtual, n); // rejects "..", "/" and NUL
    assertNotTrash(v);
    const r = resolveWrite(root, v); // lstat semantics, no symlink following
    if (r.virtual !== v) throw new ArchiveError(400, "selection must be direct children of the directory");
    await fs.lstat(r.real);
    seen.add(n);
  }
  return { d, names: [...seen] };
}

const MIN_VOLUME = 64 * 1024;
export async function prepareCompress(root: string, dir: string, names: string[], format: string, name?: string, o: CompressOptions = {}): Promise<CompressPlan> {
  if (!(format in FORMATS)) throw new ArchiveError(400, "unsupported format");
  const f = format as Format;
  const spec = FORMATS[f];
  const { d, names: uniq } = await prepareSelection(root, dir, names);
  if (o.level !== undefined && (!Number.isInteger(o.level) || o.level < 0 || o.level > 9)) throw new ArchiveError(400, "level must be 0 to 9");
  const password = validPassword(o.password);
  if (password && !spec.encrypt) throw new ArchiveError(400, "password protection is only available for zip and 7z");
  if (password && f === "zip" && /[^\x20-\x7e]/.test(password)) throw new ArchiveError(400, "zip passwords can only use plain ASCII characters (a 7z password can use any)");
  if (o.encryptHeaders && (f !== "7z" || !password)) throw new ArchiveError(400, "header encryption needs a password and the 7z format");
  if (o.splitBytes !== undefined && (!spec.split || !Number.isInteger(o.splitBytes) || o.splitBytes < MIN_VOLUME || o.splitBytes > 1024 ** 4)) {
    throw new ArchiveError(400, spec.split ? "volume size must be between 64 KiB and 1 TiB" : "split volumes are only available for zip and 7z");
  }
  const exclude = o.exclude ?? [];
  if (!Array.isArray(exclude) || exclude.length > 100 || exclude.some((x) => typeof x !== "string" || !x.trim() || x.length > 256 || /[\0\r\n]/.test(x))) {
    throw new ArchiveError(400, "exclude must be up to 100 patterns, one per line");
  }
  const viaSz = !!password || o.splitBytes !== undefined;
  if (viaSz && !haveSevenZip()) throw new ArchiveError(501, "7-Zip is not installed in this image");
  if (viaSz && exclude.length && uniq.some((n) => /[*?]/.test(n))) throw new ArchiveError(400, "exclude patterns cannot be combined with names containing * or ? for password or split archives; rename the items");
  const out = o.destDir ? resolveRead(root, o.destDir) : d;
  assertNotTrash(out.virtual);
  if (!(await fs.stat(out.real)).isDirectory()) throw new ArchiveError(400, "destination is not a directory");
  for (const n of uniq) {
    const v = virtualJoin(d.virtual, n);
    if (out.virtual === v || out.virtual.startsWith(v + "/")) throw new ArchiveError(400, "the archive cannot be written inside the items being archived");
  }
  let base = (name ?? "").trim() || (uniq.length === 1 ? uniq[0]! : path.posix.basename(d.virtual) || "archive");
  const ext = spec.ext;
  if (!base.toLowerCase().endsWith(ext)) base += ext;
  virtualJoin(out.virtual, base);
  return {
    root,
    dirReal: d.real,
    dirVirtual: d.virtual,
    names: uniq,
    format: f,
    outName: base,
    outReal: out.real,
    outVirtual: out.virtual,
    level: o.level,
    password,
    encryptHeaders: !!o.encryptHeaders,
    splitBytes: o.splitBytes,
    exclude: exclude.map((x) => x.trim()),
    viaSz,
  };
}

async function walkSizes(dirReal: string, rel: string, sizes: Map<string, number>, limits: ArchiveLimits, signal: AbortSignal) {
  if (signal.aborted) throw new Error("canceled");
  const st = await fs.lstat(path.join(dirReal, rel));
  sizes.set(rel, st.isFile() ? st.size : 0);
  if (sizes.size > limits.maxEntries) throw new ArchiveError(413, `selection has more than ${limits.maxEntries} entries`);
  if (!st.isDirectory()) return;
  const d = await fs.opendir(path.join(dirReal, rel));
  for await (const e of d) await walkSizes(dirReal, rel + "/" + e.name, sizes, limits, signal);
}

export async function runCompress(plan: CompressPlan, limits: ArchiveLimits, ctl: JobCtl) {
  // Both the folder being read and the folder the archive lands in are pinned for the whole job.
  return pinned(plan.root, plan.dirReal, (srcAt) => pinned(plan.root, plan.outReal, (outAt) => compressInto(srcAt, outAt, plan, limits, ctl)));
}

async function compressInto(srcAt: string, outAt: string, plan: CompressPlan, limits: ArchiveLimits, ctl: JobCtl) {
  const sizes = new Map<string, number>();
  for (const n of plan.names) await walkSizes(srcAt, n, sizes, limits, ctl.signal);
  ctl.progress.totalEntries = sizes.size;
  const totalBytes = [...sizes.values()].reduce((a, b) => a + b, 0);
  ctl.progress.totalBytes = totalBytes;
  // Written into the private work folder and moved into place when complete.
  const work = await makeWork("c", plan.root, plan.outReal, totalBytes);
  // When the agent is root and the selected folder belongs to someone else, the tools run as that user (groups cleared):
  // whatever they open by name, they can only open what that user could. Otherwise they run as the agent.
  const srcOwner = await fs.stat(srcAt); // the pinned folder itself
  const runAs = process.getuid?.() === 0 && srcOwner.uid !== 0 ? { uid: srcOwner.uid, gid: srcOwner.gid } : undefined;
  const mv: Mv = { root: plan.root, own: await ownerOf(outAt).catch(() => undefined), mode: process.getuid?.() === 0 && !runAs ? 0o600 : undefined };
  // 7-Zip writes its archive (and volumes) by name, so a user-run 7-Zip writes beside the destination under a hidden name, with that user's rights
  // (it cannot be given a descriptor, and the private folder is not reachable to that user); otherwise the private folder holds it.
  const szTmpPrefix = runAs && plan.viaSz ? `.filedeck-tmp-${randomBytes(4).toString("hex")}-` : "";
  const tmpDir = szTmpPrefix ? plan.outReal : work.dir;
  const tmp = path.join(tmpDir, szTmpPrefix + plan.outName);
  const note = (rel: string) => {
    ctl.progress.entries++;
    ctl.progress.bytes += sizes.get(rel) ?? 0;
    ctl.progress.current = rel;
  };
  try {
    if (plan.viaSz) {
      const type = plan.format === "7z" ? "7z" : "zip";
      // -snl stores symlinks as links (as bsdtar does) instead of archiving whatever they point at
      // -spd (literal file names) also turns off wildcards in -xr! patterns, so it is only used without excludes
      // (prepareCompress refuses wildcard characters in the selection when excludes are given)
      const args = ["a", `-t${type}`, "-snl", ...(plan.exclude.length ? [] : ["-spd"]), "-bb1", "-bso1", "-bsp0", ...(plan.level !== undefined ? [`-mx=${plan.level}`] : [])];
      if (plan.password) {
        args.push("-p");
        if (plan.format === "zip") args.push("-mem=AES256");
        else if (plan.encryptHeaders) args.push("-mhe=on");
      }
      if (plan.splitBytes) args.push(`-v${plan.splitBytes}b`);
      for (const x of plan.exclude) args.push(`-xr!${x}`);
      for (const x of RESERVED_EXCLUDES) args.push(`-xr!${x}`); // another volume's trash or work folder inside the selection
      args.push("--", tmp, ...plan.names.map((n) => "./" + n));
      const proc = runSz(args, {
        cwd: srcAt,
        runAs,
        password: plan.password,
        signal: ctl.signal,
        onLine: (l) => {
          if (l.startsWith("+ ")) note(l.slice(2).replace(/^\.\//, "").replace(/\/$/, ""));
        },
      });
      const { code, text } = await proc.done;
      if (ctl.signal.aborted) throw new Error("canceled");
      if (code !== 0) throw new ArchiveError(500, `compression failed: ${text.split("\n").filter((x) => /error/i.test(x)).pop()?.replace(/^ERROR:\s*/i, "").slice(0, 200) || "unknown error"}`);
    } else {
      const opt = levelOptions(plan.format, plan.level);
      // -T lists are not subject to the "@archive" syntax, so literal names are safe.
      // As another user the tool writes to our open file on its standard output and needs no write access at all.
      const outFh = runAs ? await fs.open(tmp, "wx", 0o600) : undefined;
      const args = ["--null", "-v", ...FORMATS[plan.format].args, ...(opt ? ["--options", opt] : []), ...plan.exclude.map((x) => `--exclude=${x}`), ...RESERVED_EXCLUDES.map((x) => `--exclude=${x}`), "-cf", outFh ? "-" : tmp, "-T", "-"];
      let child: ChildProcess;
      try {
        child = tool(args, { cwd: srcAt, stdin: true, out: outFh?.fd, runAs });
      } catch (e) {
        await outFh?.close();
        throw e;
      }
      child.on("close", () => void outFh?.close().catch(() => undefined));
      killOnAbort(child, ctl.signal);
      const done = watch(child, (l) => {
        if (l.startsWith("a ")) note(l.slice(2).replace(/^\.\//, "").replace(/\/$/, ""));
      });
      (child.stdin as import("node:stream").Writable).on("error", () => undefined);
      (child.stdin as import("node:stream").Writable).end(plan.names.map((n) => n + "\0").join(""));
      const { code, err } = await done;
      if (ctl.signal.aborted) throw new Error("canceled");
      if (code !== 0) throw new ArchiveError(500, `compression failed: ${err.split("\n").pop() || "unknown error"}`);
    }
    // Volumes are name.7z.001, .002 ...: pick a base that is free for the whole set.
    const prefix = szTmpPrefix + plan.outName;
    const produced = (await fs.readdir(tmpDir)).filter((n) => n === prefix || n.startsWith(prefix + ".")).map((n) => n.slice(szTmpPrefix.length));
    if (!produced.length) throw new ArchiveError(500, "compression produced no archive");
    const out = await freeSetName(outAt, plan.outName, produced.map((n) => n.slice(plan.outName.length)));
    let size = 0;
    for (const n of produced) {
      const to = path.join(outAt, out + n.slice(plan.outName.length));
      try {
        await moveExcl(mv, path.join(szTmpPrefix ? outAt : work.dir, szTmpPrefix + n), to); // never replaces a file that appeared meanwhile
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "EEXIST") throw new ArchiveError(409, "the archive name was taken while it was being written");
        throw e;
      }
      size += (await fs.lstat(to)).size;
    }
    // for volumes the path is the first part (name.7z.001), which 7-Zip opens together with its siblings
    return { path: virtualJoin(plan.outVirtual, out + (plan.splitBytes ? ".001" : "")), size, volumes: plan.splitBytes ? produced.length : undefined };
  } finally {
    if (szTmpPrefix) {
      // a failed or cancelled user-run 7-Zip may have left its hidden parts beside the destination
      for (const n of await fs.readdir(outAt).catch(() => [] as string[])) if (n.startsWith(szTmpPrefix)) await fs.rm(path.join(outAt, n), { force: true }).catch(() => undefined);
    }
    await work.done();
  }
}

/** `name`, or `stem (n).ext`, such that none of name+suffix exists for any suffix in the set. */
async function freeSetName(dir: string, name: string, suffixes: string[]): Promise<string> {
  const free = async (n: string) => {
    for (const s of suffixes) if (await exists(path.join(dir, n + s))) return false;
    return true;
  };
  if (await free(name)) return name;
  const dot = name.indexOf(".", 1);
  const [b, e] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
  for (let i = 2; i < 10000; i++) {
    const c = `${b} (${i})${e}`;
    if (await free(c)) return c;
  }
  throw new ArchiveError(409, "cannot find a free name");
}

/* ------------------------------------------------------- streamed download */

/** `bsdtar --format zip` to stdout: streamed (data descriptors), nothing buffered on disk. */
export function zipStream(dirReal: string, names: string[], signal: AbortSignal): Readable {
  const child = tool(["--null", "--format", "zip", ...RESERVED_EXCLUDES.map((x) => `--exclude=${x}`), "-cf", "-", "-T", "-"], { cwd: dirReal, stdin: true });
  killOnAbort(child, signal);
  const src = child.stdout as Readable;
  const done = watch(child);
  (child.stdin as import("node:stream").Writable).on("error", () => undefined);
  (child.stdin as import("node:stream").Writable).end(names.map((n) => n + "\0").join(""));
  // The body must not end before bsdtar has exited: a failure after the last byte would otherwise
  // look like a complete download. The consumer sees the end only after a clean exit, an error otherwise.
  const out = new PassThrough();
  src.pipe(out, { end: false });
  src.on("end", () => {
    void done.then(({ code, err }) => {
      if (code === 0 || signal.aborted) out.end();
      else out.destroy(new Error(err || "zip failed")); // truncated body: the browser shows a failed download
    });
  });
  src.on("error", (e) => out.destroy(e));
  src.on("close", () => {
    if (!src.readableEnded) out.destroy(new Error("zip stream interrupted")); // killed or destroyed before its end
  });
  out.on("close", () => terminate(child));
  return out;
}
