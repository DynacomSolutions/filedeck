import { randomUUID } from "node:crypto";
import { Transform, type Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import path from "node:path";
import { Client, type SFTPWrapper, type Stats, type FileEntryWithStats } from "ssh2";
import { FsError } from "../fsops.ts";
import { cleanVirtual } from "../paths.ts";
import type { Credentials, SourceBackend, SourceConfig, SourceEntry, SourceStat } from "./types.ts";

const STATUS_NO_SUCH_FILE = 2;
const STATUS_PERMISSION_DENIED = 3;
const TIMEOUT_MS = 15_000;

function kindOf(a: { isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean }): SourceStat["type"] {
  return a.isSymbolicLink() ? "symlink" : a.isDirectory() ? "dir" : a.isFile() ? "file" : "other";
}

/** Map an ssh2/SFTP error to an FsError without leaking host, user or key details. */
export function sftpError(e: unknown, fallback = "remote error"): FsError {
  if (e instanceof FsError) return e;
  const code = (e as { code?: number | string })?.code;
  if (code === STATUS_NO_SUCH_FILE) return new FsError(404, "not found");
  if (code === STATUS_PERMISSION_DENIED) return new FsError(403, "permission denied");
  if (code === "ETIMEDOUT" || (e as Error)?.message === "timeout") return new FsError(504, "remote timed out");
  const level = (e as { level?: string })?.level;
  if (level === "client-authentication") return new FsError(502, "authentication failed");
  return new FsError(502, fallback);
}

export interface SftpOptions {
  /** base64 sha256 of the server's host key (as `ssh-keygen -lf` prints without the SHA256: prefix); empty = trust and remember the first key */
  hostKeySha256?: string;
}

/**
 * SFTP source on ssh2. One lazily opened connection is shared by all requests
 * and reopened after it drops. Credentials come from the mounted Secret
 * (`username`, then `password` or `privateKey` + optional `passphrase`) and are
 * read at connect time so a rotated Secret is picked up on reconnect.
 */
export class SftpBackend implements SourceBackend {
  readonly type = "sftp";
  private conn: Client | null = null;
  private sftp: SFTPWrapper | null = null;
  private opening: Promise<SFTPWrapper> | null = null;
  private seenKey: string | null = null;
  private readonly host: string;
  private readonly port: number;
  private readonly root: string;
  private readonly opts: SftpOptions;

  constructor(
    cfg: SourceConfig,
    private readonly creds: () => Promise<Credentials>,
  ) {
    const m = /^(.*?)(?::(\d+))?$/.exec(cfg.host) as RegExpExecArray;
    this.host = m[1] as string;
    this.port = m[2] ? Number(m[2]) : 22;
    this.root = "/" + cleanVirtual(cfg.root || "/").join("/");
    this.opts = (cfg.options ?? {}) as SftpOptions;
  }

  private real(virtual: string): string {
    const parts = cleanVirtual(virtual);
    return parts.length ? path.posix.join(this.root, ...parts) : this.root;
  }

  private open(): Promise<SFTPWrapper> {
    if (this.sftp) return Promise.resolve(this.sftp);
    this.opening ??= this.connect().finally(() => {
      this.opening = null;
    });
    return this.opening;
  }

  private async connect(): Promise<SFTPWrapper> {
    const c = await this.creds();
    if (!c.username) throw new FsError(502, "source credentials are missing");
    const conn = new Client();
    const pinned = this.opts.hostKeySha256?.replace(/^SHA256:/, "").replace(/=+$/, "");
    const sftp = await new Promise<SFTPWrapper>((resolve, reject) => {
      conn.on("error", (e) => reject(sftpError(e, "connection failed")));
      conn.on("ready", () => {
        conn.sftp((err, s) => (err ? reject(sftpError(err, "sftp unavailable")) : resolve(s)));
      });
      conn.connect({
        host: this.host,
        port: this.port,
        username: c.username,
        ...(c.privateKey ? { privateKey: c.privateKey, ...(c.passphrase ? { passphrase: c.passphrase } : {}) } : { password: c.password ?? "" }),
        readyTimeout: TIMEOUT_MS,
        keepaliveInterval: 20_000,
        keepaliveCountMax: 3,
        hostHash: "sha256",
        hostVerifier: (hash: string) => {
          const got = Buffer.from(hash, "hex").toString("base64").replace(/=+$/, ""); // ssh2 hands over hex
          if (pinned) return got === pinned;
          // No pin configured: trust the first key and refuse a change while this process lives.
          if (this.seenKey && this.seenKey !== got) return false;
          this.seenKey = got;
          return true;
        },
      });
    });
    const drop = () => {
      if (this.conn === conn) {
        this.conn = null;
        this.sftp = null;
      }
    };
    conn.on("close", drop);
    conn.on("end", drop);
    conn.on("error", drop);
    this.conn = conn;
    this.sftp = sftp;
    return sftp;
  }

  private async call<T>(fn: (s: SFTPWrapper, cb: (err: Error | null | undefined, v?: T) => void) => void): Promise<T> {
    const s = await this.open();
    return await new Promise<T>((resolve, reject) => {
      const t = setTimeout(() => reject(new FsError(504, "remote timed out")), TIMEOUT_MS * 4);
      fn(s, (err, v) => {
        clearTimeout(t);
        if (err) reject(sftpError(err));
        else resolve(v as T);
      });
    });
  }

  async ping(): Promise<void> {
    await this.call<Stats>((s, cb) => s.stat(this.root, cb));
  }

  async list(p: string): Promise<SourceEntry[]> {
    const dir = this.real(p);
    const st = await this.call<Stats>((s, cb) => s.stat(dir, cb));
    if (!st.isDirectory()) throw new FsError(400, "not a directory");
    const items = await this.call<FileEntryWithStats[]>((s, cb) => s.readdir(dir, cb));
    const out: SourceEntry[] = [];
    for (const it of items) {
      if (it.filename === "." || it.filename === "..") continue;
      const e: SourceEntry = {
        name: it.filename,
        type: kindOf(it.attrs),
        size: it.attrs.size,
        mtime: it.attrs.mtime * 1000,
        mode: it.attrs.mode & 0o7777,
      };
      if (e.type === "symlink") {
        try {
          const t = await this.call<Stats>((s, cb) => s.stat(path.posix.join(dir, it.filename), cb));
          e.linkDir = t.isDirectory();
        } catch {
          e.linkDir = false;
        }
      }
      out.push(e);
    }
    return out;
  }

  async stat(p: string): Promise<SourceStat | null> {
    try {
      const a = await this.call<Stats>((s, cb) => s.lstat(this.real(p), cb));
      return { type: kindOf(a), size: a.size, mtime: a.mtime * 1000, mode: a.mode & 0o7777 };
    } catch (e) {
      if (e instanceof FsError && e.status === 404) return null;
      throw e;
    }
  }

  async read(p: string, range?: { start: number; end: number }): Promise<Readable> {
    const s = await this.open();
    const rs = s.createReadStream(this.real(p), range ? { start: range.start, end: range.end } : undefined);
    return rs as unknown as Readable;
  }

  async write(p: string, body: Readable, o: { overwrite: boolean; mtime?: number }): Promise<number> {
    const target = this.real(p);
    const existing = await this.stat(p);
    if (existing && !o.overwrite) {
      body.resume();
      throw new FsError(409, "destination exists");
    }
    if (existing?.type === "dir") {
      body.resume();
      throw new FsError(409, "destination is a directory");
    }
    const s = await this.open();
    const tmp = path.posix.join(path.posix.dirname(target), `.${path.posix.basename(target)}.filedeck-${randomUUID().slice(0, 8)}.part`);
    let written = 0;
    const count = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        written += chunk.length;
        cb(null, chunk);
      },
    });
    try {
      const out = s.createWriteStream(tmp, { flags: "wx", mode: 0o644 });
      await pipeline(body, count, out);
      if (o.mtime && Number.isFinite(o.mtime) && o.mtime > 0) {
        const sec = Math.floor(o.mtime / 1000);
        await this.call<void>((x, cb) => x.utimes(tmp, sec, sec, cb as (e?: Error | null) => void));
      }
      await this.moveInto(tmp, target, o.overwrite && existing !== null);
    } catch (e) {
      await this.call<void>((x, cb) => x.unlink(tmp, cb as (e?: Error | null) => void)).catch(() => undefined);
      throw sftpError(e, "upload failed");
    }
    return written;
  }

  private async moveInto(from: string, to: string, overwrite: boolean): Promise<void> {
    if (!overwrite) {
      try {
        await this.call<void>((x, cb) => x.rename(from, to, cb as (e?: Error | null) => void));
      } catch (e) {
        if (e instanceof FsError && e.status === 502) throw new FsError(409, "destination exists");
        throw e;
      }
      return;
    }
    const s = await this.open();
    const posix = (s as unknown as { ext_openssh_rename?: (a: string, b: string, cb: (e?: Error | null) => void) => void }).ext_openssh_rename;
    if (typeof posix === "function") {
      try {
        await this.call<void>((x, cb) => (x as unknown as { ext_openssh_rename: typeof posix }).ext_openssh_rename(from, to, cb as (e?: Error | null) => void));
        return;
      } catch {
        /* server lacks the extension: fall through */
      }
    }
    await this.call<void>((x, cb) => x.unlink(to, cb as (e?: Error | null) => void));
    await this.call<void>((x, cb) => x.rename(from, to, cb as (e?: Error | null) => void));
  }

  async mkdir(p: string): Promise<void> {
    if (await this.stat(p)) throw new FsError(409, "already exists");
    await this.call<void>((s, cb) => s.mkdir(this.real(p), cb as (e?: Error | null) => void));
  }

  async rename(from: string, to: string, overwrite: boolean): Promise<void> {
    if (!overwrite && (await this.stat(to))) throw new FsError(409, "destination exists");
    await this.moveInto(this.real(from), this.real(to), overwrite && (await this.stat(to)) !== null);
  }

  async remove(p: string, isDir: boolean): Promise<void> {
    const r = this.real(p);
    if (isDir) await this.call<void>((s, cb) => s.rmdir(r, cb as (e?: Error | null) => void));
    else await this.call<void>((s, cb) => s.unlink(r, cb as (e?: Error | null) => void));
  }

  async close(): Promise<void> {
    this.conn?.end();
    this.conn = null;
    this.sftp = null;
  }
}
