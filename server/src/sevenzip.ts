import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { FsError } from "./fsops.ts";

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

/** Run 7zz with the password (if any) on stdin; `text` is a bounded, scrubbed tail of stderr + stdout noise. */
export function runSz(args: string[], opts: { cwd?: string; password?: string; signal?: AbortSignal; onLine?: (l: string) => void; stdinExtra?: string } = {}): SzProc {
  // 7-Zip sizes its thread pool from the host's core count (128 here), not the pod's CPU limit; two threads is plenty.
  const withThreads = [args[0]!, "-mmt=2", ...args.slice(1)];
  const child = spawn(sevenZip(), withThreads, { cwd: opts.cwd, env: ENV, stdio: ["pipe", "pipe", "pipe"] });
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
export async function listSz(real: string, password: string | undefined, signal: AbortSignal, limit = Infinity): Promise<SzList> {
  const entries: SzEntry[] = [];
  let buf = "";
  let stopped = false;
  let proc: SzProc;
  const push = (block: string) => {
    const e = parseSlt(block);
    if (e && !stopped) {
      if (entries.length >= limit) {
        stopped = true;
        proc.child.kill("SIGKILL");
        proc.child.stdout?.destroy();
      } else entries.push(e);
    }
  };
  proc = runSz(["l", "-slt", "-ba", "-spd", "--", real], {
    password,
    signal,
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
  return { entries, truncated: stopped, encrypted: entries.some((e) => e.encrypted) };
}

/**
 * Verify a password against an encrypted archive by test-extracting its
 * smallest encrypted file (a zip/7z password check needs real ciphertext).
 */
export async function verifyPassword(real: string, entries: SzEntry[], password: string | undefined, signal: AbortSignal): Promise<void> {
  const enc = entries.filter((e) => e.encrypted && e.type === "file");
  if (!enc.length) return;
  if (!password) throw new PasswordError("password_required", "this archive is password protected");
  const pick = enc.reduce((a, b) => (b.size < a.size ? b : a));
  const { code, text } = await runSz(["t", "-spd", "--", real, pick.name], { password, signal }).done;
  if (code !== 0) szFailure(code, text, password, "cannot read archive");
}
