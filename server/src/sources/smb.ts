import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { PassThrough, Transform, type Readable } from "node:stream";
import { FsError } from "../fsops.ts";
import { cleanVirtual } from "../paths.ts";
import type { Credentials, SourceBackend, SourceConfig, SourceEntry, SourceStat } from "./types.ts";

const META_TIMEOUT_MS = 60_000;
const MAX_PROCS = 6;
const ERR_CAP = 64 * 1024;

export interface SmbOptions {
  /** share name on the server (required) */
  share?: string;
  /** NetBIOS domain / workgroup */
  domain?: string;
  /** minimum protocol passed to smbclient, e.g. "SMB2" (default) or "SMB3" */
  minProtocol?: string;
}

/**
 * Map smbclient output to an FsError. smbclient's exit codes are unreliable
 * (a failed mkdir still exits 0), so errors are recognised from the
 * NT_STATUS text it prints. The text itself (host, share, path) is never passed on.
 */
export function smbError(text: string, what = "request"): FsError | null {
  const m = /NT_STATUS_[A-Z0-9_]+/.exec(text);
  const setup = /session setup failed|tree connect failed|Anonymous login/i.test(text);
  if (m) {
    const s = m[0];
    if (setup && /LOGON_FAILURE|ACCESS_DENIED|WRONG_PASSWORD|ACCOUNT_|PASSWORD_|NO_LOGON_SERVERS|LOGON_TYPE/.test(s)) return new FsError(502, "authentication failed");
    if (/BAD_NETWORK_NAME/.test(s)) return new FsError(502, "share not found on the server");
    if (/NO_SUCH_FILE|OBJECT_NAME_NOT_FOUND|OBJECT_PATH_NOT_FOUND|NO_SUCH_DEVICE|NOT_FOUND/.test(s)) return new FsError(404, "not found");
    if (/ACCESS_DENIED|SHARING_VIOLATION|PRIVILEGE_NOT_HELD/.test(s)) return new FsError(403, "permission denied");
    if (/COLLISION|NAME_EXISTS|ALREADY_EXISTS|DIRECTORY_NOT_EMPTY/.test(s)) return new FsError(409, "already exists or not empty");
    if (/FILE_IS_A_DIRECTORY|NOT_A_DIRECTORY|INVALID_PARAMETER|OBJECT_NAME_INVALID/.test(s)) return new FsError(400, "invalid for this entry type or name");
    if (/DISK_FULL|QUOTA/.test(s)) return new FsError(507, "no space left on server");
    if (/CONNECTION_REFUSED|HOST_UNREACHABLE|NETWORK_UNREACHABLE|IO_TIMEOUT|CONNECTION_DISCONNECTED|CONNECTION_RESET/.test(s)) return new FsError(502, "connection failed");
    return new FsError(502, `remote ${what} failed`);
  }
  if (/Connection to .* failed|Unable to initialize messaging|failed to connect/i.test(text)) return new FsError(502, "connection failed");
  return null;
}

const BAD_NAME = /["\\*?<>|:\x00-\x1f]/;
const LS_LINE = /^ {2}(.+?)\s+([ADHSRN]*)\s+(\d+)\s+(\w{3}\s+\w{3}\s+\d{1,2}\s+\d\d:\d\d:\d\d\s+\d{4})\s*$/;

/** Parse the entry lines of `ls` output (header/summary lines are skipped). */
export function parseLs(out: string): SourceEntry[] {
  const res: SourceEntry[] = [];
  for (const line of out.split("\n")) {
    const m = LS_LINE.exec(line.replace(/\r$/, ""));
    if (!m) continue;
    const [, name, attr, size, date] = m as unknown as [string, string, string, string, string];
    const isDir = attr.includes("D");
    const t = Date.parse(date.replace(/\s+/g, " ") + " UTC"); // server times carry no zone; treat as UTC consistently
    res.push({ name, type: isDir ? "dir" : "file", size: isDir ? 0 : Number(size), mtime: Number.isFinite(t) ? t : 0, mode: isDir ? 0o755 : attr.includes("R") ? 0o444 : 0o644 });
  }
  return res;
}

/** Counting semaphore so a busy hub cannot fork an unbounded number of smbclient processes. */
class Slots {
  private used = 0;
  private waiting: (() => void)[] = [];
  async take(): Promise<() => void> {
    while (this.used >= MAX_PROCS) await new Promise<void>((r) => this.waiting.push(r));
    this.used++;
    let done = false;
    return () => {
      if (done) return;
      done = true;
      this.used--;
      this.waiting.shift()?.();
    };
  }
}

/**
 * SMB/CIFS source driven by the `smbclient` binary (Samba client, installed in
 * the image), one short-lived process per operation. Credentials (`username`,
 * `password`, optional `domain`) come from the Secret and reach smbclient
 * through its environment, never its command line. Limits: modification times
 * of uploads are not preserved, names may not contain `" \ * ? < > | :`, and a
 * ranged read streams from the start and discards the head.
 */
export class SmbBackend implements SourceBackend {
  readonly type = "smb";
  private readonly host: string;
  private readonly port: string | undefined;
  private readonly share: string;
  private readonly root: string[];
  private readonly opts: SmbOptions;
  private readonly slots = new Slots();
  private readonly bin: string;

  constructor(
    cfg: SourceConfig,
    private readonly creds: () => Promise<Credentials>,
  ) {
    this.opts = (cfg.options ?? {}) as SmbOptions;
    if (!this.opts.share || BAD_NAME.test(this.opts.share)) throw new Error(`source ${cfg.name}: options.share is required for smb`);
    this.share = this.opts.share;
    const m = /^(.*?)(?::(\d+))?$/.exec(cfg.host) as RegExpExecArray;
    this.host = m[1] as string;
    this.port = m[2];
    this.root = cleanVirtual(cfg.root || "/");
    for (const seg of this.root) if (BAD_NAME.test(seg)) throw new Error(`source ${cfg.name}: root contains characters SMB does not allow`);
    this.bin = process.env.FILEDECK_SMBCLIENT || "smbclient";
  }

  /** backslash path below the share for a virtual path; "" for the share root */
  private win(virtual: string): string {
    const parts = cleanVirtual(virtual);
    for (const seg of parts) if (BAD_NAME.test(seg)) throw new FsError(400, "name not allowed on an SMB share");
    return [...this.root, ...parts].join("\\");
  }
  private q(path: string): string {
    return `"${path}"`;
  }

  /** `fromStdin`: smbclient must read an upload from a real pipe (`put /dev/stdin` cannot open the socket Node gives a child), so `cat` sits in front of it. */
  private async launch(cmd: string, fromStdin = false): Promise<{ child: ChildProcess; release: () => void }> {
    const c = await this.creds();
    const release = await this.slots.take();
    const args = [`//${this.host}/${this.share}`, "-s", "/dev/null", "-d", "0"];
    // smbclient wants writable state dirs; the hub's root filesystem is read-only, /tmp is an emptyDir.
    for (const o of ["lock directory", "cache directory", "state directory", "private dir"]) args.push(`--option=${o}=/tmp`);
    args.push(`--option=client min protocol=${this.opts.minProtocol ?? "SMB2"}`);
    if (this.port) args.push("-p", this.port);
    const domain = c.domain ?? this.opts.domain;
    if (domain) args.push("-W", domain);
    if (c.username) args.push("-U", c.username);
    else args.push("-N");
    args.push("-c", cmd);
    const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: "/tmp", LANG: "C", TZ: "UTC", ...(c.password ? { PASSWD: c.password } : {}) };
    for (const k of Object.keys(process.env)) if (k.startsWith("FAKE_SMB_")) env[k] = process.env[k]; // test fixture knobs
    const child = fromStdin
      ? spawn("sh", ["-c", 'cat | "$@"', "sh", this.bin, ...args], { env, stdio: ["pipe", "pipe", "pipe"], detached: true })
      : spawn(this.bin, args, { env, stdio: ["pipe", "pipe", "pipe"] });
    return { child, release };
  }

  /** Run one command to completion and return its output; throws the mapped FsError on failure. */
  private async run(cmd: string, stdin?: Readable, what = "request"): Promise<string> {
    const { child, release } = await this.launch(cmd, stdin !== undefined);
    const kill = () => {
      try {
        if (stdin && child.pid) process.kill(-child.pid, "SIGKILL"); // the whole `cat | smbclient` group
        else child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    };
    let out = "";
    let err = "";
    child.stdout?.on("data", (d: Buffer) => {
      if (out.length < ERR_CAP * 16) out += d.toString("latin1");
    });
    child.stderr?.on("data", (d: Buffer) => {
      if (err.length < ERR_CAP) err += d.toString("latin1");
    });
    child.stdin?.on("error", () => undefined);
    if (stdin) {
      stdin.on("error", kill);
      stdin.pipe(child.stdin as NodeJS.WritableStream);
    } else child.stdin?.end();
    const timer = stdin ? undefined : setTimeout(kill, META_TIMEOUT_MS);
    try {
      const code = await new Promise<number | null>((resolve, reject) => {
        child.on("error", () => reject(new FsError(502, "smbclient is not available")));
        child.on("close", (c, sig) => resolve(sig ? null : c));
      });
      // entry lines of a listing are data (a file may be called NT_STATUS_x); everything else can carry an error
      const text = out.split("\n").filter((l) => !LS_LINE.test(l.replace(/\r$/, ""))).join("\n") + "\n" + err;
      const e = smbError(text, what);
      if (e) throw e;
      if (code === null) throw new FsError(504, "remote timed out");
      if (code !== 0 && !out.trim() && err.trim()) throw new FsError(502, `remote ${what} failed`);
      return out;
    } finally {
      clearTimeout(timer);
      release();
    }
  }

  async ping(): Promise<void> {
    const root = this.root.join("\\");
    await this.run(root ? `ls ${this.q(root + "\\*")}` : "ls", undefined, "ping");
  }

  async list(p: string): Promise<SourceEntry[]> {
    const w = this.win(p);
    const out = await this.run(w ? `ls ${this.q(w + "\\*")}` : "ls", undefined, "listing");
    return parseLs(out).filter((e) => e.name !== "." && e.name !== "..");
  }

  async stat(p: string): Promise<SourceStat | null> {
    if (cleanVirtual(p).length === 0) return { type: "dir", size: 0, mtime: 0, mode: 0o755 };
    try {
      const out = await this.run(`ls ${this.q(this.win(p))}`, undefined, "stat");
      const e = parseLs(out)[0];
      if (!e) return null;
      const { name: _n, ...s } = e;
      return s;
    } catch (e) {
      if (e instanceof FsError && e.status === 404) return null;
      throw e;
    }
  }

  async read(p: string, range?: { start: number; end: number }): Promise<Readable> {
    const { child, release } = await this.launch(`get ${this.q(this.win(p))} -`);
    child.stdin?.end();
    let err = "";
    child.stderr?.on("data", (d: Buffer) => {
      if (err.length < ERR_CAP) err += d.toString("latin1");
    });
    const out = new PassThrough();
    let finished = false;
    const finish = (e?: Error) => {
      if (finished) return;
      finished = true;
      release();
      if (e) out.destroy(e);
      else out.end();
    };
    let src: Readable = child.stdout as Readable;
    if (range) {
      let pos = 0;
      src = src.pipe(
        new Transform({
          transform: (chunk: Buffer, _e, cb) => {
            const from = Math.max(0, range.start - pos);
            const to = Math.min(chunk.length, range.end + 1 - pos);
            pos += chunk.length;
            if (to > from) cb(null, chunk.subarray(from, to));
            else cb();
            if (pos > range.end) child.kill("SIGTERM"); // everything wanted has been read
          },
        }),
      );
    }
    src.pipe(out, { end: false });
    let closed = false;
    let ended = false;
    const settle = (code: number | null, sig: string | null) => {
      if (!closed || !ended) return;
      const e = smbError(err, "read");
      if (e) return finish(e);
      if (!range && (code !== 0 || sig)) return finish(new FsError(502, "remote read failed"));
      finish();
    };
    src.on("end", () => {
      ended = true;
      settle(child.exitCode, child.signalCode);
    });
    child.on("close", (code, sig) => {
      closed = true;
      if (!ended && range) ended = true; // killed once the range was served
      settle(code, sig);
    });
    child.on("error", () => finish(new FsError(502, "smbclient is not available")));
    out.on("close", () => {
      if (!finished) child.kill("SIGKILL"); // consumer went away
      release();
    });
    return out;
  }

  async write(p: string, body: Readable, o: { overwrite: boolean; mtime?: number; size?: number }): Promise<number> {
    const target = this.win(p);
    const existing = await this.stat(p).catch((e) => {
      body.resume();
      throw e;
    });
    if (existing && !o.overwrite) {
      body.resume();
      throw new FsError(409, "destination exists");
    }
    if (existing?.type === "dir") {
      body.resume();
      throw new FsError(409, "destination is a directory");
    }
    const dir = target.includes("\\") ? target.slice(0, target.lastIndexOf("\\") + 1) : "";
    const tmpName = `.${target.slice(dir.length)}.filedeck-${randomUUID().slice(0, 8)}.part`;
    const tmp = dir + tmpName;
    let n = 0;
    const count = new Transform({
      transform(chunk: Buffer, _e, cb) {
        n += chunk.length;
        cb(null, chunk);
      },
    });
    body.on("error", (e) => count.destroy(e));
    try {
      await this.run(`put /dev/stdin ${this.q(tmp)}`, body.pipe(count), "upload");
      if (existing) await this.run(`del ${this.q(target)}`, undefined, "replace");
      await this.run(`rename ${this.q(tmp)} ${this.q(target)}`, undefined, "upload");
    } catch (e) {
      await this.run(`del ${this.q(tmp)}`, undefined, "cleanup").catch(() => undefined);
      throw e;
    }
    return n;
  }

  async mkdir(p: string): Promise<void> {
    await this.run(`mkdir ${this.q(this.win(p))}`, undefined, "mkdir");
  }

  async rename(from: string, to: string, overwrite: boolean): Promise<void> {
    const dst = await this.stat(to);
    if (dst && !overwrite) throw new FsError(409, "destination exists");
    if (dst?.type === "dir") throw new FsError(409, "destination exists");
    if (dst) await this.run(`del ${this.q(this.win(to))}`, undefined, "replace");
    await this.run(`rename ${this.q(this.win(from))} ${this.q(this.win(to))}`, undefined, "rename");
  }

  async remove(p: string, isDir: boolean): Promise<void> {
    await this.run(`${isDir ? "rmdir" : "del"} ${this.q(this.win(p))}`, undefined, "delete");
  }

  async close(): Promise<void> {}
}
