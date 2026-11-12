import { spawn, type ChildProcess } from "node:child_process";
import type { Stats } from "node:fs";
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
import { STAGING_PREFIX, TRASH_DIR, WORK_DIR, isReservedName, assertNotTrash, openChecked, resolveRead, resolveWrite, virtualJoin } from "./paths.ts";
import { readTar, TarError, type TarHeader } from "./tar.ts";
import { PasswordError, SandboxError, failIfLauncher, haveSevenZip, listSz, runSz, szFailure, szReadArgs, validPassword, verifyPassword, type SzSource } from "./sevenzip.ts";
import { launcherAvailable, readerCapability, sandboxInfo, sandboxRequiredError, spawnSandboxed, type Root, type RunAs } from "./sandbox.ts";
import { toolGate, type Slot } from "./tool-gate.ts";

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
const RESERVED_EXCLUDES = [TRASH_DIR, WORK_DIR, `${STAGING_PREFIX}*`];

/**
 * Start bsdtar inside the sandbox (see sandbox.ts): it can read and write only what it is given and the system folders it needs to
 * start. What it reads comes in as standard input (the archive) or through `readOnly` roots (a pinned source folder, the selected
 * entries); what it writes goes to standard output (a file or pipe this process holds). The roots are descriptors of this process,
 * so renaming or replacing a name afterwards changes nothing. With the sandbox required and unusable this throws a 503.
 */
export async function spawnBsdtar(
  args: string[],
  opts: {
    cwd?: string;
    /** the working folder as an open descriptor (exact; see `SandboxOpts.cwdFd`) */
    cwdFd?: number;
    /** "pipe" (the caller writes to it), "ignore", or an open file the tool reads (a descriptor of this process) */
    stdin?: "pipe" | "ignore" | number;
    /** an open file the tool writes its standard output to (so it needs no write access by name) */
    out?: number;
    readOnly?: Root[];
    /** a private folder the tool may write (the 7zip writer keeps a temporary file): its descriptor and its path (TMPDIR) */
    scratch?: { fd: number; dir: string };
    /** run as this user and group, supplementary groups cleared (only effective when the agent is root), keeping at most the named capability */
    runAs?: RunAs;
    /** a slot of the tool gate the caller already holds (the download route takes it before the response starts, so a full gate is a 429); otherwise one is taken here */
    slot?: Slot;
  } = {},
): Promise<ChildProcess> {
  const slot = opts.slot ?? (await toolGate.acquire());
  let child: ChildProcess;
  try {
    child = await spawnBsdtar1(args, opts);
  } catch (e) {
    slot.release();
    throw e;
  }
  child.once("close", slot.release);
  child.once("error", slot.release);
  return child;
}
function spawnBsdtar1(args: string[], opts: Parameters<typeof spawnBsdtar>[1] = {}): Promise<ChildProcess> {
  return spawnSandboxed(bsdtar(), args, {
    cwd: opts.cwd,
    cwdFd: opts.cwdFd !== undefined && opts.cwdFd >= 0 ? opts.cwdFd : undefined,
    env: opts.scratch ? { ...ENV, TMPDIR: opts.scratch.dir } : ENV,
    stdio: [opts.stdin ?? "ignore", opts.out ?? "pipe", "pipe"],
    readOnly: opts.readOnly,
    // a tool installed outside the system folders (FILEDECK_BSDTAR=/opt/...) must still be startable
    readExec: path.isAbsolute(bsdtar()) ? [bsdtar()] : undefined,
    readWrite: opts.scratch && opts.scratch.fd >= 0 ? [opts.scratch.fd] : undefined,
    ...(opts.runAs ? { uid: opts.runAs.uid, gid: opts.runAs.gid, keepCaps: opts.runAs.keepCaps } : {}),
  });
}

/** The working folder option for a tool: the descriptor when there is one (exact), else the path. */
const cwdOf = (fd: number, at: string): { cwdFd: number } | { cwd: string } => (fd >= 0 ? { cwdFd: fd } : { cwd: at });

/**
 * Who a tool that parses an untrusted archive runs as: when the agent is root, never root. The archive tools' own unprivileged user (a fixed
 * pair with no account needed, `FILEDECK_ARCHIVE_UID` / `FILEDECK_ARCHIVE_GID`, default 65533 for both), which is neither root nor the media
 * tools' user (a compromised media tool must not be able to signal, trace or reach the staging of an archive tool). The launcher clears every
 * capability of the tool in every case. Where the tool must read what only root can read by mode (a 0600 archive, the agent's 0700 work
 * folder, the parts of a split set, a root-owned source folder) it keeps one capability, read and search (`dac_read_search`), which Landlock
 * still limits to the granted roots. An agent that lacks that capability (or is not root) cannot pass it on: the tool then runs as the agent's
 * own user, with no capabilities, and the log says so once.
 */
export function archiveUser(): { uid: number; gid: number } {
  const num = (v: string | undefined, d: number) => (v !== undefined && /^[1-9][0-9]{0,9}$/.test(v) && Number(v) < 4294967294 ? Number(v) : d);
  const uid = num(process.env.FILEDECK_ARCHIVE_UID, 65533);
  return { uid, gid: num(process.env.FILEDECK_ARCHIVE_GID, uid) };
}
const said = new Set<string>();
const sayOnce = (msg: string) => {
  if (!said.has(msg)) {
    said.add(msg);
    console.warn(msg);
  }
};
/** The archive user with the read-search capability; without it (the agent lacks it) the agent's own user, as a non-root agent would. */
async function readerIdentity(): Promise<RunAs | undefined> {
  if (process.getuid?.() !== 0) return undefined;
  const cap = (await launcherAvailable()) ? await readerCapability() : null; // no launcher: nothing can hand a capability over
  if (cap) return { ...archiveUser(), keepCaps: [cap] };
  sayOnce("archive tools: this process holds neither the read-search nor the override capability, so a tool that must read what only root can read runs as the agent's own user (with no capabilities) instead of the archive user");
  return undefined;
}
/** Who a tool runs as when it reads a folder owned by `uid`/`gid`: that owner (groups cleared), and for a root-owned folder the archive user with the read-search capability. */
export async function runIdentity(uid: number, gid: number): Promise<RunAs | undefined> {
  if (process.getuid?.() !== 0) return undefined;
  return uid !== 0 ? { uid, gid } : readerIdentity();
}
/**
 * Who 7-Zip runs as for an archive. One archive is handed over as a descriptor and read as /dev/fd/N, which checks only the file's own mode:
 * when the archive user can read it by mode it needs no capability, whatever the folders above it are. A split set is opened by name, so every
 * folder above must be searchable too. Without `archive` (a stream on standard input) the tool needs nothing.
 */
async function toolIdentity(archive?: { name: string; split?: boolean }): Promise<RunAs | undefined> {
  if (process.getuid?.() !== 0) return undefined;
  const who = archiveUser();
  if (!archive) return who;
  try {
    if (((await fs.stat(archive.name)).mode & 0o004) !== 0) {
      if (!archive.split) return who;
      let open = true;
      for (let d = path.dirname(archive.name); open; d = path.dirname(d)) {
        if (((await fs.stat(d)).mode & 0o001) === 0) open = false;
        if (d === path.dirname(d)) break;
      }
      if (open) return who;
    }
  } catch {
    /* unreadable by name: ask for the capability */
  }
  return readerIdentity();
}

/** An archive tool that cannot run because the sandbox is required and unavailable answers the same 503 everywhere. */
export async function assertSandboxUsable(): Promise<void> {
  if ((await sandboxInfo()).state === "unavailable") throw sandboxRequiredError();
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

/** A new open file description of the file a descriptor holds (a tool reads it from its own start and offset). */
async function reopenFd(fd: number, real: string): Promise<import("node:fs/promises").FileHandle> {
  return fs.open(LINUX ? `/proc/self/fd/${fd}` : real, C.O_RDONLY);
}

/**
 * Stream archive listing; `onEntry` returns false to stop early. With `fd` (an open descriptor of the archive, checked by the
 * caller) the tool reads a fresh copy of that open file as its standard input and is given no file to open; without it the tool
 * is given the one file `real` to read.
 */
export async function streamList(
  real: string,
  signal: AbortSignal,
  onEntry: (e: ListedEntry) => boolean | void,
  fd?: number,
): Promise<{ stopped: boolean }> {
  const input = fd === undefined ? undefined : await reopenFd(fd, real);
  let child: ChildProcess;
  try {
    child = await spawnBsdtar(["-tvf", input ? "-" : real], { stdin: input ? input.fd : "ignore", readOnly: input ? [] : [real], runAs: input ? await toolIdentity() : undefined });
  } catch (e) {
    await input?.close().catch(() => undefined);
    throw e;
  }
  killOnAbort(child, signal);
  const done = watch(child);
  void done.then(() => input?.close().catch(() => undefined));
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
  if (!stopped) failIfLauncher(code, err);
  if (!stopped && code !== 0) throw new ArchiveError(400, `cannot read archive: ${err.split("\n")[0] || "unsupported format"}`);
  return { stopped };
}

const SZ_EXT = [".zip", ".7z", ".7z.001", ".zip.001", ".jar", ".war", ".whl"];
/** Formats whose entries 7-Zip can encrypt and that bsdtar cannot read when encrypted. */
const szCapable = (name: string) => SZ_EXT.some((e) => name.toLowerCase().endsWith(e)) && haveSevenZip();

/** The archive (and every part of a split set) opened for the tools: no link followed, no pipe waited on, regular files inside the root. */
interface OpenedArchive {
  /** for 7-Zip */
  sz: SzSource;
  /** the archive's own descriptor (the first part of a set) */
  fd: number;
  close(): Promise<void>;
}
async function openArchiveFiles(root: string, real: string): Promise<OpenedArchive> {
  const handles: import("node:fs/promises").FileHandle[] = [];
  const close = async () => {
    for (const h of handles.splice(0)) await h.close().catch(() => undefined);
  };
  const open1 = async (p: string) => {
    const fh = await openChecked(root, p, C.O_RDONLY | C.O_NONBLOCK).catch((e) => {
      const code = (e as NodeJS.ErrnoException).code;
      throw code === "ELOOP" || code === "ENXIO" || code === "EISDIR" ? new ArchiveError(400, "not a regular file") : e;
    });
    handles.push(fh);
    if (!(await fh.stat()).isFile()) throw new ArchiveError(400, "not a regular file");
    return fh;
  };
  try {
    if (!SPLIT.test(real)) {
      const fh = await open1(real);
      return { sz: { arg: real, file: fh.fd, type: szType(real), runAs: await toolIdentity({ name: real }) }, fd: fh.fd, close };
    }
    const base = path.basename(real).slice(0, -4);
    await pinned(root, path.dirname(real), async (dirAt) => {
      for (let i = 1; ; i++) {
        try {
          await open1(path.join(dirAt, `${base}.${String(i).padStart(3, "0")}`));
        } catch (e) {
          if (i > 1 && (e as NodeJS.ErrnoException).code === "ENOENT") return;
          throw e;
        }
      }
    });
    const [first, ...more] = handles;
    return { sz: { arg: real, file: first!.fd, also: more.map((h) => h.fd), runAs: await toolIdentity({ name: real, split: true }) }, fd: first!.fd, close };
  } catch (e) {
    await close();
    throw e;
  }
}

export async function listArchive(root: string, p: string, limit = 5000, password?: string) {
  await assertSandboxUsable();
  const r = resolveRead(root, p);
  const st = await fs.stat(r.real);
  if (!st.isFile()) throw new ArchiveError(400, "not a regular file");
  const arch = await openArchiveFiles(root, r.real);
  try {
    return await listOpened(r, arch, limit, password);
  } finally {
    await arch.close();
  }
}

async function listOpened(r: { real: string; virtual: string }, arch: OpenedArchive, limit: number, password?: string) {
  const signal = AbortSignal.timeout(30_000);
  if (szCapable(r.real)) {
    try {
      const l = await listSz(arch.sz, password, signal, limit);
      // a supplied password for an encrypted archive is checked now, so a wrong one is a clear 401 (and a right one can be saved)
      if (l.encrypted && password) await verifyPassword(arch.sz, l.entries, password, signal);
      let total = 0;
      const entries: ListedEntry[] = l.entries.map((e) => {
        if (e.type === "file") total += e.size;
        return { name: e.name, type: e.type, size: e.size, date: e.date, ...(e.encrypted ? { encrypted: true } : {}) };
      });
      return { path: r.virtual, entries, truncated: l.truncated, bytes: total, encrypted: l.encrypted, passwordUsed: l.encrypted && !!password };
    } catch (e) {
      // a plain "not a 7-Zip archive" lets bsdtar try (and report) the format; a launcher failure, a password question or a limit never does
      if (e instanceof PasswordError || e instanceof SandboxError || (e instanceof FsError && e.status >= 500) || SPLIT.test(r.real)) throw e;
      if (signal.aborted) throw new ArchiveError(408, "listing the archive took too long");
    }
  }
  const entries: ListedEntry[] = [];
  let total = 0;
  const { stopped } = await streamList(r.real, signal, (e) => {
    if (entries.length >= limit) return false;
    entries.push(e);
    total += e.type === "file" ? e.size : 0;
  }, arch.fd);
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
  await assertSandboxUsable();
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
    const arch = await openArchiveFiles(root, a.real);
    try {
      let l;
      try {
        l = await listSz(arch.sz, o.password, signal, 2000);
      } catch (e) {
        // for a split set there is no other tool to try: whatever failed is the answer, never a skipped check
        if (e instanceof PasswordError || e instanceof SandboxError || (e instanceof FsError && e.status >= 500) || split) throw e;
      }
      if (l?.encrypted) {
        await verifyPassword(arch.sz, l.entries, o.password, signal);
        viaSz = true;
      }
    } finally {
      await arch.close();
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
 * Called with the real location of a folder at the moment it is pinned; throws when a job may not write there (read-only
 * volumes). `contains` asks whether the folder also holds a read-only one (a merge would reach it).
 */
export type Guard = (location: string, contains: boolean) => void;
type PinGuard = (location: string) => void;

/**
 * Run `fn` with a path that names the directory `real` through a held descriptor, so the name
 * cannot be swapped for something else while `fn` works. The entry must be a real directory (a
 * final link is refused) that lives inside the root.
 */
async function pinned<T>(root: string, real: string, fn: (at: string, fd: number) => Promise<T>, guard?: PinGuard): Promise<T> {
  if (!LINUX) {
    guard?.(real);
    return fn(real, -1);
  }
  const fh = await openChecked(root, real, C.O_RDONLY | C.O_DIRECTORY);
  try {
    // where the held descriptor really is, which is what the read-only rules are applied to (never the name that was opened)
    guard?.(await fs.readlink(`/proc/self/fd/${fh.fd}`));
    return await fn(`/proc/self/fd/${fh.fd}`, fh.fd);
  } finally {
    await fh.close().catch(() => undefined);
  }
}
/** Where a pinned path really is. */
const locationOf = (at: string): Promise<string> => (LINUX && at.startsWith("/proc/self/fd/") ? fs.readlink(at) : Promise.resolve(at));

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
async function volumeWork(root: string, destReal: string, guard?: Guard): Promise<string | null> {
  let made: string | undefined;
  try {
    const vol = await volumeRoot(destReal, root);
    const hit = volumeWorks.get(vol);
    if (hit) {
      guard?.(hit, false);
      await privateDir(hit, false); // still acceptable?
      return hit;
    }
    const dir = path.join(vol, WORK_DIR);
    guard?.(dir, false); // a read-only volume cannot hold one: such a job stages in the temp folder
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
const sweepTargets = new Set<string>();
let sweepTimer: NodeJS.Timeout | undefined;

/** "Now" as the filesystem holding `dir` stamps it: the time of a file made there this moment, so a clock that differs between machines sharing the folder does not matter. */
async function fsNow(dir: string): Promise<number> {
  const f = path.join(dir, `.clock-${randomBytes(4).toString("hex")}`);
  try {
    await fs.writeFile(f, "");
    return (await fs.stat(f)).mtimeMs;
  } catch {
    return Date.now();
  } finally {
    await fs.rm(f, { force: true }).catch(() => undefined);
  }
}

/**
 * Remove staging of crashed runs from an accepted work folder: entries that are not this process's own and that
 * neither the folder nor its heartbeat file has touched for a long time, measured against the filesystem's own clock
 * (the heartbeat is rewritten, not stamped with the writer's clock). A running job refreshes its heartbeat, so another
 * agent's live job (a rolling update, a shared mount) is never removed; process ids are never consulted.
 * Every folder swept once is swept again from time to time.
 */
async function sweepDir(real: string, force = false) {
  sweepTargets.add(real);
  if (!sweepTimer) {
    sweepTimer = setInterval(() => void Promise.all([...sweepTargets].map((d) => sweepDir(d, true).catch(() => undefined))), Math.min(3_600_000, Math.max(1000, idleMs() / 4)));
    sweepTimer.unref();
  }
  if (!force && swept.has(real)) return;
  swept.add(real);
  const now = await fsNow(real);
  const old = (st: { mtimeMs: number } | null) => !st || now - st.mtimeMs > idleMs();
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
    await sweepDir(await workRoot(), true);
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
        if (await fs.lstat(dir).then((st) => st.isDirectory(), () => false)) await sweepDir(await privateDir(dir, false), true);
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
  /** that descriptor's number (-1 where there is none): a sandbox root */
  fd: number;
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
async function makeWork(tag: string, root: string, destReal: string, need?: number, guard?: Guard): Promise<Work> {
  let base = await volumeWork(root, destReal, guard);
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
    beat = setInterval(() => void fs.writeFile(marker, String(Date.now())).catch(() => undefined), Math.max(1000, Math.min(60_000, idleMs() / 4)));
    beat.unref();
    let at = dir;
    if (LINUX) {
      fh = await fs.open(dir, C.O_RDONLY | C.O_DIRECTORY | C.O_NOFOLLOW);
      at = `/proc/self/fd/${fh.fd}`;
    }
    return { dir, at, fd: fh ? fh.fd : -1, fallback, free, done };
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
  /** applied to every destination folder pinned while moving */
  guard?: Guard;
}
/** Owner and group of a pinned folder, when this process can hand ownership out (root). */
async function ownerOf(at: string): Promise<Mv["own"]> {
  if (process.getuid?.() !== 0) return undefined;
  const st = await fs.stat(at); // `at` is a held descriptor's path: this is the folder itself
  return { uid: st.uid, gid: st.gid };
}
/**
 * Give a staged file (private: no one else can reach it) the destination's owner and mode through a descriptor, before it
 * becomes reachable from the destination folder. Nothing in a user's folder is ever chowned by reopening its name.
 */
async function stamp(mv: Mv, staged: string): Promise<void> {
  if (!mv.own && mv.mode === undefined) return;
  const fh = await fs.open(staged, C.O_RDONLY | C.O_NOFOLLOW | C.O_NONBLOCK);
  try {
    if (!(await fh.stat()).isFile()) return;
    if (mv.own) await fh.chown(mv.own.uid, mv.own.gid).catch(() => undefined);
    if (mv.mode !== undefined) await fh.chmod(mv.mode).catch(() => undefined);
  } finally {
    await fh.close().catch(() => undefined);
  }
}

/** Create the (new, empty) folder `to` content from `from`: pinned, owned like the destination, children moved by `child`, source removed. */
async function fillDir(mv: Mv, from: string, to: string, child: (mv: Mv, from: string, toAt: string, name: string) => Promise<unknown>): Promise<void> {
  await pinned(mv.root, to, async (toAt) => {
    if (mv.own) await fs.chown(toAt, mv.own.uid, mv.own.gid).catch(() => undefined); // toAt names the folder itself
    for (const n of await fs.readdir(from)) await child(mv, path.join(from, n), toAt, n);
  }, mv.guard && ((loc) => mv.guard!(loc, false)));
  await fs.rmdir(from);
}
/** Bounds for copying a file a user's tool wrote: its size when it was opened must be within `max`, and it must not change while it is copied. */
interface CopyBound {
  /** most bytes the file may hold */
  max: number;
  /** its size as recorded when it was opened (fstat) */
  size: number;
}

/**
 * Copy an open file into a new file `to` (exclusive create, no link followed) in a pinned folder: owner, mode and times are set
 * through the descriptor of the new file. `st` is the source's stat; `mode` overrides its permission bits. With a bound (a file
 * a user could grow) the copy refuses a file over `max`, checks the free space first, gives the new file its owner before any
 * data is written (so the owner's quota applies while it is written), copies exactly the recorded size and fails when the source
 * changed or holds more.
 */
async function copyFd(mv: Mv, src: import("node:fs/promises").FileHandle, to: string, st: { mode: number; atime: Date; mtime: Date }, mode?: number, bound?: CopyBound): Promise<void> {
  if (bound) {
    if (bound.size > bound.max) throw new ArchiveError(413, `the archive grew beyond its limit (${bound.size} bytes, limit ${bound.max})`);
    const sf = await fs.statfs(path.dirname(to)).catch(() => null);
    if (sf && bound.size > sf.bavail * sf.bsize) throw new ArchiveError(507, `not enough free space for the archive (${bound.size} bytes needed)`);
  }
  const dst = await fs.open(to, C.O_WRONLY | C.O_CREAT | C.O_EXCL | C.O_NOFOLLOW, 0o600); // EEXIST is the caller's
  try {
    if (mv.own) await dst.chown(mv.own.uid, mv.own.gid).catch(() => undefined); // empty file first: quota is charged to the owner
    const buf = Buffer.allocUnsafe(1 << 20);
    const limit = bound ? bound.size : Infinity;
    let pos = 0;
    while (pos < limit) {
      const { bytesRead } = await src.read(buf, 0, Math.min(buf.length, limit - pos), pos);
      if (!bytesRead) break;
      let off = 0;
      while (off < bytesRead) off += (await dst.write(buf, off, bytesRead - off)).bytesWritten;
      pos += bytesRead;
    }
    if (bound) {
      const now = await src.stat();
      const more = (await src.read(Buffer.alloc(1), 0, 1, pos)).bytesRead > 0;
      if (pos !== bound.size || now.size !== bound.size || more) throw new ArchiveError(500, "the archive changed while it was being copied");
    }
    await dst.chmod(mode ?? mv.mode ?? (bound ? 0o644 : st.mode & 0o777)).catch(() => undefined);
    await dst.utimes(st.atime, st.mtime).catch(() => undefined);
  } catch (e) {
    await dst.close().catch(() => undefined);
    await fs.unlink(to).catch(() => undefined); // the file this call created
    throw e;
  }
  await dst.close();
}

/** Put the file `from` (private staging) at `to` without replacing anything: hard link, or an exclusive copy across filesystems; the source is then removed. */
async function placeFile(mv: Mv, from: string, to: string): Promise<void> {
  await stamp(mv, from); // owner and mode are set while it is still private
  try {
    await fs.link(from, to);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") throw e;
    const src = await fs.open(from, C.O_RDONLY | C.O_NOFOLLOW | C.O_NONBLOCK);
    try {
      await copyFd(mv, src, to, await src.stat());
    } finally {
      await src.close().catch(() => undefined);
    }
  }
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
        await pinned(mv.root, t, (tAt) => mergeInto(mv, s, tAt, policy, stats), mv.guard && ((loc) => mv.guard!(loc, true))); // a merge reaches what is inside
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
  /** the archive's name (a split set: its first part's copy in the private folder) */
  arg: string;
  /** descriptor of the archive when it is one file: bsdtar reads a fresh copy of it as standard input */
  fd?: number;
  /** what 7-Zip may read: the archive's own file, or the private folder holding the parts */
  sz: SzSource;
  /** a split set: copies the checked parts into the staging folder (see `stageParts`) once that exists; sets `arg` and `sz` */
  stage?: (work: Work) => Promise<void>;
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
async function openSource(plan: ExtractPlan, destLoc: string, guard?: Guard): Promise<Source> {
  const real = plan.archiveReal;
  const notFile = () => new ArchiveError(400, "not a regular file");
  /** open a name under the pinned folder: no link, no blocking on a pipe, a regular file the folder's owner could read too */
  const openPlain = async (dirAt: string, dirSt: Stats, name: string) => {
    const fh = await openChecked(plan.root, path.join(dirAt, name), C.O_RDONLY | C.O_NONBLOCK);
    try {
      const st = await fh.stat();
      if (!st.isFile()) throw notFile();
      // A hard link to a file only someone else could read (possible where hard-link protection is off) is not this folder's archive.
      if (!readableBy(st, dirSt)) throw new ArchiveError(403, "the archive is not readable by the owner of its folder");
      return { fh, st };
    } catch (e) {
      await fh.close().catch(() => undefined);
      throw e;
    }
  };
  if (!SPLIT.test(real)) {
    return pinned(plan.root, path.dirname(real), async (dirAt) => {
      const { fh } = await openPlain(dirAt, await fs.stat(dirAt), path.basename(real));
      return { arg: real, fd: fh.fd, sz: { arg: real, file: fh.fd, type: szType(real), runAs: await toolIdentity({ name: real }) }, done: () => fh.close().catch(() => undefined) } as Source;
    });
  }
  // A split set: the parts are opened and checked now (held open until the job ends) and copied into the private staging folder once it exists.
  const held: { name: string; fh: import("node:fs/promises").FileHandle }[] = [];
  const done = async () => {
    for (const h of held.splice(0)) await h.fh.close().catch(() => undefined);
  };
  try {
    const base = path.basename(real).slice(0, -4);
    await pinned(plan.root, path.dirname(real), async (dirAt) => {
      const dirSt = await fs.stat(dirAt);
      for (let i = 1; ; i++) {
        const name = `${base}.${String(i).padStart(3, "0")}`;
        try {
          held.push({ name, fh: (await openPlain(dirAt, dirSt, name)).fh });
        } catch (e) {
          if (i > 1 && (e as NodeJS.ErrnoException).code === "ENOENT") return;
          throw e;
        }
      }
    });
  } catch (e) {
    await done();
    throw e;
  }
  const src: Source = { arg: real, sz: { arg: real }, done };
  src.stage = async (work) => {
    // The copies sit in a reserved folder of the private staging folder and are opened by their absolute name. The tool therefore needs to
    // search the agent's work folders above, which are mode 0700 (7-Zip turns a relative name into an absolute one with getcwd(), seen in CI as
    // "Permission denied" for a user without the right) and to read the 0600 copies: it runs as the archive user with the read-search capability only.
    const dir = path.join(work.dir, PARTS_DIR);
    await fs.mkdir(dir, { mode: 0o700 });
    for (const h of held) {
      const to = path.join(dir, h.name);
      await fs.copyFile(LINUX ? `/proc/self/fd/${h.fh.fd}` : h.name, to, C.COPYFILE_EXCL);
      await fs.chmod(to, 0o600);
    }
    src.arg = path.join(dir, path.basename(real));
    src.sz = { arg: src.arg, roots: work.fd >= 0 ? [work.fd] : [], runAs: await readerIdentity() };
  };
  return src;
}

/** The folder inside the staging folder that holds the copies of a split set's parts: a reserved name, so no archive entry can use it. */
const PARTS_DIR = `${STAGING_PREFIX}parts`;

/**
 * Whether an archive in a folder is taken as that folder's own. The folder owner must be able to read it (owner, group or everyone),
 * and a file with more than one link is accepted only when a non-root folder owner owns it: in a root-owned folder (or for a file
 * someone else owns) a hard link could be a planted second name for a file only root can read (possible where hard-link protection
 * is off), so such an archive must have link count 1.
 */
function readableBy(st: { uid: number; gid: number; mode: number; nlink: number }, dir: { uid: number; gid: number }): boolean {
  if (st.nlink > 1 && (dir.uid === 0 || st.uid !== dir.uid)) return false;
  if (dir.uid === 0) return true;
  if (st.uid === dir.uid) return (st.mode & 0o400) !== 0;
  if (st.gid === dir.gid) return (st.mode & 0o040) !== 0;
  return (st.mode & 0o004) !== 0;
}

/** Extract an encrypted zip/7z with 7-Zip into `staging`; names and links are vetted from the listing first. */
async function extractViaSz(plan: ExtractPlan, src: Source, work: Work, limits: ArchiveLimits, ctl: JobCtl, signal: AbortSignal, free?: number): Promise<ExtractResult> {
  const staging = work.at;
  // 7-Zip writes the staging folder as the tool user, so that folder is that user's (it is the agent's private folder, nobody else can reach it)
  if (src.sz.runAs) await fs.chown(staging, src.sz.runAs.uid, src.sz.runAs.gid);
  const l = await listSz(src.sz, plan.password, signal, Infinity);
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
  const how = await szReadArgs(src.sz);
  const args = ["x", "-aoa", "-spd", ...(src.sz.type ? [`-t${src.sz.type}`] : []), "-bb1", "-bso1", "-bsp0", ...skip.map((n) => `-x!${n}`), "--", how.arg];
  // 7-Zip writes into its working directory, the pinned private staging folder, and can read only the archive: the kernel allows it
  // nothing beneath the served root (a held descriptor path cannot be passed as -o: the child has no such descriptor)
  const proc = await runSz(args, {
    ...cwdOf(work.fd, staging),
    runAs: src.sz.runAs,
    fd: how.fd,
    readOnly: how.readOnly,
    readWrite: work.fd >= 0 ? [work.fd] : undefined,
    allowMetadata: true, // 7-Zip sets modes and times on what it creates in the private staging folder
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
  await fs.rm(path.join(staging, PARTS_DIR), { recursive: true, force: true }); // the copies of the parts are not part of the result
  return sanitizeTree(staging, limits, selector(plan.entries), { signal, progress: ctl.progress });
}

export async function runExtract(plan: ExtractPlan, limits: ArchiveLimits, ctl: JobCtl, guard?: Guard) {
  // The destination is pinned for the whole job: later renames of the folder, or of anything above it, change nothing here.
  const merge = plan.overwrite !== "rename";
  return pinned(plan.root, plan.destReal, (dest) => extractInto(dest, plan, limits, ctl, guard), guard && ((loc) => guard(loc, merge && !plan.subfolder)));
}

async function extractInto(dest: string, plan: ExtractPlan, limits: ArchiveLimits, ctl: JobCtl, guard?: Guard) {
  const src = await openSource(plan, await locationOf(dest), guard);
  try {
    return await extractStaged(dest, plan, src, limits, ctl, guard);
  } finally {
    await src.done();
  }
}

async function extractStaged(dest: string, plan: ExtractPlan, src: Source, limits: ArchiveLimits, ctl: JobCtl, guard?: Guard) {
  // Staging is in the private work folder, held by descriptor, so nobody who can write to the destination can reach it.
  const work = await makeWork("x", plan.root, await locationOf(dest), undefined, guard);
  const staging = work.at;
  const mv: Mv = { root: plan.root, own: await ownerOf(dest).catch(() => undefined), guard };
  if (src.stage) await src.stage(work).catch(async (e) => (await work.done(), Promise.reject(e)));
  const ac = new AbortController();
  const stop = () => ac.abort();
  ctl.signal.addEventListener("abort", stop, { once: true });
  try {
    let result: ExtractResult;
    if (plan.viaSz) {
      result = await extractViaSz(plan, src, work, limits, ctl, ac.signal, work.free);
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
      // bsdtar reads a fresh copy of the archive's open file as its standard input and is granted nothing else: no file below the
      // served root can be opened by it, whatever the archive holds; the pax stream it writes is parsed here
      const input = await reopenFd(src.fd!, plan.archiveReal);
      let child: ChildProcess;
      try {
        child = await spawnBsdtar(["--format=pax", "-cf", "-", "@-"], { stdin: input.fd, runAs: await toolIdentity() });
      } catch (e) {
        await input.close().catch(() => undefined);
        throw e;
      }
      killOnAbort(child, ac.signal);
      const done = watch(child);
      void done.then(() => input.close().catch(() => undefined));
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
      failIfLauncher(code, err);
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
        await pinned(root, path.join(dest, base), (at) => mergeInto(mv, staging, at, plan.overwrite as "overwrite" | "skip", stats), guard && ((loc) => guard(loc, true)));
        finalVirtual = virtualJoin(plan.destVirtual, base);
      } else {
        // a new folder made through the pinned destination, then filled from the pinned staging folder
        const name = await makeFreeDir(dest, base);
        await pinned(root, path.join(dest, name), async (at) => {
          if (mv.own) await fs.chown(at, mv.own.uid, mv.own.gid).catch(() => undefined);
          for (const n of await fs.readdir(staging)) await moveFree(mv, path.join(staging, n), at, n); // fresh folder: a clash can only be a concurrent writer
        }, guard && ((loc) => guard(loc, false)));
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
  if (!names.length || names.length > MAX_SELECTED) throw new ArchiveError(400, `select between 1 and ${MAX_SELECTED} items`);
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
  await assertSandboxUsable();
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
  // with exclude patterns 7-Zip matches wildcards (without them it takes names literally), so a name containing * or ? would be read as a pattern
  if (viaSz && exclude.length && uniq.some((n) => /[*?]/.test(n))) throw new ArchiveError(400, "exclude patterns cannot be combined with names containing * or ? for password or split archives (7-Zip would read those names as patterns); rename the items");
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
  if (isReservedName(base) || isReservedName(base.slice(0, base.length - ext.length))) throw new ArchiveError(400, "that archive name is reserved for the file manager's own use");
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

async function walkSizes(dirReal: string, rel: string, sizes: Map<string, number>, limits: ArchiveLimits, signal: AbortSignal, reserved: string[]) {
  if (signal.aborted) throw new Error("canceled");
  const st = await fs.lstat(path.join(dirReal, rel));
  sizes.set(rel, st.isFile() ? st.size : 0);
  if (sizes.size > limits.maxEntries) throw new ArchiveError(413, `selection has more than ${limits.maxEntries} entries`);
  if (!st.isDirectory()) return;
  const d = await fs.opendir(path.join(dirReal, rel));
  for await (const e of d) {
    if (isReservedName(e.name)) {
      // never archived (another volume's trash store, work folder or staging folder): kept out by an exact exclude, not counted
      if (reserved.length >= 5000) throw new ArchiveError(400, "the selection holds too many of Filedeck's own folders");
      reserved.push(rel + "/" + e.name);
      continue;
    }
    await walkSizes(dirReal, rel + "/" + e.name, sizes, limits, signal, reserved);
  }
}

export async function runCompress(plan: CompressPlan, limits: ArchiveLimits, ctl: JobCtl, guard?: Guard) {
  // Both the folder being read and the folder the archive lands in are pinned for the whole job.
  return pinned(plan.root, plan.dirReal, (srcAt, srcFd) => pinned(plan.root, plan.outReal, (outAt) => compressInto(srcAt, srcFd, outAt, plan, limits, ctl, guard), guard && ((loc) => guard(loc, false))));
}

/**
 * Most items one archive job or zip download takes: one limit for the zip route, the ticket route, compression and extraction's entry
 * list (and what the web client sends). The launcher takes at most `MAX_ROOTS` (4,096) folders and files to allow at a start.
 */
export const MAX_SELECTED = 10_000;
/** Items granted one by one; above it bsdtar is given the pinned source folder instead (leaving room for the other grants of a start). */
export const GRANT_LIMIT = 4000;
const O_PATH = 0o10000000; // Linux: a descriptor that names the inode and can do nothing else (no read, no side effect), enough for a Landlock rule

/**
 * What a compression or zip tool may read, as descriptors of this process.
 *  - Up to `GRANT_LIMIT` items: each selected entry on its own, opened path-only and without following a link (no read, so a FIFO, a device
 *    or a socket in the selection is never opened for reading), and never the folder that holds them: unselected siblings and Filedeck's own
 *    folders next to the selection stay closed to the tool. A selected link needs no grant (the tool stores the link itself), nor does
 *    anything that is not a file or a folder.
 *  - More items than that (or more than this process may hold open): the pinned source folder itself (`wholeFolder`). bsdtar is told the
 *    names explicitly and stores links as links, so it archives only the selection, but it can read unselected siblings.
 * Folders inside an entry cannot be taken out of its grant (Landlock allows by hierarchy), so Filedeck's own folders found inside an entry are
 * kept out by the tools' exclude patterns, not by the kernel (see the README).
 */
/** Where the grant fallbacks are reported (tests replace it). */
export const grantHooks = { log: (m: string) => console.warn(m) };
const grantLog = (m: string) => grantHooks.log(m);
export async function selectionGrants(srcAt: string, srcFd: number, names: string[]): Promise<{ roots: number[]; wholeFolder: boolean; close: () => Promise<void> }> {
  const handles: import("node:fs/promises").FileHandle[] = [];
  const close = async () => {
    for (const h of handles.splice(0)) await h.close().catch(() => undefined);
  };
  const folder = { roots: srcFd >= 0 ? [srcFd] : [], wholeFolder: true, close };
  if (names.length > MAX_SELECTED) throw new ArchiveError(400, `select at most ${MAX_SELECTED} items for one archive`);
  if (!LINUX) return { roots: [], wholeFolder: false, close };
  if (names.length > GRANT_LIMIT) return folder;
  try {
    for (const n of names) {
      let fh;
      try {
        fh = await fs.open(path.join(srcAt, n), O_PATH | C.O_NOFOLLOW);
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        if (code === "ENOENT" || code === "ELOOP") continue; // gone, or a link (stored as itself)
        if (code === "EMFILE" || code === "ENFILE") {
          await close(); // this process cannot hold that many descriptors: the pinned folder is granted instead (a decision, and said so)
          grantLog(`archive tools: this process cannot hold ${names.length} descriptors (open file limit reached): the tool is granted the whole source folder instead of the ${names.length} selected items`);
          return folder;
        }
        throw e;
      }
      const st = await fh.stat();
      if (st.isFile() || st.isDirectory()) handles.push(fh);
      else await fh.close();
    }
  } catch (e) {
    await close();
    throw e;
  }
  return { roots: handles.map((h) => h.fd), wholeFolder: false, close };
}

/** Write a small file for a tool (an exclude list): created exclusively, mode set on the descriptor so no umask matters, owned by the tool's user. */
async function writeToolFile(file: string, text: string, owner?: { uid: number; gid: number }): Promise<void> {
  const fh = await fs.open(file, "wx", 0o600);
  try {
    await fh.chmod(0o600);
    if (owner) await fh.chown(owner.uid, owner.gid);
    await fh.writeFile(text);
  } finally {
    await fh.close();
  }
}

/** Run `rm -rf` as `user`, so whatever a user's tool or the user left in their folder is removed with that user's rights only. */
function removeAsUser(dir: string, user: { uid: number; gid: number }): Promise<void> {
  return new Promise((resolve) => {
    const c = spawn("rm", ["-rf", "--", dir], { uid: user.uid, gid: user.gid, stdio: "ignore", cwd: "/", timeout: 60_000 });
    c.on("error", () => resolve());
    c.on("close", () => resolve());
  });
}

/**
 * What the output of a compression may be: the selection's size plus room for the container (a margin of an eighth, 1 MiB, and per
 * entry its headers: they hold the name more than once, a zip twice and a 7z in UTF-16, so the margin follows the real name
 * lengths), never more than the configured archive limit, and for volumes never more than a volume each. A user can grow a file
 * their tool wrote at no cost, so nothing larger is taken.
 */
export function outputBounds(o: { totalBytes: number; entries: number; nameBytes: number; maxBytes: number; splitBytes?: number }): { setMax: number; partMax: number } {
  const overhead = Math.ceil(o.totalBytes / 8) + 1024 * 1024 + o.entries * 512 + o.nameBytes * 4;
  const setMax = Math.min(o.totalBytes + overhead, o.maxBytes);
  return { setMax, partMax: Math.min(o.splitBytes ?? Infinity, setMax) };
}

async function compressInto(srcAt: string, srcFd: number, outAt: string, plan: CompressPlan, limits: ArchiveLimits, ctl: JobCtl, guard?: Guard) {
  const sizes = new Map<string, number>();
  const reserved: string[] = [];
  for (const n of plan.names) await walkSizes(srcAt, n, sizes, limits, ctl.signal, reserved);
  ctl.progress.totalEntries = sizes.size;
  const totalBytes = [...sizes.values()].reduce((a, b) => a + b, 0);
  ctl.progress.totalBytes = totalBytes;
  // Written into the private work folder and moved into place when complete.
  const work = await makeWork("c", plan.root, await locationOf(outAt), totalBytes, guard);
  let userDir: string | undefined;
  let userDirFh: import("node:fs/promises").FileHandle | undefined;
  let runAs: RunAs | undefined;
  let grants: Awaited<ReturnType<typeof selectionGrants>> | undefined;
  const parts: import("node:fs/promises").FileHandle[] = [];
  const placed: string[] = [];
  try {
    // When the agent is root and the selected folder belongs to someone else, the tools run as that user (groups cleared): whatever they
    // open by name, they can only open what that user could. The group is the folder's own: that is what the selection's permissions
    // were set up for (shared group folders stay readable); the owner's primary group would grant nothing the folder does not.
    // For a root-owned folder they run as the archive user with the read-search capability (never as root); without that capability as the agent.
    const srcOwner = await fs.stat(srcAt); // the pinned folder itself
    runAs = await runIdentity(srcOwner.uid, srcOwner.gid);
    const own = await ownerOf(outAt).catch(() => undefined);
    // One rule for the mode of what is produced: 0600 when the content was read with more privilege than the destination's owner has
    // (the agent as root, or a tool running as someone other than that owner); 0644 when it ran as the destination's owner; otherwise the tool's own.
    const privileged = process.getuid?.() === 0 && (!runAs || !!runAs.keepCaps || runAs.uid !== own?.uid);
    const mv: Mv = { root: plan.root, guard, own, mode: privileged ? 0o600 : runAs ? 0o644 : undefined };
    // 7-Zip writes its archive (and volumes) by name, so a user-run 7-Zip gets a folder only it and the agent can reach (made here,
    // owned by that user, mode 0700, under the temp directory) and writes files there. The agent never walks it: it opens the
    // folder and each produced file without following links, requires plain files that the user owns, and copies them through
    // those descriptors into the pinned output folder.
    if (runAs) {
      userDir = await fs.mkdtemp(path.join(os.tmpdir(), "filedeck-out-"));
      userDirFh = await fs.open(userDir, C.O_RDONLY | C.O_DIRECTORY | C.O_NOFOLLOW);
      await userDirFh.chown(runAs.uid, runAs.gid);
      await userDirFh.chmod(0o700);
    }
    // Both tools write by name into one folder that only they and the agent can reach: the tool user's own (made here) when it runs as
    // someone else, else the private work folder. The agent takes the parts out through descriptors (see below).
    const outputInUserDir = !!userDir;
    const tmp = path.join(outputInUserDir ? userDir! : work.dir, plan.outName);
    const note = (rel: string) => {
      ctl.progress.entries++;
      ctl.progress.bytes += sizes.get(rel) ?? 0;
      ctl.progress.current = rel;
    };
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
      // Filedeck's own folders at any depth. The exact names are excluded by name wherever they are (with wildcard matching off these are
      // literal names); with wildcards on (user excludes given) the staging prefix is a pattern too. With wildcards off the staging prefix
      // cannot be written as a pattern, so those folders are excluded by the exact paths found while the selection was scanned.
      args.push(`-xr!${TRASH_DIR}`, `-xr!${WORK_DIR}`);
      if (plan.exclude.length) args.push(`-xr!${STAGING_PREFIX}*`);
      if (reserved.length) {
        // a long list goes in a file, not on the command line (deep trees must not exceed the argument size limit)
        if (reserved.some((r) => /[\r\n]/.test(r))) throw new ArchiveError(400, "a folder name inside the selection contains a line break, which cannot be excluded safely");
        const list = path.join(userDir ?? work.dir, ".excludes");
        await writeToolFile(list, reserved.join("\n") + "\n", runAs);
        args.push(`-x@${list}`);
      }
      args.push("--", tmp, ...plan.names.map((n) => "./" + n));
            // 7-Zip lists its working folder to find the names it is given (given only the entries it fails with "Permission denied" on "./"),
      // so unlike bsdtar it is granted the pinned source folder itself; unselected siblings are then readable by it but never archived
      const proc = await runSz(args, {
        ...cwdOf(srcFd, srcAt),
        runAs,
        readOnly: srcFd >= 0 ? [srcFd] : undefined,
        readWrite: userDirFh ? [userDirFh.fd] : work.fd >= 0 ? [work.fd] : undefined,
        password: plan.password,
        signal: ctl.signal,
        onLine: (l) => {
          if (l.startsWith("+ ")) note(l.slice(2).replace(/^\.\//, "").replace(/\/$/, ""));
        },
      });
      const { code, text } = await proc.done;
      if (ctl.signal.aborted) throw new Error("canceled");
      failIfLauncher(code, text);
      if (code !== 0) throw new ArchiveError(500, `compression failed: ${text.split("\n").filter((x) => /error/i.test(x)).pop()?.replace(/^ERROR:\s*/i, "").slice(0, 200) || "unknown error"}`);
    } else {
      const opt = levelOptions(plan.format, plan.level);
      // -T lists are not subject to the "@archive" syntax, so literal names are safe.
      // The archive is written by name (a file named by `-cf` is written exactly, where standard output would be padded to a block): into the
      // private scratch folder below, the only place the tool may write. It reads only the selected entries.
      const args = ["--null", "-v", ...FORMATS[plan.format].args, ...(opt ? ["--options", opt] : []), ...plan.exclude.map((x) => `--exclude=${x}`), ...RESERVED_EXCLUDES.map((x) => `--exclude=${x}`), "-cf", tmp, "-T", "-"];
      grants = await selectionGrants(srcAt, srcFd, plan.names);
      // its scratch folder is the one that belongs to its user (when it runs as one), else the private work folder
      const scratch = userDirFh ? { fd: userDirFh.fd, dir: userDir! } : { fd: work.fd, dir: work.dir };
      const child = await spawnBsdtar(args, { ...cwdOf(srcFd, srcAt), stdin: "pipe", readOnly: grants.roots, scratch, runAs });
      await grants.close(); // the tool and the launcher hold their own copies: this process lets go of its descriptors now
      killOnAbort(child, ctl.signal);
      const done = watch(child, (l) => {
        if (l.startsWith("a ")) note(l.slice(2).replace(/^\.\//, "").replace(/\/$/, ""));
      });
      (child.stdin as import("node:stream").Writable).on("error", () => undefined);
      (child.stdin as import("node:stream").Writable).end(plan.names.map((n) => n + "\0").join(""));
      const { code, err } = await done;
      if (ctl.signal.aborted) throw new Error("canceled");
      failIfLauncher(code, err);
      if (code !== 0) throw new ArchiveError(500, `compression failed: ${err.split("\n").pop() || "unknown error"}`);
    }
    // Volumes are name.7z.001, .002 ...: pick a base that is free for the whole set.
    const isPart = (n: string) => n === plan.outName || n.startsWith(plan.outName + ".");
    // What the output may be: the selection's size plus room for the container (headers per entry, and a margin), never more than the
    // configured archive limit, and for volumes never more than a volume each. A user can grow a file their tool wrote at no cost.
    let nameBytes = 0;
    for (const k of sizes.keys()) nameBytes += Buffer.byteLength(k);
    const { setMax, partMax } = outputBounds({ totalBytes, entries: sizes.size, nameBytes, maxBytes: limits.maxBytes, splitBytes: plan.splitBytes });
    const tooBig = (what: string, n: number, max: number) => new ArchiveError(413, `${what} is ${n} bytes, over the limit of ${max} bytes for this archive`);
    const found: { suffix: string; from?: string; size?: number; fh?: import("node:fs/promises").FileHandle; st?: Stats }[] = [];
    if (outputInUserDir) {
      const dh = userDirFh!;
      try {
        const dst = await dh.stat();
        if (dst.uid !== runAs!.uid) throw new ArchiveError(500, "compression output folder was replaced");
        const at = `/proc/self/fd/${dh.fd}`;
        for (const n of (await fs.readdir(at)).filter(isPart).slice(0, 10_000)) {
          const fh = await fs.open(path.join(at, n), C.O_RDONLY | C.O_NOFOLLOW | C.O_NONBLOCK);
          parts.push(fh);
          const st = await fh.stat();
          // a plain file the user's tool wrote: not a folder, a link, a device, or a hard link to something else
          if (!st.isFile() || st.uid !== runAs!.uid || st.nlink !== 1) throw new ArchiveError(500, "compression produced an unexpected output");
          if (st.size > partMax) throw tooBig(`output ${n}`, st.size, partMax);
          found.push({ suffix: n.slice(plan.outName.length), fh, st });
        }
      } finally {
        /* the folder's descriptor is closed with the job */
      }
    } else {
      for (const n of (await fs.readdir(work.dir)).filter(isPart)) {
        const from = path.join(work.dir, n);
        const size = (await fs.lstat(from)).size;
        if (size > partMax) throw tooBig(`output ${n}`, size, partMax);
        found.push({ suffix: n.slice(plan.outName.length), from, size });
      }
    }
    // the limit applies to the whole set, whoever made it
    const sumSize = found.reduce((t, f) => t + (f.size ?? f.st?.size ?? 0), 0);
    if (sumSize > setMax) throw tooBig("the archive", sumSize, setMax);
    if (!found.length) throw new ArchiveError(500, "compression produced no archive");
    const out = await freeSetName(outAt, plan.outName, found.map((f) => f.suffix));
    let size = 0;
    for (const f of found) {
      const to = path.join(outAt, out + f.suffix);
      try {
        if (f.fh) await copyFd(mv, f.fh, to, f.st!, undefined, { max: partMax, size: f.st!.size }); // never replaces a file that appeared meanwhile
        else await moveExcl(mv, f.from!, to);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "EEXIST") throw new ArchiveError(409, "the archive name was taken while it was being written");
        throw e;
      }
      placed.push(to);
      size += (await fs.lstat(to)).size;
    }
    // for volumes the path is the first part (name.7z.001), which 7-Zip opens together with its siblings
    return { path: virtualJoin(plan.outVirtual, out + (plan.splitBytes ? ".001" : "")), size, volumes: plan.splitBytes ? found.length : undefined };
  } catch (e) {
    // files this job created in the output folder (plain files only: it never makes anything else there)
    for (const f of placed) await fs.unlink(f).catch(() => undefined);
    throw e;
  } finally {
    for (const fh of parts) await fh.close().catch(() => undefined);
    await grants?.close();
    await userDirFh?.close().catch(() => undefined);
    if (userDir) {
      if (runAs) await removeAsUser(userDir, runAs); // whatever its shape, with the user's own rights
      await fs.rmdir(userDir).catch(() => undefined);
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

/**
 * `bsdtar --format zip` to stdout: streamed (data descriptors), nothing buffered on disk. The folder is pinned by descriptor for the
 * whole stream, the tool starts in it through that descriptor (never by name) and, inside the sandbox, may read only the selected
 * entries (or that folder) and write nothing; when the agent is root and the folder belongs to someone else it runs as that owner
 * (groups cleared). `opts.root` is the served root the folder must lie in; `opts.afterPin` runs once the folder is held (tests).
 */
export const zipLimits = { stallMs: 60_000 };
export function zipStream(dirReal: string, names: string[], signal: AbortSignal, opts: { root?: string; afterPin?: () => void | Promise<void>; afterSpawn?: () => void | Promise<void>; slot?: Slot } = {}): Readable {
  // The body must not end before bsdtar has exited: a failure after the last byte would otherwise
  // look like a complete download. The consumer sees the end only after a clean exit, an error otherwise.
  const out = new PassThrough();
  void (async () => {
    const slot = opts.slot ?? (await toolGate.acquire(signal).catch((e) => (out.destroy(e as Error), undefined)));
    if (!slot) return;
    try {
      await pinned(opts.root ?? "/", dirReal, async (at, fd) => {
        await opts.afterPin?.();
        const st = await fs.stat(at); // the pinned folder itself
        const run = await runIdentity(st.uid, st.gid);
        const grants = await selectionGrants(at, fd, names);
        try {
          const child = await spawnBsdtar(["--null", "--format", "zip", ...RESERVED_EXCLUDES.map((x) => `--exclude=${x}`), "-cf", "-", "-T", "-"], { ...cwdOf(fd, at), stdin: "pipe", readOnly: grants.roots, runAs: run, slot });
          // the tool and the launcher hold their own copies of what they were given: this process lets go of its grant descriptors now, not when the tool ends
          await grants.close();
          await opts.afterSpawn?.();
          killOnAbort(child, signal);
          const src = child.stdout as Readable;
          const done = watch(child);
          (child.stdin as import("node:stream").Writable).on("error", () => undefined);
          (child.stdin as import("node:stream").Writable).end(names.map((n) => n + "\0").join(""));
          src.pipe(out, { end: false });
          // a download nobody reads: the pipe is paused (the reader is slow or gone) for longer than the stall time ends the tool, as a stalled search reader is released
          let blockedSince = 0;
          src.on("pause", () => (blockedSince = Date.now()));
          src.on("resume", () => (blockedSince = 0));
          const stall = setInterval(() => {
            if (blockedSince && Date.now() - blockedSince > zipLimits.stallMs) out.destroy(new Error("download stopped: it was not read in time"));
          }, 250);
          out.on("close", () => clearInterval(stall));
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
          await done; // the folder stays pinned until the tool has finished
          clearInterval(stall);
        } finally {
          await grants.close();
        }
      });
    } catch (e) {
      out.destroy(e as Error);
    } finally {
      slot.release();
    }
  })();
  return out;
}
