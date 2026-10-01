import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createAgent } from "../src/agent.ts";
import { loadConfig } from "../src/config.ts";
import { mediaKind, transcodeArgs } from "../src/transcode.ts";
import { hasFfmpeg } from "./ffmpeg.ts";

let tmp: string, outside: string, agent: ReturnType<typeof createAgent>;
const ff = (...a: string[]) => execFileSync("ffmpeg", ["-loglevel", "error", "-y", ...a]);

before(() => {
  if (!hasFfmpeg) return;
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "filedeck-tc-")));
  outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "filedeck-tc-out-")));
  ff("-f", "lavfi", "-i", "testsrc=duration=4:size=320x240:rate=10", "-f", "lavfi", "-i", "sine=duration=4", "-c:v", "mpeg4", "-c:a", "mp2", path.join(tmp, "clip.avi"));
  ff("-f", "lavfi", "-i", "sine=duration=3", "-c:a", "wmav2", path.join(tmp, "tone.wma"));
  fs.writeFileSync(path.join(tmp, "notmedia.avi"), "this is not a video");
  fs.copyFileSync(path.join(tmp, "clip.avi"), path.join(outside, "secret.avi"));
  fs.symlinkSync(path.join(outside, "secret.avi"), path.join(tmp, "esc.avi"));
  agent = createAgent(loadConfig({ FILEDECK_ROOT: tmp, FILEDECK_NODE: "t" } as never));
});
after(() => {
  if (!hasFfmpeg) return;
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
});

test("mediaKind and arguments", () => {
  assert.equal(mediaKind("a.AVI"), "video");
  assert.equal(mediaKind("a.wma"), "audio");
  assert.equal(mediaKind("a.txt"), null);
  assert.ok(transcodeArgs("video", 12).join(" ").includes("-ss 12"));
  assert.ok(!transcodeArgs("video", 0).includes("-ss"));
  assert.ok(transcodeArgs("audio", 0).includes("libmp3lame"));
  assert.ok(transcodeArgs("video", 0).join(" ").includes("-protocol_whitelist fd"), "ffmpeg only sees the passed descriptor");
});

test("avi transcodes to a fragmented h264/aac mp4 stream", { skip: !hasFfmpeg }, async () => {
  const r = await agent.request("/api/fs/transcode?path=/clip.avi");
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("content-type"), "video/mp4");
  const buf = Buffer.from(await r.arrayBuffer());
  assert.equal(buf.subarray(4, 8).toString(), "ftyp");
  const out = path.join(tmp, "out.mp4");
  fs.writeFileSync(out, buf);
  const info = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-print_format", "json", "-show_streams", out]).toString()) as { streams: { codec_name: string }[] };
  assert.deepEqual(info.streams.map((s) => s.codec_name).sort(), ["aac", "h264"]);
});

test("start offset shortens the stream", { skip: !hasFfmpeg }, async () => {
  const dur = (b: Buffer) => {
    const f = path.join(tmp, "d.mp4");
    fs.writeFileSync(f, b);
    return Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", f]).toString());
  };
  const full = dur(Buffer.from(await (await agent.request("/api/fs/transcode?path=/clip.avi")).arrayBuffer()));
  const tail = dur(Buffer.from(await (await agent.request("/api/fs/transcode?path=/clip.avi&t=2")).arrayBuffer()));
  assert.ok(tail < full - 1, `${tail} vs ${full}`);
});

test("wma transcodes to mp3", { skip: !hasFfmpeg }, async () => {
  const r = await agent.request("/api/fs/transcode?path=/tone.wma");
  assert.equal(r.headers.get("content-type"), "audio/mpeg");
  const b = Buffer.from(await r.arrayBuffer());
  assert.ok(b.length > 1000);
  assert.ok((b[0] === 0x49 && b[1] === 0x44) || b[0] === 0xff, "ID3 tag or MPEG frame sync");
});

test("mediainfo, bad input, confinement", { skip: !hasFfmpeg }, async () => {
  const i = (await (await agent.request("/api/fs/mediainfo?path=/clip.avi")).json()) as { duration: number; video: { width: number }; audio: { codec: string } };
  assert.ok(i.duration > 3 && i.duration < 5);
  assert.equal(i.video.width, 320);
  assert.ok(i.audio);
  assert.equal((await agent.request("/api/fs/mediainfo?path=/notmedia.avi")).status, 415);
  assert.equal((await agent.request("/api/fs/transcode?path=/clip.avi&t=-1")).status, 400);
  assert.equal((await agent.request("/api/fs/transcode?path=/clip.avi&kind=bogus")).status, 400);
  assert.equal((await agent.request("/api/fs/transcode?path=/nope.avi")).status, 404);
  assert.equal((await agent.request("/api/fs/transcode?path=/")).status, 400);
  // the link points outside the root: it is re-based, so the outside file is never reached
  assert.notEqual((await agent.request("/api/fs/transcode?path=/esc.avi")).status, 200);
});

test("concurrency cap answers 429", { skip: !hasFfmpeg }, async () => {
  const one = createAgent(loadConfig({ FILEDECK_ROOT: tmp, FILEDECK_NODE: "t", FILEDECK_TRANSCODE_CONCURRENCY: "1" } as never));
  const first = await one.request("/api/fs/transcode?path=/clip.avi");
  const second = await one.request("/api/fs/transcode?path=/clip.avi");
  assert.equal(second.status, 429);
  await first.arrayBuffer();
  const third = await one.request("/api/fs/transcode?path=/clip.avi");
  assert.equal(third.status, 200);
  await third.arrayBuffer();
});
