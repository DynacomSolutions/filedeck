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
  zip: { ext: ".zip", args: ["--format", "zip"] },
  "tar.gz": { ext: ".tar.gz", args: ["-z"] },
  "tar.zst": { ext: ".tar.zst", args: ["--zstd"] },
  "7z": { ext: ".7z", args: ["--format", "7zip"] },
} as const;
export type Format = keyof typeof FORMATS;

const EXTRACT_EXT = [".tar.gz", ".tar.bz2", ".tar.xz", ".tar.zst", ".tar.lz4", ".tgz", ".tbz2", ".txz", ".tzst", ".tar", ".zip", ".7z", ".jar", ".war", ".whl", ".rar"];
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

export async function listArchive(root: string, p: string, limit = 5000) {
  const r = resolveRead(root, p);
  const st = await fs.stat(r.real);
  if (!st.isFile()) throw new ArchiveError(400, "not a regular file");
  const entries: ListedEntry[] = [];
  const signal = AbortSignal.timeout(30_000);
  let total = 0;
  const { stopped } = await streamList(r.real, signal, (e) => {
    if (entries.length >= limit) return false;
    entries.push(e);
    total += e.type === "file" ? e.size : 0;
  });
  return { path: r.virtual, entries, truncated: stopped, bytes: total };
}

export interface ExtractPlan {
  archiveReal: string;
  archiveName: string;
  destReal: string;
  destVirtual: string;
  subfolder: boolean;
}

export async function prepareExtract(root: string, archive: string, destDir: string, subfolder: boolean): Promise<ExtractPlan> {
  const a = resolveRead(root, archive);
  assertNotTrash(a.virtual);
  const st = await fs.stat(a.real);
  if (!st.isFile()) throw new ArchiveError(400, "not a regular file");
  const d = resolveRead(root, destDir);
  assertNotTrash(d.virtual);
  const ds = await fs.stat(d.real);
  if (!ds.isDirectory()) throw new ArchiveError(400, "destination is not a directory");
  return { archiveReal: a.real, archiveName: path.basename(a.real), destReal: d.real, destVirtual: d.virtual, subfolder };
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

export async function runExtract(plan: ExtractPlan, limits: ArchiveLimits, ctl: JobCtl) {
  const staging = await fs.mkdtemp(path.join(plan.destReal, `.filedeck-extract-`));
  await fs.chmod(staging, 0o755);
  const ac = new AbortController();
  const stop = () => ac.abort();
  ctl.signal.addEventListener("abort", stop, { once: true });
  try {
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
    let result: ExtractResult;
    try {
      result = await extractTar(child.stdout as Readable, staging, limits, { signal: ac.signal, progress: ctl.progress });
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
    let finalVirtual: string;
    if (plan.subfolder) {
      const name = await freeName(plan.destReal, archiveBase(plan.archiveName));
      await fs.rename(staging, path.join(plan.destReal, name));
      finalVirtual = virtualJoin(plan.destVirtual, name);
    } else {
      for (const n of await fs.readdir(staging)) {
        await fs.rename(path.join(staging, n), path.join(plan.destReal, await freeName(plan.destReal, n)));
      }
      await fs.rmdir(staging);
      finalVirtual = plan.destVirtual;
    }
    ctl.progress.bytes = result.bytes;
    return { ...result, path: finalVirtual };
  } catch (e) {
    await fs.rm(staging, { recursive: true, force: true });
    throw e;
  } finally {
    ctl.signal.removeEventListener("abort", stop);
  }
}

/* --------------------------------------------------------------- compress */

export interface CompressPlan {
  dirReal: string;
  dirVirtual: string;
  names: string[];
  format: Format;
  outName: string;
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

export async function prepareCompress(root: string, dir: string, names: string[], format: string, name?: string): Promise<CompressPlan> {
  if (!(format in FORMATS)) throw new ArchiveError(400, "unsupported format");
  const f = format as Format;
  const { d, names: uniq } = await prepareSelection(root, dir, names);
  let base = (name ?? "").trim() || (uniq.length === 1 ? uniq[0]! : path.posix.basename(d.virtual) || "archive");
  const ext = FORMATS[f].ext;
  if (!base.toLowerCase().endsWith(ext)) base += ext;
  virtualJoin(d.virtual, base);
  return { dirReal: d.real, dirVirtual: d.virtual, names: uniq, format: f, outName: base };
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
  const tmp = path.join(plan.dirReal, `.${randomUUID().slice(0, 8)}.filedeck-archive.part`);
  // -T lists are not subject to the "@archive" syntax, so literal names are safe.
  const args = ["--null", "-v", ...FORMATS[plan.format].args, "-cf", tmp, "-T", "-"];
  const child = tool(args, { cwd: plan.dirReal, stdin: true });
  killOnAbort(child, ctl.signal);
  const done = watch(child, (l) => {
    if (!l.startsWith("a ")) return;
    const rel = l.slice(2).replace(/^\.\//, "").replace(/\/$/, "");
    ctl.progress.entries++;
    ctl.progress.bytes += sizes.get(rel) ?? 0;
    ctl.progress.current = rel;
  });
  (child.stdin as import("node:stream").Writable).on("error", () => undefined);
  (child.stdin as import("node:stream").Writable).end(plan.names.map((n) => n + "\0").join(""));
  try {
    const { code, err } = await done;
    if (ctl.signal.aborted) throw new Error("canceled");
    if (code !== 0) throw new ArchiveError(500, `compression failed: ${err.split("\n").pop() || "unknown error"}`);
    const out = await freeName(plan.dirReal, plan.outName);
    await fs.rename(tmp, path.join(plan.dirReal, out));
    const st = await fs.stat(path.join(plan.dirReal, out));
    return { path: virtualJoin(plan.dirVirtual, out), size: st.size };
  } catch (e) {
    await fs.rm(tmp, { force: true });
    throw e;
  }
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
