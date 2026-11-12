import { spawnSync, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { FsError } from "./fsops.ts";
import { isLauncherFailure, sandboxInfo, spawnSandboxed, type Root } from "./sandbox.ts";

/**
 * 7-Zip (`7zz`) backs everything bsdtar cannot do: writing AES-256 zip and 7z
 * (with optional header encryption), split volumes, and reading encrypted
 * archives. Passwords are NEVER put on the command line or in the environment:
 * 7-Zip reads them from stdin when it needs one, so they cannot show up in a
 * process listing, a log line or an error message (see `scrub`).
 */

export const sevenZip = () => process.env.FILEDECK_7Z || "7zz";
const ENV = { ...process.env, LC_ALL: "C.UTF-8", LANG: "C.UTF-8" };

let have: boolean | undefined;
export function haveSevenZip(): boolean {
  if (have === undefined || process.env.FILEDECK_7Z_RECHECK) have = spawnSync(sevenZip(), ["--help"], { stdio: "ignore", env: ENV }).error === undefined;
  return have;
}

/** The sandbox launcher could not start an archive tool (a step failed, too many folders, Landlock gone): never answered by trying another tool. */
export class SandboxError extends FsError {
  constructor(detail: string) {
    console.error("sandbox launcher failed:", detail);
    super(500, "the sandbox could not start the archive tool");
  }
}
/** Throws a `SandboxError` when the output of a failed start is the launcher's own (the tool did not run). */
export function failIfLauncher(code: number | null, text: string): void {
  if (isLauncherFailure(code, text)) throw new SandboxError(text.split("\n").find((l) => l.includes("filedeck-sandbox:")) ?? text.slice(0, 200));
}

export class PasswordError extends FsError {
  constructor(public code: "password_required" | "password_incorrect", message: string) {
    super(401, message, { code });
  }
}

export const MAX_PASSWORD = 256;
/** Passwords travel base64-encoded in a header; stdin is line based, so newlines are refused. */
export function validPassword(p: unknown): string | undefined {
  if (p === undefined || p === null || p === "") return undefined;
  if (typeof p !== "string" || p.length > MAX_PASSWORD || /[\0\r\n]/.test(p)) throw new FsError(400, "invalid password");
  return p;
}
/** The password a client sent, from the `x-filedeck-password` header (base64 of UTF-8). */
export function passwordFromHeader(v: string | undefined): string | undefined {
  if (!v) return undefined;
  if (v.length > 4 * MAX_PASSWORD) throw new FsError(400, "invalid password");
  if (!/^[A-Za-z0-9+/=]+$/.test(v)) throw new FsError(400, "invalid password");
  return validPassword(Buffer.from(v, "base64").toString("utf8"));
}

/** Remove a secret (and its JSON/URL-ish spellings) from text that may reach a log, an error or a job record. */
export function scrub(text: string, secret?: string): string {
  if (!secret) return text;
  let out = text.split(secret).join("***");
  for (const s of [encodeURIComponent(secret), JSON.stringify(secret).slice(1, -1), Buffer.from(secret).toString("base64")]) if (s && s !== secret) out = out.split(s).join("***");
  return out;
}

export interface SzProc {
  child: ChildProcess;
  out: Readable;
  done: Promise<{ code: number | null; text: string }>;
}

/**
 * How 7-Zip reaches the archive it reads. Inside the Landlock sandbox the launcher closes every descriptor it was handed, so
 * 7-Zip opens the archive by name and the kernel rule is attached to the archive's own file (`file`, an open descriptor of this
 * process): a name swapped for something else afterwards is simply not openable. Without the sandbox (fallback or off) there is
 * no such rule, so the open descriptor itself is handed over as descriptor 3 and read as /dev/fd/3.
 */
export interface SzSource {
  /** the name to give 7-Zip */
  arg: string;
  /** an open descriptor of the archive (this process's) */
  file?: number;
  /** open descriptors of the other parts of a split set */
  also?: number[];
  /** other roots 7-Zip may read (a private folder holding copies of the parts) */
  roots?: Root[];
  /** archive format, for descriptors (no extension to go by) */
  type?: string;
  /** run 7-Zip as this user and group (the agent as root parses an untrusted archive as nobody, not as itself) */
  runAs?: { uid: number; gid: number };
}

/** Where 7-Zip is allowed to go and who it runs as. */
export interface SzAccess {
  /** read-only roots: paths, or open directory (or file) descriptors */
  readOnly?: Root[];
  /** read-write roots (what 7-Zip writes by name): a private folder */
  readWrite?: Root[];
  /** run as this user and group, supplementary groups cleared (only effective when the agent is root) */
  runAs?: { uid: number; gid: number };
}

/** The name and the confinement for reading `src`: see `SzSource`. */
export async function szReadArgs(src: SzSource): Promise<{ arg: string; fd?: number; readOnly: Root[] }> {
  const info = await sandboxInfo();
  if (info.state === "landlock") return { arg: src.arg, readOnly: [...(src.file !== undefined ? [src.file] : []), ...(src.also ?? []), ...(src.roots ?? [])] };
  if (src.file !== undefined) return { arg: "/dev/fd/3", fd: src.file, readOnly: [] };
  return { arg: src.arg, readOnly: [] };
}

/**
 * Run 7zz with the password (if any) on stdin, inside the sandbox (see sandbox.ts); `text` is a bounded, scrubbed tail of
 * stderr + stdout noise. It can read and write only the roots it is given (and the system folders it needs to start).
 */
export async function runSz(
  args: string[],
  opts: SzAccess & {
    cwd?: string;
    /** the working folder as an open descriptor (exact: see `SandboxOpts.cwdFd`); preferred to `cwd` */
    cwdFd?: number;
    password?: string;
    signal?: AbortSignal;
    onLine?: (l: string) => void;
    stdinExtra?: string;
    /** an open file handed to 7-Zip as descriptor 3 (read it as /dev/fd/3) where there is no kernel confinement */
    fd?: number;
  } = {},
): Promise<SzProc> {
  // 7-Zip sizes its thread pool from the host's core count (128 here), not the pod's CPU limit; two threads is plenty.
  const withThreads = [args[0]!, "-mmt=2", ...args.slice(1)];
  const child = await spawnSandboxed(sevenZip(), withThreads, {
    cwd: opts.cwd,
    cwdFd: opts.cwdFd !== undefined && opts.cwdFd >= 0 ? opts.cwdFd : undefined,
    env: ENV,
    stdio: opts.fd === undefined ? ["pipe", "pipe", "pipe"] : ["pipe", "pipe", "pipe", opts.fd],
    // /dev/urandom: an AES archive needs a random salt and IV
    readOnly: [...(opts.readOnly ?? []), "/dev/urandom"],
    readWrite: opts.readWrite,
    ...(opts.runAs ? { uid: opts.runAs.uid, gid: opts.runAs.gid } : {}),
  });
  const stdin = child.stdin as Writable;
  stdin.on("error", () => undefined);
  // two lines: 7-Zip asks twice when creating an encrypted archive
  stdin.end(opts.password ? `${opts.password}\n${opts.password}\n` : "");
  const kill = () => {
    child.kill("SIGKILL");
    child.stdout?.destroy();
  };
  if (opts.signal) {
    if (opts.signal.aborted) kill();
    else {
      opts.signal.addEventListener("abort", kill, { once: true });
      child.on("close", () => opts.signal!.removeEventListener("abort", kill));
    }
  }
  let tail = "";
  const note = (l: string) => {
    if (!l.trim()) return;
    tail = (tail + "\n" + l).slice(-4000);
  };
  const errLines = createInterface({ input: child.stderr as Readable });
  errLines.on("line", note);
  const out = child.stdout as Readable;
  if (opts.onLine) {
    const rl = createInterface({ input: out });
    rl.on("line", (l) => {
      note(l);
      opts.onLine!(l);
    });
  }
  const done = new Promise<{ code: number | null; text: string }>((resolve) => {
    child.on("error", (e) => resolve({ code: -1, text: (e as NodeJS.ErrnoException).code === "ENOENT" ? "7-Zip is not installed in this image" : e.message }));
    child.on("close", (code) => setImmediate(() => resolve({ code, text: scrub(tail.trim(), opts.password) })));
  });
  return { child, out, done };
}

/** Map a failed 7zz run to the right client-visible error. */
export function szFailure(code: number | null, text: string, password: string | undefined, what: string): never {
  failIfLauncher(code, text);
  const t = text.toLowerCase();
  const wants = t.includes("enter password") || t.includes("break signaled") || t.includes("cannot open encrypted archive") || t.includes("wrong password") || t.includes("data error in encrypted") || t.includes("crc failed in encrypted");
  if (wants) {
    if (!password) throw new PasswordError("password_required", "this archive is password protected");
    throw new PasswordError("password_incorrect", "wrong password");
  }
  if (text.includes("not installed")) throw new FsError(501, text);
  throw new FsError(400, `${what}: ${text.split("\n").find((l) => /error/i.test(l))?.replace(/^ERROR:\s*/i, "").slice(0, 200) || (code === null ? "terminated" : "unsupported or damaged archive")}`);
}

export interface SzEntry {
  name: string;
  type: "file" | "dir" | "symlink" | "other";
  size: number;
  date: string;
  encrypted: boolean;
  link?: string;
}

/** Parse `7zz l -slt -ba` records (blank-line separated `Key = value` blocks). */
export function parseSlt(chunk: string): SzEntry | null {
  const f: Record<string, string> = {};
  for (const l of chunk.split("\n")) {
    const i = l.indexOf(" = ");
    if (i > 0) f[l.slice(0, i)] = l.slice(i + 3);
    else if (l.endsWith(" =")) f[l.slice(0, -2)] = "";
  }
  if (f.Path === undefined) return null;
  const attr = (f.Attributes ?? "").trim();
  const isDir = f.Folder === "+" || /^D/.test(attr) || /^d/.test(attr.replace(/^\S*\s+/, ""));
  const isLink = /^[Ll]/.test(attr.replace(/^\S*\s+/, "")) && !isDir;
  return {
    name: f.Path.replace(/\\/g, "/"),
    type: isDir ? "dir" : isLink ? "symlink" : "file",
    size: Number(f.Size || 0) || 0,
    date: (f.Modified ?? "").slice(0, 16),
    encrypted: f.Encrypted === "+",
  };
}

export interface SzList {
  entries: SzEntry[];
  truncated: boolean;
  encrypted: boolean;
}

/** List an archive with 7-Zip. Throws PasswordError when a password is needed or wrong (header-encrypted 7z). */
export async function listSz(real: string | SzSource, password: string | undefined, signal: AbortSignal, limit = Infinity): Promise<SzList> {
  const entries: SzEntry[] = [];
  let buf = "";
  let stopped = false;
  let proc: SzProc;
  // Encryption is a per-file flag, so a listing cut at `limit` keeps reading (without keeping entries)
  // until the first file entry has been seen: a folder-first archive is still recognised as encrypted.
  let sawFile = false;
  let enc = false;
  const push = (block: string) => {
    const e = parseSlt(block);
    if (!e || stopped) return;
    if (e.type === "file") {
      sawFile = true;
      if (e.encrypted) enc = true;
    }
    if (entries.length >= limit) {
      if (sawFile) {
        stopped = true;
        proc.child.kill("SIGKILL");
        proc.child.stdout?.destroy();
      }
    } else entries.push(e);
  };
  const src = typeof real === "string" ? null : real;
  const how = src ? await szReadArgs(src) : { arg: real as string, fd: undefined, readOnly: [real as string] };
  proc = await runSz(["l", "-slt", "-ba", "-spd", ...(src?.type ? [`-t${src.type}`] : []), "--", how.arg], {
    password,
    signal,
    fd: how.fd,
    readOnly: how.readOnly,
    runAs: src?.runAs,
    onLine: (l) => {
      if (l === "") {
        if (buf) push(buf);
        buf = "";
      } else buf += l + "\n";
    },
  });
  const { code, text } = await proc.done;
  if (buf && !stopped) push(buf);
  if (!stopped && code !== 0) szFailure(code, text, password, "cannot read archive");
  return { entries, truncated: stopped, encrypted: enc || entries.some((e) => e.encrypted) };
}

/**
 * Verify a password against an encrypted archive by test-extracting its
 * smallest encrypted file (a zip/7z password check needs real ciphertext).
 */
export async function verifyPassword(real: string | SzSource, entries: SzEntry[], password: string | undefined, signal: AbortSignal): Promise<void> {
  const enc = entries.filter((e) => e.encrypted && e.type === "file");
  if (!enc.length) return;
  if (!password) throw new PasswordError("password_required", "this archive is password protected");
  const pick = enc.reduce((a, b) => (b.size < a.size ? b : a));
  const src = typeof real === "string" ? null : real;
  const how = src ? await szReadArgs(src) : { arg: real as string, fd: undefined, readOnly: [real as string] };
  const { code, text } = await (await runSz(["t", "-spd", ...(src?.type ? [`-t${src.type}`] : []), "--", how.arg, pick.name], { password, signal, fd: how.fd, readOnly: how.readOnly, runAs: src?.runAs })).done;
  if (code !== 0) szFailure(code, text, password, "cannot read archive");
}
