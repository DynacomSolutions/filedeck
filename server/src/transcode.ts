import { spawn } from "node:child_process";
import { constants } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import type { Context, Hono } from "hono";
import { FsError } from "./fsops.ts";
import { openChecked, resolveRead } from "./paths.ts";
import type { Config } from "./config.ts";

/**
 * On-the-fly transcode for media a browser cannot play natively (AVI, WMV,
 * MPEG-TS, WMA, AIFF, ...): ffmpeg re-encodes to fragmented H.264/AAC MP4 (or
 * MP3 for audio) and the bytes stream straight to the player, nothing is
 * stored. `t` starts the stream at an offset in seconds, which is how the UI
 * seeks (the stream itself is not seekable). Same containment as the
 * thumbnails: ffmpeg only receives the one open file descriptor (protocol
 * whitelist `fd`), runs with no environment and, as root, as uid/gid 65534;
 * a hard wall-clock limit and a small concurrency cap bound the CPU it can take.
 */
export type TranscodeKind = "video" | "audio";

const AUDIO_EXT = new Set(["mp3", "m4a", "aac", "ogg", "oga", "wav", "flac", "opus", "weba", "wma", "aif", "aiff", "ape", "wv", "ac3", "dts", "mka", "amr", "mp2", "au", "caf"]);
const VIDEO_EXT = new Set(["mp4", "m4v", "webm", "mov", "mkv", "avi", "wmv", "asf", "flv", "mpg", "mpeg", "m2ts", "mts", "vob", "3gp", "3g2", "ogv", "divx", "rm", "rmvb", "mxf", "f4v"]);

export function mediaKind(name: string): TranscodeKind | null {
  const i = name.lastIndexOf(".");
  if (i < 1) return null;
  const e = name.slice(i + 1).toLowerCase();
  return VIDEO_EXT.has(e) ? "video" : AUDIO_EXT.has(e) ? "audio" : null;
}

const ENV = { PATH: "/usr/bin:/bin:/usr/local/bin" };
const MAX_SECONDS = 8 * 3600;

export function transcodeArgs(kind: TranscodeKind, start: number): string[] {
  const src = ["-protocol_whitelist", "fd", "-fd", "0", ...(start > 0 ? ["-ss", String(start)] : []), "-i", "fd:"];
  const head = ["-hide_banner", "-loglevel", "error", "-nostdin", "-threads", "2"];
  if (kind === "audio") return [...head, ...src, "-vn", "-sn", "-c:a", "libmp3lame", "-q:a", "4", "-f", "mp3", "pipe:1"];
  return [
    ...head,
    ...src,
    "-map", "0:v:0?", "-map", "0:a:0?", "-sn", "-dn",
    "-vf", "scale='min(1280,iw)':-2",
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "27", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "128k", "-ac", "2",
    "-movflags", "frag_keyframe+empty_moov+default_base_moof",
    "-f", "mp4", "pipe:1",
  ];
}

function spawnTool(bin: string, args: string[], fd: number) {
  const root = typeof process.getuid === "function" && process.getuid() === 0;
  return spawn(bin, args, { stdio: [fd, "pipe", "ignore"], env: ENV, cwd: "/", ...(root ? { uid: 65534, gid: 65534 } : {}) });
}

export interface MediaInfo {
  duration: number | null;
  video: { codec: string; width: number; height: number } | null;
  audio: { codec: string } | null;
}

async function probe(ffprobe: string, fd: number): Promise<MediaInfo> {
  const child = spawnTool(ffprobe, ["-v", "error", "-protocol_whitelist", "fd", "-fd", "0", "-print_format", "json", "-show_format", "-show_streams", "-i", "fd:"], fd);
  const chunks: Buffer[] = [];
  let size = 0;
  child.stdout!.on("data", (d: Buffer) => {
    size += d.length;
    if (size > 2 * 1024 * 1024) child.kill("SIGKILL");
    else chunks.push(d);
  });
  const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
  const code = await new Promise<number | null>((res, rej) => {
    child.on("error", (e) => rej(new FsError(502, "media probe unavailable: " + (e as NodeJS.ErrnoException).code)));
    child.on("close", res);
  }).finally(() => clearTimeout(timer));
  if (code !== 0) throw new FsError(415, "not a media file");
  const j = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { format?: { duration?: string }; streams?: { codec_type?: string; codec_name?: string; width?: number; height?: number }[] };
  const v = j.streams?.find((s) => s.codec_type === "video" && (s.width ?? 0) > 0);
  const a = j.streams?.find((s) => s.codec_type === "audio");
  const d = Number(j.format?.duration);
  return {
    duration: Number.isFinite(d) && d > 0 ? d : null,
    video: v ? { codec: v.codec_name ?? "?", width: v.width ?? 0, height: v.height ?? 0 } : null,
    audio: a ? { codec: a.codec_name ?? "?" } : null,
  };
}

export function registerTranscodeRoutes(app: Hono, cfg: Config) {
  let active = 0;
  const ffprobe = cfg.ffmpeg.endsWith("ffmpeg") ? cfg.ffmpeg.slice(0, -"ffmpeg".length) + "ffprobe" : "ffprobe";

  const open = async (c: Context) => {
    const r = resolveRead(cfg.root, c.req.query("path") ?? "");
    const fh = await openChecked(cfg.root, r.real, constants.O_RDONLY | constants.O_NONBLOCK);
    try {
      const st = await fh.stat();
      if (!st.isFile()) throw new FsError(400, "not a regular file");
      return { fh, name: path.basename(r.real) };
    } catch (e) {
      await fh.close().catch(() => undefined);
      throw e;
    }
  };

  app.get("/api/fs/mediainfo", async (c) => {
    const f = await open(c);
    try {
      return c.json(await probe(ffprobe, f.fh.fd));
    } finally {
      await f.fh.close().catch(() => undefined);
    }
  });

  app.get("/api/fs/transcode", async (c) => {
    const f = await open(c);
    const kind = (c.req.query("kind") as TranscodeKind | undefined) ?? mediaKind(f.name);
    const t = Number(c.req.query("t") ?? "0");
    if ((kind !== "video" && kind !== "audio") || !Number.isFinite(t) || t < 0 || t > 10_000_000) {
      await f.fh.close().catch(() => undefined);
      throw new FsError(400, "kind must be video or audio and t a number of seconds");
    }
    if (active >= cfg.transcodeConcurrency) {
      await f.fh.close().catch(() => undefined);
      return c.json({ error: "transcoder busy, try again shortly" }, 429);
    }
    active++;
    const child = spawnTool(cfg.ffmpeg, transcodeArgs(kind, t), f.fh.fd);
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      active--;
      clearTimeout(timer);
      void f.fh.close().catch(() => undefined);
    };
    const timer = setTimeout(() => child.kill("SIGKILL"), MAX_SECONDS * 1000);
    child.on("close", finish);
    child.on("error", finish);
    child.stdout!.on("error", () => child.kill("SIGKILL"));
    c.req.raw.signal.addEventListener("abort", () => child.kill("SIGKILL"), { once: true });
    return new Response(Readable.toWeb(child.stdout!) as ReadableStream, {
      status: 200,
      headers: {
        "Content-Type": kind === "audio" ? "audio/mpeg" : "video/mp4",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "sandbox; default-src 'none'; media-src 'self'",
      },
    });
  });
}
