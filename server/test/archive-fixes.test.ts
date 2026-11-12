import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { Readable } from "node:stream";
import { resetSandbox } from "../src/sandbox.ts";
import { extractTar, prepareExtract, streamList, zipStream } from "../src/archive.ts";

const HAVE_BSDTAR = spawnSync("bsdtar", ["--version"]).status === 0;
const needTool = { skip: HAVE_BSDTAR ? false : "bsdtar not installed" };

/* tiny tar writers: header + body, with optional raw header fields */
function header(name: string, type: string, size: number, mtimeField?: Buffer): Buffer {
  const h = Buffer.alloc(512);
  h.write(name, 0, 100);
  h.write("0000644\0", 100);
  h.write("0000000\0", 108);
  h.write("0000000\0", 116);
  h.write(size.toString(8).padStart(11, "0") + "\0", 124);
  if (mtimeField) mtimeField.copy(h, 136);
  else h.write("00000000000\0", 136);
  h.write("        ", 148);
  h.write(type, 156);
  h.write("ustar\0" + "00", 257);
  let sum = 0;
  for (const b of h) sum += b;
  h.write(sum.toString(8).padStart(6, "0") + "\0 ", 148);
  return h;
}
const padTo = (b: Buffer) => Buffer.concat([b, Buffer.alloc((512 - (b.length % 512)) % 512)]);
function pax(records: Record<string, string>): Buffer {
  let body = "";
  for (const [k, v] of Object.entries(records)) {
    const rest = ` ${k}=${v}\n`;
    let len = rest.length + 1;
    while (String(len).length + rest.length !== len) len = String(len).length + rest.length;
    body += `${len}${rest}`;
  }
  const b = Buffer.from(body);
  return Buffer.concat([header("PaxHeader/x", "x", b.length), padTo(b)]);
}
const tarOf = (...e: Buffer[]) => Readable.from([Buffer.concat([...e, Buffer.alloc(1024)])]);
const LIM = { maxEntries: 100, maxBytes: 1 << 24 };
const ctl = () => ({ signal: new AbortController().signal, progress: { bytes: 0, totalBytes: 0, entries: 0, totalEntries: 0, current: "" } });

let work: string;
before(() => {
  work = fs.mkdtempSync(path.join(os.tmpdir(), "fd-archfix-"));
});
after(() => fs.rmSync(work, { recursive: true, force: true }));
const stage = () => fs.mkdtempSync(path.join(work, "stage-"));

/** GNU sparse 1.0 as libarchive writes it: map block, then the packed data. */
function sparse10(real: string, realSize: number, segs: [number, string][]): Buffer[] {
  const map = Buffer.from(`${segs.length}\n` + segs.map(([o, d]) => `${o}\n${d.length}\n`).join(""));
  const packed = Buffer.concat([padTo(map), Buffer.from(segs.map(([, d]) => d).join(""))]);
  return [
    pax({ path: `GNUSparseFile.0/${real}`, "GNU.sparse.major": "1", "GNU.sparse.minor": "0", "GNU.sparse.name": real, "GNU.sparse.realsize": String(realSize) }),
    header(`GNUSparseFile.0/${real}`, "0", packed.length),
    padTo(packed),
  ];
}

test("extractTar: a GNU sparse file (pax 1.0) is extracted under its real name with holes as zeros", async () => {
  const base = stage();
  const res = await extractTar(tarOf(...sparse10("disk.img", 10000, [[0, "head"], [5000, "middle"]])), base, LIM, ctl());
  assert.deepEqual(fs.readdirSync(base), ["disk.img"]);
  const got = fs.readFileSync(path.join(base, "disk.img"));
  assert.equal(got.length, 10000);
  assert.equal(got.subarray(0, 4).toString(), "head");
  assert.equal(got.subarray(5000, 5006).toString(), "middle");
  assert.ok(got.subarray(4, 5000).every((b) => b === 0) && got.subarray(5006).every((b) => b === 0));
  assert.equal(res.bytes, 10000);
});

test("extractTar: a sparse file followed by other entries keeps the stream in step", async () => {
  const base = stage();
  const after = Buffer.from("after");
  await extractTar(tarOf(...sparse10("a.bin", 3000, [[1000, "x".repeat(700)]]), header("b.txt", "0", after.length), padTo(after)), base, LIM, ctl());
  assert.equal(fs.statSync(path.join(base, "a.bin")).size, 3000);
  assert.equal(fs.readFileSync(path.join(base, "b.txt"), "utf8"), "after");
});

test("extractTar: a sparse file counts its real size against the byte limit; a corrupt map is refused", async () => {
  await assert.rejects(extractTar(tarOf(...sparse10("big", 1 << 20, [[0, "x"]])), stage(), { maxEntries: 5, maxBytes: 1000 }, ctl()), /size limit/);
  await assert.rejects(extractTar(tarOf(...sparse10("bad", 100, [[90, "x".repeat(50)]])), stage(), LIM, ctl()), /corrupt/);
});

test("extractTar: bsdtar's own sparse output round-trips", needTool, async () => {
  const src = fs.mkdtempSync(path.join(work, "sp-"));
  const f = path.join(src, "sp.bin");
  fs.writeFileSync(f, "abc");
  const fd = fs.openSync(f, "r+");
  fs.writeSync(fd, "hello", 0, "utf8");
  fs.ftruncateSync(fd, 4 << 20);
  fs.writeSync(fd, "tail", 3 << 20);
  fs.closeSync(fd);
  const child = spawnSync("bsdtar", ["--format=pax", "-cf", "-", "-C", src, "sp.bin"], { maxBuffer: 64 << 20 });
  assert.equal(child.status, 0);
  const base = stage();
  await extractTar(Readable.from([child.stdout]), base, { maxEntries: 10, maxBytes: 1 << 30 }, ctl());
  assert.deepEqual(fs.readdirSync(base), ["sp.bin"]);
  assert.ok(fs.readFileSync(path.join(base, "sp.bin")).equals(fs.readFileSync(f)));
});

test("extractTar: a file dated before 1970 extracts, and keeps its date", async () => {
  const base = stage();
  // -315644400 (1960-01-01 UTC+...) as GNU base-256, two's complement
  const t = Buffer.alloc(12, 0xff);
  t[0] = 0xff;
  t.writeBigInt64BE(-315644400n, 4);
  const data = Buffer.from("old");
  await extractTar(tarOf(header("old.txt", "0", data.length, t), padTo(data)), base, LIM, ctl());
  assert.equal(fs.readFileSync(path.join(base, "old.txt"), "utf8"), "old");
  assert.equal(Math.round(fs.statSync(path.join(base, "old.txt")).mtimeMs / 1000), -315644400);
});

test("extractTar: a pax mtime before 1970 is used", async () => {
  const base = stage();
  const data = Buffer.from("old");
  await extractTar(tarOf(pax({ mtime: "-315644400.5" }), header("old.txt", "0", data.length), padTo(data)), base, LIM, ctl());
  assert.equal(Math.floor(fs.statSync(path.join(base, "old.txt")).mtimeMs / 1000), -315644401);
});

test("extractTar: bsdtar output for a pre-1970 file extracts", needTool, async () => {
  const src = fs.mkdtempSync(path.join(work, "old-"));
  fs.writeFileSync(path.join(src, "o.txt"), "o");
  fs.utimesSync(path.join(src, "o.txt"), new Date(-315644400000), new Date(-315644400000));
  const out = spawnSync("bsdtar", ["--format=pax", "-cf", "-", "-C", src, "o.txt"]);
  const base = stage();
  await extractTar(Readable.from([out.stdout]), base, LIM, ctl());
  assert.equal(fs.readFileSync(path.join(base, "o.txt"), "utf8"), "o");
});

test("streamList: a listing cut off by the deadline is an error, not a complete list", async () => {
  // a "bsdtar" that prints one entry and then stalls past the deadline
  const fake = path.join(work, "slow-bsdtar.sh");
  fs.writeFileSync(fake, "#!/bin/sh\necho '-rw-r--r--  0 u g 1 Jan  1 00:00 a.txt'\nexec sleep 30\n", { mode: 0o755 });
  const save = process.env.FILEDECK_BSDTAR;
  process.env.FILEDECK_BSDTAR = fake;
  const saveSb = process.env.FILEDECK_SANDBOX;
  process.env.FILEDECK_SANDBOX = "off"; // a shell-script stand-in in a temp folder cannot run inside the sandbox
  resetSandbox();
  try {
    const seen: string[] = [];
    // the deadline passes once the first entry has arrived (a fixed 300 ms can pass before a loaded host has even started the process)
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(new DOMException("deadline", "TimeoutError")), 60_000);
    try {
      await assert.rejects(
        streamList("/dev/null", deadline.signal, (e) => {
          seen.push(e.name);
          setTimeout(() => deadline.abort(new DOMException("deadline", "TimeoutError")), 50);
        }),
        (e: { status?: number }) => e.status === 408,
      );
    } finally {
      clearTimeout(timer);
    }
    assert.deepEqual(seen, ["a.txt"]);
  } finally {
    if (save === undefined) delete process.env.FILEDECK_BSDTAR;
    else process.env.FILEDECK_BSDTAR = save;
    if (saveSb === undefined) delete process.env.FILEDECK_SANDBOX;
    else process.env.FILEDECK_SANDBOX = saveSb;
    resetSandbox();
  }
});

test("prepareExtract: a split archive needs 7-Zip and is refused clearly without it", async () => {
  const root = fs.mkdtempSync(path.join(work, "root-"));
  fs.writeFileSync(path.join(root, "set.7z.001"), "not really");
  fs.mkdirSync(path.join(root, "out"));
  const save = [process.env.FILEDECK_7Z, process.env.FILEDECK_7Z_RECHECK];
  process.env.FILEDECK_7Z = path.join(work, "no-such-7zz");
  process.env.FILEDECK_7Z_RECHECK = "1";
  try {
    await assert.rejects(prepareExtract(root, "/set.7z.001", "/out", false), (e: { status?: number }) => e.status === 501);
  } finally {
    if (save[0] === undefined) delete process.env.FILEDECK_7Z;
    else process.env.FILEDECK_7Z = save[0];
    if (save[1] === undefined) delete process.env.FILEDECK_7Z_RECHECK;
    else process.env.FILEDECK_7Z_RECHECK = save[1];
  }
});

test("zipStream: a bsdtar failure reaches the reader as an error, not a clean end", needTool, async () => {
  const dir = fs.mkdtempSync(path.join(work, "zs-"));
  fs.writeFileSync(path.join(dir, "ok.txt"), "ok");
  const s = zipStream(dir, ["ok.txt", "missing.txt"], new AbortController().signal);
  await assert.rejects(async () => {
    for await (const _ of s) void _;
  });
  const good = zipStream(dir, ["ok.txt"], new AbortController().signal);
  let n = 0;
  for await (const c of good) n += (c as Buffer).length;
  assert.ok(n > 0);
});
