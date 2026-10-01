import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import type { Hono, Context } from "hono";
import { FsError } from "./fsops.ts";
import { openChecked, resolveRead } from "./paths.ts";
import type { Config } from "./config.ts";

export const THUMB_SIZE = 256;
const IMAGE_EXT = new Set(["jpg", "jpeg", "png", "gif", "webp", "bmp", "tif", "tiff", "avif", "ico"]);
const VIDEO_EXT = new Set(["mp4", "m4v", "mov", "mkv", "webm", "avi", "mpg", "mpeg", "ts", "ogv", "wmv", "flv", "3gp"]);
/** Larger images are not decoded (a decoder holds the whole bitmap in memory). */
export const THUMB_MAX_IMAGE_BYTES = 64 * 1024 * 1024;

export type ThumbKind = "image" | "video";
export function thumbKind(name: string): ThumbKind | null {
  const i = name.lastIndexOf(".");
  if (i < 1) return null;
  const e = name.slice(i + 1).toLowerCase();
  return IMAGE_EXT.has(e) ? "image" : VIDEO_EXT.has(e) ? "video" : null;
}

export interface ThumbOpts {
  /** cache directory, outside any user data; unwritable = no cache */
  dir: string;
  /** cache size ceiling in bytes; the oldest-used entries are deleted beyond it */
  maxBytes: number;
  concurrency: number;
  /** waiting requests beyond this get 429 */
  queue: number;
  timeoutMs: number;
  ffmpeg: string;
}

export type Thumb = { file: string } | { data: Buffer };

/** Input handed to ffmpeg: a seekable fd of the file (nodes) or a one-way stream (network sources, images only). */
export type ThumbInput = { fd: number } | { stream: Readable };

/**
 * Image and video poster thumbnails (256 px JPEG) made by ffmpeg, cached on disk
 * under a bounded directory. ffmpeg only ever sees the one file handed to it
 * (`-protocol_whitelist fd,pipe`, so a playlist or concat file cannot name other
 * files), runs with no environment, one thread, a hard timeout and, when the
 * agent is root, as uid/gid 65534 with no capabilities.
 */
export class Thumbnailer {
  private active = 0;
  private waiting: { go: () => void; fail: (e: Error) => void }[] = [];
  private inflight = new Map<string, Promise<Thumb>>();
  private failed = new Map<string, number>();
  private used: number | null = null;
  private evicting = false;
  private cacheOk = true;
  constructor(private o: ThumbOpts) {}

  private key(id: string) {
    return createHash("sha256").update(id).digest("hex");
  }
  private file(k: string) {
    return path.join(this.o.dir, k.slice(0, 2), k + ".jpg");
  }

  private async slot(signal?: AbortSignal): Promise<() => void> {
    if (this.active >= this.o.concurrency) {
      if (this.waiting.length >= this.o.queue) throw new FsError(429, "thumbnail queue full");
      await new Promise<void>((go, fail) => {
        const w = { go, fail: (e: Error) => fail(e) };
        this.waiting.push(w);
        signal?.addEventListener(
          "abort",
          () => {
            const i = this.waiting.indexOf(w);
            if (i >= 0) {
              this.waiting.splice(i, 1);
              fail(new FsError(400, "canceled"));
            }
          },
          { once: true },
        );
      });
    } else this.active++;
    return () => {
      const n = this.waiting.shift();
      if (n) n.go();
      else this.active--;
    };
  }

  private encode(input: ThumbInput, kind: ThumbKind, seek: number): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const vf = `scale=w='min(${THUMB_SIZE},iw)':h='min(${THUMB_SIZE},ih)':force_original_aspect_ratio=decrease`;
      const src = "fd" in input ? ["-protocol_whitelist", "fd", "-fd", "0", ...(kind === "video" ? ["-ss", String(seek)] : []), "-i", "fd:"] : ["-protocol_whitelist", "pipe", "-i", "pipe:0"];
      const args = ["-hide_banner", "-loglevel", "error", "-nostdin", "-threads", "1", ...src, "-frames:v", "1", "-an", "-sn", "-vf", vf, "-pix_fmt", "yuvj420p", "-q:v", "5", "-f", "mjpeg", "pipe:1"];
      const root = typeof process.getuid === "function" && process.getuid() === 0;
      const child = spawn(this.o.ffmpeg, args, {
        stdio: ["fd" in input ? input.fd : "pipe", "pipe", "ignore"],
        env: { PATH: "/usr/bin:/bin:/usr/local/bin" },
        cwd: "/",
        ...(root ? { uid: 65534, gid: 65534 } : {}),
      });
      const chunks: Buffer[] = [];
      let size = 0;
      const timer = setTimeout(() => child.kill("SIGKILL"), this.o.timeoutMs);
      child.stdout!.on("data", (d: Buffer) => {
        size += d.length;
        if (size > 4 * 1024 * 1024) child.kill("SIGKILL");
        else chunks.push(d);
      });
      if ("stream" in input) {
        input.stream.on("error", () => child.kill("SIGKILL"));
        child.stdin!.on("error", () => undefined);
        input.stream.pipe(child.stdin!);
      }
      child.on("error", (e) => {
        clearTimeout(timer);
        reject(new FsError(502, "thumbnail tool unavailable: " + (e as NodeJS.ErrnoException).code));
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if ("stream" in input) input.stream.destroy();
        const out = Buffer.concat(chunks);
        if (code === 0 && out.length > 100) resolve(out);
        else resolve(Buffer.alloc(0));
      });
    });
  }

  /** Path of the cached JPEG for `id`, generating it from `open()` when missing. Rejects with FsError. */
  async get(id: string, kind: ThumbKind, open: () => Promise<{ input: ThumbInput; close: () => Promise<void> | void }>, signal?: AbortSignal): Promise<Thumb> {
    const k = this.key(id);
    const f = this.file(k);
    const hit = await fs.stat(f).catch(() => null);
    if (hit) {
      const now = new Date();
      fs.utimes(f, now, hit.mtime).catch(() => undefined);
      return { file: f };
    }
    const bad = this.failed.get(k);
    if (bad && Date.now() - bad < 5 * 60_000) throw new FsError(415, "no thumbnail");
    const running = this.inflight.get(k);
    if (running) return running;
    const p = (async () => {
      const release = await this.slot(signal);
      let h = await open();
      try {
        let out = await this.encode(h.input, kind, 1);
        if (!out.length && kind === "video" && "fd" in h.input) {
          // clip shorter than 1 s: retry from the start on a fresh handle (the first run moved the shared file offset)
          await h.close();
          h = await open();
          out = await this.encode(h.input, kind, 0);
        }
        if (!out.length) {
          this.failed.set(k, Date.now());
          if (this.failed.size > 5000) this.failed.delete(this.failed.keys().next().value as string);
          throw new FsError(415, "no thumbnail");
        }
        return await this.store(k, out);
      } finally {
        await h.close();
        release();
      }
    })();
    this.inflight.set(k, p);
    try {
      return await p;
    } finally {
      this.inflight.delete(k);
    }
  }

  /** Writes to the cache when possible; with an unwritable cache dir the bytes are just served and not kept. */
  private async store(k: string, data: Buffer): Promise<Thumb> {
    const f = this.file(k);
    if (this.cacheOk) {
      try {
        await fs.mkdir(path.dirname(f), { recursive: true, mode: 0o700 });
        const tmp = f + "." + process.pid + ".tmp";
        await fs.writeFile(tmp, data, { mode: 0o600 });
        await fs.rename(tmp, f);
        this.used = (this.used ?? 0) + data.length;
        void this.evict();
        return { file: f };
      } catch {
        this.cacheOk = false;
      }
    }
    return { data };
  }

  private async scan(): Promise<{ f: string; size: number; at: number }[]> {
    const out: { f: string; size: number; at: number }[] = [];
    for (const d of await fs.readdir(this.o.dir).catch(() => [] as string[])) {
      const dd = path.join(this.o.dir, d);
      for (const n of await fs.readdir(dd).catch(() => [] as string[])) {
        if (out.length > 200_000) return out;
        const f = path.join(dd, n);
        const st = await fs.stat(f).catch(() => null);
        if (st?.isFile()) out.push({ f, size: st.size, at: st.atimeMs });
      }
    }
    return out;
  }

  /** Delete the least recently used entries until the cache is under 80% of its ceiling. */
  async evict(): Promise<void> {
    if (this.evicting) return;
    if (this.used !== null && this.used <= this.o.maxBytes) return;
    this.evicting = true;
    try {
      const all = await this.scan();
      let total = all.reduce((n, x) => n + x.size, 0);
      this.used = total;
      if (total <= this.o.maxBytes) return;
      all.sort((a, b) => a.at - b.at);
      for (const x of all) {
        if (total <= this.o.maxBytes * 0.8) break;
        await fs.rm(x.f, { force: true });
        total -= x.size;
      }
      this.used = total;
    } finally {
      this.evicting = false;
    }
  }
}

export function makeThumbnailer(cfg: Config): Thumbnailer {
  return new Thumbnailer({
    dir: cfg.thumbDir,
    maxBytes: cfg.thumbCacheMax,
    concurrency: cfg.thumbConcurrency,
    queue: 128,
    timeoutMs: 20_000,
    ffmpeg: cfg.ffmpeg,
  });
}

const SAFE = {
  "X-Content-Type-Options": "nosniff",
  "Content-Security-Policy": "sandbox; default-src 'none'; img-src 'self' data:",
  "Cache-Control": "private, max-age=86400",
};

export function thumbResponse(t: Thumb): Response {
  const body = "file" in t ? (Readable.toWeb(createReadStream(t.file)) as ReadableStream) : new Uint8Array(t.data);
  return new Response(body, { status: 200, headers: { ...SAFE, "Content-Type": "image/jpeg" } });
}

export function registerThumbRoutes(app: Hono, cfg: Config) {
  const th = makeThumbnailer(cfg);
  app.get("/api/fs/thumb", async (c: Context) => {
    const r = resolveRead(cfg.root, c.req.query("path") ?? "");
    const fh = await openChecked(cfg.root, r.real, constants.O_RDONLY | constants.O_NONBLOCK);
    try {
      const st = await fh.stat();
      if (!st.isFile()) throw new FsError(400, "not a regular file");
      const kind = thumbKind(path.basename(r.real));
      if (!kind) throw new FsError(415, "no thumbnail for this type");
      if (kind === "image" && st.size > THUMB_MAX_IMAGE_BYTES) throw new FsError(413, "image too large for a thumbnail");
      const t = await th.get(
        `${r.real}\0${st.mtimeMs}\0${st.size}`,
        kind,
        async () => {
          // Each run gets its own open file description of the same inode (offset 0), never a re-resolved path when /proc is there.
          const h = await fs.open(`/proc/self/fd/${fh.fd}`, "r").catch(() => fs.open(r.real, "r"));
          return { input: { fd: h.fd }, close: () => h.close().catch(() => undefined) };
        },
        c.req.raw.signal,
      );
      return thumbResponse(t);
    } finally {
      await fh.close().catch(() => undefined);
    }
  });
}
