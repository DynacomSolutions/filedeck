import { spawn, type ChildProcess } from "node:child_process";
import { constants as C } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import type { Readable } from "node:stream";
import { FsError } from "./fsops.ts";
import type { JobCtl } from "./jobs.ts";
import { TRASH_DIR, assertNotTrash, resolveRead, resolveWrite, virtualJoin } from "./paths.ts";
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
  return b || "extracted";
}

function tool(args: string[], opts: { cwd?: string; stdin?: boolean } = {}): ChildProcess {
  const child = spawn(bsdtar(), args, {
    cwd: opts.cwd,
    env: ENV,
    stdio: [opts.stdin ? "pipe" : "ignore", "pipe", "pipe"],
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
      if (segs.includes(TRASH_DIR)) throw new ArchiveError(400, "unsafe archive entry: reserved name");
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
      if (h.mtime > 0) await fs.utimes(target, h.mtime, h.mtime).catch(() => undefined);
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
): Promise<{ stopped: boolean }> {
  const child = tool(["-tvf", real]);
  killOnAbort(child, signal);
  const done = watch(child);
  let stopped = false;
  const rl = createInterface({ input: child.stdout as Readable });
  for await (const line of rl) {
    const e = parseListLine(line);
    if (!e) continue; // continuation of a name with a newline, or noise
    if (onEntry(e) === false) {
      stopped = true;
      terminate(child);
      break;
    }
  }
  const { code, err } = await done;
  if (!stopped && !signal.aborted && code !== 0) throw new ArchiveError(400, `cannot read archive: ${err.split("\n")[0] || "unsupported format"}`);
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
  return { archiveReal: a.real, archiveName: path.basename(a.real), destReal: d.real, destVirtual: d.virtual, subfolder, overwrite, entries: o.entries ?? [], password: viaSz ? o.password : undefined, viaSz };
}

async function exists(p: string) {
  return fs.lstat(p).then(() => true, () => false);
}
async function freeName(dir: string, name: string): Promise<string> {
  if (!(await exists(path.join(dir, name)))) return name;
  const dot = name.lastIndexOf(".");
  const [b, e] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
  for (let i = 2; i < 10000; i++) {
    const c = `${b} (${i})${e}`;
    if (!(await exists(path.join(dir, c)))) return c;
  }
  throw new ArchiveError(409, "cannot find a free name");
}

/** rename(2), falling back to copy+unlink when the destination is another filesystem (a mount inside the target folder). */
async function moveInto(from: string, to: string) {
  try {
    await fs.rename(from, to);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EXDEV") throw e;
    const st = await fs.lstat(from);
    if (st.isDirectory()) {
      await fs.mkdir(to, { mode: 0o755 });
      for (const n of await fs.readdir(from)) await moveInto(path.join(from, n), path.join(to, n));
      await fs.rmdir(from);
    } else {
      await fs.copyFile(from, to, C.COPYFILE_EXCL);
      await fs.unlink(from);
    }
  }
}

interface MergeStats {
  replaced: number;
  skippedExisting: number;
}
/** Merge `src` (staging, trusted) into the existing folder `dst` under the overwrite/skip policy. Never follows a link in `dst`. */
async function mergeInto(src: string, dst: string, policy: "overwrite" | "skip", stats: MergeStats): Promise<void> {
  for (const n of await fs.readdir(src)) {
    const s = path.join(src, n);
    const t = path.join(dst, n);
    const ss = await fs.lstat(s);
    const ts = await fs.lstat(t).catch(() => null);
    if (!ts) {
      await moveInto(s, t);
    } else if (ss.isDirectory() && ts.isDirectory()) {
      await mergeInto(s, t, policy, stats);
    } else if (policy === "skip" || ts.isDirectory() || ss.isDirectory()) {
      stats.skippedExisting++; // a file never replaces a folder (or the reverse): that would delete data
    } else {
      await fs.unlink(t); // a symlink here is replaced itself, not followed
      await moveInto(s, t);
      stats.replaced++;
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
    for (const n of await fs.readdir(dir)) {
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

/** Extract an encrypted zip/7z with 7-Zip into `staging`; names and links are vetted from the listing first. */
async function extractViaSz(plan: ExtractPlan, staging: string, limits: ArchiveLimits, ctl: JobCtl, signal: AbortSignal): Promise<ExtractResult> {
  const l = await listSz(plan.archiveReal, plan.password, signal);
  const sizes = new Map<string, number>();
  const skip: string[] = [];
  let bytes = 0;
  for (const e of l.entries) {
    const segs = safeSegments(e.name); // the whole archive is refused if any name is hostile
    if (segs.includes(TRASH_DIR)) throw new ArchiveError(400, "unsafe archive entry: reserved name");
    if (e.type === "symlink" || e.type === "other") skip.push(e.name);
    if (e.type === "file") bytes += e.size;
    sizes.set(segs.join("/"), e.size);
    if (sizes.size > limits.maxEntries) throw new ArchiveError(413, "archive exceeds the configured limits");
    if (bytes > limits.maxBytes) throw new ArchiveError(413, "archive exceeds the configured limits");
  }
  ctl.progress.totalEntries = sizes.size;
  ctl.progress.totalBytes = bytes;
  const args = ["x", `-o${staging}`, "-aoa", "-spd", "-bb1", "-bso1", "-bsp0", ...skip.map((n) => `-x!${n}`), "--", plan.archiveReal];
  const proc = runSz(args, {
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
  const staging = await fs.mkdtemp(path.join(plan.destReal, `.filedeck-extract-`));
  await fs.chmod(staging, 0o755);
  const ac = new AbortController();
  const stop = () => ac.abort();
  ctl.signal.addEventListener("abort", stop, { once: true });
  try {
    let result: ExtractResult;
    if (plan.viaSz) {
      result = await extractViaSz(plan, staging, limits, ctl, ac.signal);
    } else {
      // Totals for the progress bar come from a parallel listing; extraction
      // itself never trusts them.
      const scan = streamList(plan.archiveReal, ac.signal, (e) => {
        ctl.progress.totalEntries++;
        if (e.type === "file") ctl.progress.totalBytes += e.size;
        if (ctl.progress.totalBytes > limits.maxBytes || ctl.progress.totalEntries > limits.maxEntries) {
          ac.abort(new ArchiveError(413, "archive exceeds the configured limits"));
          return false;
        }
      }).catch(() => undefined);
      const child = tool(["--format=pax", "-cf", "-", "@" + plan.archiveReal]);
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
    if (plan.subfolder) {
      const base = archiveBase(plan.archiveName);
      if (plan.overwrite !== "rename" && (await exists(path.join(plan.destReal, base))) && (await fs.lstat(path.join(plan.destReal, base))).isDirectory()) {
        await mergeInto(staging, path.join(plan.destReal, base), plan.overwrite, stats);
        await fs.rm(staging, { recursive: true, force: true });
        finalVirtual = virtualJoin(plan.destVirtual, base);
      } else {
        const name = await freeName(plan.destReal, base);
        await moveInto(staging, path.join(plan.destReal, name));
        finalVirtual = virtualJoin(plan.destVirtual, name);
      }
    } else if (plan.overwrite === "rename") {
      for (const n of await fs.readdir(staging)) {
        await moveInto(path.join(staging, n), path.join(plan.destReal, await freeName(plan.destReal, n)));
      }
      await fs.rmdir(staging);
      finalVirtual = plan.destVirtual;
    } else {
      await mergeInto(staging, plan.destReal, plan.overwrite, stats);
      await fs.rm(staging, { recursive: true, force: true });
      finalVirtual = plan.destVirtual;
    }
    ctl.progress.bytes = result.bytes;
    return { ...result, ...stats, path: finalVirtual };
  } catch (e) {
    await fs.rm(staging, { recursive: true, force: true });
    throw e;
  } finally {
    ctl.signal.removeEventListener("abort", stop);
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
  const sizes = new Map<string, number>();
  for (const n of plan.names) await walkSizes(plan.dirReal, n, sizes, limits, ctl.signal);
  ctl.progress.totalEntries = sizes.size;
  ctl.progress.totalBytes = [...sizes.values()].reduce((a, b) => a + b, 0);
  // Written into a private folder next to the destination and moved into place when complete.
  const work = await fs.mkdtemp(path.join(plan.outReal, `.filedeck-archive-`));
  const tmp = path.join(work, plan.outName);
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
      args.push("--", tmp, ...plan.names.map((n) => "./" + n));
      const proc = runSz(args, {
        cwd: plan.dirReal,
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
      const args = ["--null", "-v", ...FORMATS[plan.format].args, ...(opt ? ["--options", opt] : []), ...plan.exclude.map((x) => `--exclude=${x}`), "-cf", tmp, "-T", "-"];
      const child = tool(args, { cwd: plan.dirReal, stdin: true });
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
    const produced = (await fs.readdir(work)).filter((n) => n === plan.outName || n.startsWith(plan.outName + "."));
    if (!produced.length) throw new ArchiveError(500, "compression produced no archive");
    const out = await freeSetName(plan.outReal, plan.outName, produced.map((n) => n.slice(plan.outName.length)));
    let size = 0;
    for (const n of produced) {
      const to = path.join(plan.outReal, out + n.slice(plan.outName.length));
      await moveInto(path.join(work, n), to);
      size += (await fs.stat(to)).size;
    }
    await fs.rm(work, { recursive: true, force: true });
    // for volumes the path is the first part (name.7z.001), which 7-Zip opens together with its siblings
    return { path: virtualJoin(plan.outVirtual, out + (plan.splitBytes ? ".001" : "")), size, volumes: plan.splitBytes ? produced.length : undefined };
  } catch (e) {
    await fs.rm(work, { recursive: true, force: true });
    throw e;
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
  const child = tool(["--null", "--format", "zip", "-cf", "-", "-T", "-"], { cwd: dirReal, stdin: true });
  killOnAbort(child, signal);
  const out = child.stdout as Readable;
  const done = watch(child);
  (child.stdin as import("node:stream").Writable).on("error", () => undefined);
  (child.stdin as import("node:stream").Writable).end(names.map((n) => n + "\0").join(""));
  void done.then(({ code, err }) => {
    if (code !== 0 && !signal.aborted) out.destroy(new Error(err || "zip failed")); // truncated body: the browser shows a failed download
  });
  out.on("close", () => terminate(child));
  return out;
}
