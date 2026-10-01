import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createAgent } from "../src/agent.ts";
import { loadConfig } from "../src/config.ts";
import { Thumbnailer, thumbKind } from "../src/thumbs.ts";
import { hasFfmpeg } from "./ffmpeg.ts";

let tmp: string, outside: string, cache: string, agent: ReturnType<typeof createAgent>;
const ff = (...a: string[]) => execFileSync("ffmpeg", ["-loglevel", "error", "-y", ...a]);

/** Width and height from the first JPEG start-of-frame marker. */
function jpegSize(b: Buffer) {
  assert.equal(b[0], 0xff);
  assert.equal(b[1], 0xd8);
  let i = 2;
  while (i < b.length) {
    assert.equal(b[i], 0xff);
    const m = b[i + 1]!;
    const len = b.readUInt16BE(i + 2);
    if (m >= 0xc0 && m <= 0xc3) return { h: b.readUInt16BE(i + 5), w: b.readUInt16BE(i + 7) };
    i += 2 + len;
  }
  throw new Error("no SOF");
}
const get = (p: string) => agent.request("/api/fs/thumb?path=" + encodeURIComponent(p));

before(() => {
  if (!hasFfmpeg) return;
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "filedeck-th-")));
  outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "filedeck-th-out-")));
  cache = path.join(fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "filedeck-th-cache-"))), "c");
  ff("-f", "lavfi", "-i", "testsrc=size=1600x900", "-frames:v", "1", path.join(tmp, "wide.png"));
  ff("-f", "lavfi", "-i", "testsrc=size=90x120", "-frames:v", "1", path.join(tmp, "small.jpg"));
  ff("-f", "lavfi", "-i", "testsrc=duration=3:size=640x360:rate=10", "-c:v", "mpeg4", path.join(tmp, "late-moov.mp4")); // moov atom at the end
  ff("-f", "lavfi", "-i", "testsrc=duration=0.4:size=320x240:rate=10", "-c:v", "mpeg4", path.join(tmp, "short.mp4"));
  ff("-f", "lavfi", "-i", "testsrc=size=64x64", "-frames:v", "1", path.join(outside, "secret.png"));
  fs.writeFileSync(path.join(tmp, "evil.mp4"), `#EXTM3U\n#EXTINF:1,\nfile://${path.join(outside, "secret.png")}\n#EXT-X-ENDLIST\n`);
  fs.writeFileSync(path.join(tmp, "notimage.png"), "this is not an image");
  fs.writeFileSync(path.join(tmp, "doc.txt"), "text");
  fs.closeSync(fs.openSync(path.join(tmp, "huge.png"), "w"));
  fs.truncateSync(path.join(tmp, "huge.png"), 65 * 1024 * 1024); // sparse
  fs.symlinkSync(path.join(outside, "secret.png"), path.join(tmp, "link.png"));
  agent = createAgent(loadConfig({ FILEDECK_ROOT: tmp, FILEDECK_NODE: "t", FILEDECK_THUMB_DIR: cache } as never));
});
after(() => {
  if (!hasFfmpeg) return;
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
  fs.rmSync(path.dirname(cache), { recursive: true, force: true });
});

test("thumbKind by extension", () => {
  assert.equal(thumbKind("a.PNG"), "image");
  assert.equal(thumbKind("a.mkv"), "video");
  assert.equal(thumbKind("a.txt"), null);
  assert.equal(thumbKind(".png"), null);
  assert.equal(thumbKind("svg"), null);
});

test("image thumbnail: JPEG, scaled down to 256, never upscaled, cached outside the data root", { skip: !hasFfmpeg }, async () => {
  const r = await get("/wide.png");
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("content-type"), "image/jpeg");
  assert.equal(r.headers.get("x-content-type-options"), "nosniff");
  assert.deepEqual(jpegSize(Buffer.from(await r.arrayBuffer())), { w: 256, h: 144 });
  const s = await get("/small.jpg");
  assert.deepEqual(jpegSize(Buffer.from(await s.arrayBuffer())), { w: 90, h: 120 });
  const files = fs.readdirSync(cache, { recursive: true }).filter((f) => String(f).endsWith(".jpg"));
  assert.equal(files.length, 2);
  assert.deepEqual(fs.readdirSync(tmp).filter((n) => n.includes("thumb") || n.endsWith(".tmp")), []);
  const again = await get("/wide.png");
  assert.equal(again.status, 200);
  assert.equal(fs.readdirSync(cache, { recursive: true }).filter((f) => String(f).endsWith(".jpg")).length, 2, "second request is a cache hit");
});

test("video poster: moov at the end, and a clip shorter than the seek offset", { skip: !hasFfmpeg }, async () => {
  for (const f of ["/late-moov.mp4", "/short.mp4"]) {
    const r = await get(f);
    assert.equal(r.status, 200, f);
    const d = jpegSize(Buffer.from(await r.arrayBuffer()));
    assert.ok(d.w <= 256 && d.h <= 256 && d.w > 0, f);
  }
});

test("refusals: non-media, unsupported type, oversize, traversal, symlink escape, playlists cannot read other files", { skip: !hasFfmpeg }, async () => {
  assert.equal((await get("/notimage.png")).status, 415);
  assert.equal((await get("/notimage.png")).status, 415); // negative cache
  assert.equal((await get("/doc.txt")).status, 415);
  assert.equal((await get("/huge.png")).status, 413);
  assert.equal((await get("/../x.png")).status, 400);
  assert.equal((await get("/nope.png")).status, 404);
  assert.equal((await get("/")).status, 400);
  const link = await get("/link.png"); // absolute link re-based onto the root: the outside file is not reachable
  assert.ok([403, 404].includes(link.status));
  const evil = await get("/evil.mp4");
  assert.equal(evil.status, 415);
});

test("bounded cache: least recently used entries are evicted", { skip: !hasFfmpeg }, async () => {
  const dir = path.join(path.dirname(cache), "lru");
  const t = new Thumbnailer({ dir, maxBytes: 1, concurrency: 2, queue: 8, timeoutMs: 10000, ffmpeg: "ffmpeg" });
  const open = async () => ({ input: { fd: fs.openSync(path.join(tmp, "wide.png"), "r") }, close: () => undefined });
  const one = await t.get("a", "image", open);
  const size = fs.statSync((one as { file: string }).file).size;
  const t2 = new Thumbnailer({ dir, maxBytes: Math.floor(size * 2.5), concurrency: 2, queue: 8, timeoutMs: 10000, ffmpeg: "ffmpeg" });
  for (const id of ["b", "c", "d", "e"]) {
    await t2.get(id, "image", open);
    await new Promise((r) => setTimeout(r, 15));
  }
  await t2.evict();
  const left = fs.readdirSync(dir, { recursive: true }).filter((f) => String(f).endsWith(".jpg"));
  const total = left.reduce((n, f) => n + fs.statSync(path.join(dir, String(f))).size, 0);
  assert.ok(total <= size * 2.5, `cache ${total} over ${size * 2.5}`);
  assert.ok(left.length >= 1 && left.length < 5);
});

test("queue is bounded: beyond the waiting limit the answer is 429", { skip: !hasFfmpeg }, async () => {
  const t = new Thumbnailer({ dir: path.join(path.dirname(cache), "q"), maxBytes: 1 << 26, concurrency: 1, queue: 1, timeoutMs: 10000, ffmpeg: "ffmpeg" });
  const open = async () => ({ input: { fd: fs.openSync(path.join(tmp, "wide.png"), "r") }, close: () => undefined });
  const res = await Promise.allSettled(["1", "2", "3"].map((id) => t.get(id, "image", open)));
  assert.ok(res.some((r) => r.status === "rejected" && /queue full/.test(String((r as PromiseRejectedResult).reason?.message))));
  assert.ok(res.filter((r) => r.status === "fulfilled").length >= 2);
});

test("missing ffmpeg gives a clean 502, not a crash", { skip: !hasFfmpeg }, async () => {
  const a = createAgent(loadConfig({ FILEDECK_ROOT: tmp, FILEDECK_NODE: "t", FILEDECK_THUMB_DIR: cache + "-x", FILEDECK_FFMPEG: "/nonexistent/ffmpeg" } as never));
  const r = await a.request("/api/fs/thumb?path=/wide.png");
  assert.equal(r.status, 502);
});

test("an unwritable cache dir still serves thumbnails", { skip: !hasFfmpeg }, async () => {
  const a = createAgent(loadConfig({ FILEDECK_ROOT: tmp, FILEDECK_NODE: "t", FILEDECK_THUMB_DIR: path.join(tmp, "doc.txt", "thumbs") /* a file in the way: ENOTDIR */ } as never));
  const r = await a.request("/api/fs/thumb?path=/small.jpg");
  assert.equal(r.status, 200);
  assert.deepEqual(jpegSize(Buffer.from(await r.arrayBuffer())), { w: 90, h: 120 });
});
