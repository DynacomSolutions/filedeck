import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { Readable } from "node:stream";
import { serve } from "@hono/node-server";
import type { AddressInfo } from "node:net";
import { createAgent } from "../src/agent.ts";
import { loadConfig } from "../src/config.ts";
import { extractTar, parseListLine, safeSegments } from "../src/archive.ts";

const HAVE_BSDTAR = spawnSync("bsdtar", ["--version"]).status === 0;
const needTool = { skip: HAVE_BSDTAR ? false : "bsdtar not installed" };

/* ------------------------------------------------------ tiny writers (tests) */

function tarEntry(name: string, type: string, data = "", linkname = ""): Buffer {
  const h = Buffer.alloc(512);
  h.write(name, 0, 100);
  h.write("0000644\0", 100);
  h.write("0000000\0", 108);
  h.write("0000000\0", 116);
  h.write(data.length.toString(8).padStart(11, "0") + "\0", 124);
  h.write("00000000000\0", 136);
  h.write("        ", 148);
  h.write(type, 156);
  h.write(linkname, 157, 100);
  h.write("ustar\0" + "00", 257);
  let sum = 0;
  for (const b of h) sum += b;
  h.write(sum.toString(8).padStart(6, "0") + "\0 ", 148);
  const body = Buffer.from(data);
  const pad = Buffer.alloc((512 - (body.length % 512)) % 512);
  return Buffer.concat([h, body, pad]);
}
const tarOf = (...e: Buffer[]) => Readable.from([Buffer.concat([...e, Buffer.alloc(1024)])]);

function crc32(b: Buffer): number {
  let c = ~0;
  for (const x of b) {
    c ^= x;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}
/** Stored (uncompressed) zip with arbitrary, possibly hostile, entry names. */
function zipOf(files: Record<string, string>, extAttr: Record<string, number> = {}): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let off = 0;
  for (const [name, data] of Object.entries(files)) {
    const n = Buffer.from(name);
    const d = Buffer.from(data);
    const l = Buffer.alloc(30);
    l.writeUInt32LE(0x04034b50, 0);
    l.writeUInt16LE(20, 4);
    l.writeUInt32LE(crc32(d), 14);
    l.writeUInt32LE(d.length, 18);
    l.writeUInt32LE(d.length, 22);
    l.writeUInt16LE(n.length, 26);
    const rec = Buffer.concat([l, n, d]);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE(extAttr[name] !== undefined ? 0x031e : 20, 4); // unix host when attrs given
    c.writeUInt16LE(20, 6);
    c.writeUInt32LE(crc32(d), 16);
    c.writeUInt32LE(d.length, 20);
    c.writeUInt32LE(d.length, 24);
    c.writeUInt16LE(n.length, 28);
    c.writeUInt32LE((extAttr[name] ?? 0) * 65536 >>> 0, 38);
    c.writeUInt32LE(off, 42);
    central.push(Buffer.concat([c, n]));
    locals.push(rec);
    off += rec.length;
  }
  const cd = Buffer.concat(central);
  const e = Buffer.alloc(22);
  e.writeUInt32LE(0x06054b50, 0);
  e.writeUInt16LE(central.length, 8);
  e.writeUInt16LE(central.length, 10);
  e.writeUInt32LE(cd.length, 12);
  e.writeUInt32LE(off, 16);
  return Buffer.concat([...locals, cd, e]);
}

/* ------------------------------------------------------------ pure guards */

test("safeSegments rejects traversal and absolute names", () => {
  assert.deepEqual(safeSegments("./a//b/./c.txt"), ["a", "b", "c.txt"]);
  for (const bad of ["../x", "a/../../x", "a/..", "/etc/passwd", "\\evil", "C:\\x", "a\\..\\..\\x", "a\0b"]) {
    assert.throws(() => safeSegments(bad), /unsafe archive entry/, bad);
  }
});

function ctl() {
  return { signal: new AbortController().signal, progress: { bytes: 0, totalBytes: 0, entries: 0, totalEntries: 0, current: "" } };
}
const LIM = { maxEntries: 100, maxBytes: 1 << 20 };
let work: string;
const stage = () => fs.mkdtempSync(path.join(work, "stage-"));

test("extractTar: zip-slip entry aborts and writes nothing outside", async () => {
  const base = stage();
  const outside = path.join(path.dirname(base), "evil.txt");
  await assert.rejects(
    extractTar(tarOf(tarEntry("ok.txt", "0", "fine"), tarEntry("../evil.txt", "0", "pwn")), base, LIM, ctl()),
    /path traversal/,
  );
  assert.equal(fs.existsSync(outside), false);
});

test("extractTar: absolute path entry is rejected", async () => {
  const base = stage();
  const target = path.join(work, "abs-target.txt");
  await assert.rejects(extractTar(tarOf(tarEntry(target, "0", "pwn")), base, LIM, ctl()), /absolute path/);
  assert.equal(fs.existsSync(target), false);
});

test("extractTar: symlink entries are never created and cannot be written through", async () => {
  const base = stage();
  const victim = fs.mkdtempSync(path.join(work, "victim-"));
  const r = await extractTar(
    tarOf(
      tarEntry("link", "2", "", victim),
      tarEntry("link/pwned.txt", "0", "pwn"), // classic second stage
      tarEntry("rel", "2", "", "../../etc"),
      tarEntry("hard", "1", "", "/etc/passwd"),
      tarEntry("fifo", "6"),
      tarEntry("keep.txt", "0", "ok"),
    ),
    base,
    LIM,
    ctl(),
  );
  assert.deepEqual(r.skipped, { symlinks: 2, hardlinks: 1, special: 1 });
  assert.deepEqual(fs.readdirSync(victim), []);
  assert.equal(fs.lstatSync(path.join(base, "link")).isDirectory(), true); // became a plain dir for the file
  assert.equal(fs.readFileSync(path.join(base, "keep.txt"), "utf8"), "ok");
  for (const n of fs.readdirSync(base)) assert.equal(fs.lstatSync(path.join(base, n)).isSymbolicLink(), false);
});

test("extractTar: file colliding with a pre-existing symlink in staging is refused", async () => {
  const base = stage();
  const victim = fs.mkdtempSync(path.join(work, "victim-"));
  fs.symlinkSync(victim, path.join(base, "d"));
  await assert.rejects(extractTar(tarOf(tarEntry("d/x.txt", "0", "pwn")), base, LIM, ctl()), /non-directory/);
  assert.deepEqual(fs.readdirSync(victim), []);
});

test("extractTar: caps on entries and written bytes", async () => {
  await assert.rejects(
    extractTar(tarOf(tarEntry("a", "0", "1"), tarEntry("b", "0", "2"), tarEntry("c", "0", "3")), stage(), { maxEntries: 2, maxBytes: 1e9 }, ctl()),
    /more than 2 entries/,
  );
  await assert.rejects(
    extractTar(tarOf(tarEntry("a", "0", "x".repeat(600))), stage(), { maxEntries: 10, maxBytes: 500 }, ctl()),
    /size limit/,
  );
});

test("extractTar: setuid bits are dropped", async () => {
  const base = stage();
  const e = tarEntry("s", "0", "x");
  e.write("0004755\0", 100);
  let sum = 0;
  e.fill(32, 148, 156);
  for (let i = 0; i < 512; i++) sum += e[i]!;
  e.write(sum.toString(8).padStart(6, "0") + "\0 ", 148);
  await extractTar(tarOf(e), base, LIM, ctl());
  assert.equal(fs.statSync(path.join(base, "s")).mode & 0o7000, 0);
});

test("parseListLine", () => {
  assert.deepEqual(parseListLine("-rw-r--r--  0 1000   1000        3 Oct  1 11:37 sub/b c.txt"), {
    name: "sub/b c.txt", type: "file", size: 3, date: "Oct  1 11:37", link: undefined,
  });
  assert.equal(parseListLine("lrwxrwxrwx  0 1000   1000        0 Oct  1 11:37 lnk -> /etc/passwd")?.link, "/etc/passwd");
  assert.equal(parseListLine("garbage"), null);
});

/* ------------------------------------------------- HTTP, with real bsdtar */

let tmp: string, srv: ReturnType<typeof serve>, base: string;
const sh = (cmd: string, args: string[], cwd?: string) => {
  const r = spawnSync(cmd, args, { cwd });
  assert.equal(r.status, 0, `${cmd} ${args.join(" ")}: ${r.stderr}`);
};
const j = async (r: Response) => (await r.json()) as Record<string, any>;
const post = (p: string, body: unknown) =>
  fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

async function waitJob(id: string, want = ["done", "failed", "canceled"]) {
  for (let i = 0; i < 400; i++) {
    const v = await j(await fetch(`${base}/api/jobs/${id}`));
    if (want.includes(v.state)) return v;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("job did not finish");
}

before(async () => {
  work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "filedeck-arch-")));
  tmp = path.join(work, "root");
  fs.mkdirSync(path.join(tmp, "src/sub"), { recursive: true });
  fs.writeFileSync(path.join(tmp, "src/a.txt"), "alpha");
  fs.writeFileSync(path.join(tmp, "src/sub/b c.txt"), "bravo");
  fs.writeFileSync(path.join(tmp, "src/big.bin"), Buffer.alloc(300_000, 7));
  fs.symlinkSync("/etc/passwd", path.join(tmp, "src/lnk"));
  fs.mkdirSync(path.join(tmp, "out"));
  const cfg = loadConfig({ FILEDECK_ROOT: tmp, FILEDECK_NODE: "t", FILEDECK_ARCHIVE_MAX_BYTES: "1000000", FILEDECK_ARCHIVE_MAX_ENTRIES: "50" } as never);
  const app = createAgent(cfg);
  srv = await new Promise((res) => {
    const s: ReturnType<typeof serve> = serve({ fetch: app.fetch, port: 0 }, () => res(s));
  });
  base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
});
after(() => {
  srv.close();
  fs.rmSync(work, { recursive: true, force: true });
});

for (const format of ["zip", "tar.gz", "tar.zst", "7z"]) {
  test(`round trip ${format}: compress then extract`, needTool, async () => {
    const r = await post("/api/jobs/compress", { dir: "/src", names: ["a.txt", "sub", "big.bin"], format, name: `rt-${format}` });
    assert.equal(r.status, 202);
    const job = await waitJob((await j(r)).id);
    assert.equal(job.state, "done", JSON.stringify(job));
    assert.equal(job.result.path, `/src/rt-${format}.${format}`);
    assert.ok(job.progress.bytes > 0 && job.progress.entries >= 4);

    const list = await j(await fetch(`${base}/api/archive/list?path=${encodeURIComponent(job.result.path)}`));
    assert.ok(list.entries.some((e: any) => e.name === "sub/b c.txt" && e.size === 5), JSON.stringify(list));

    const x = await post("/api/jobs/extract", { path: job.result.path, destDir: "/out", subfolder: true });
    const xj = await waitJob((await j(x)).id);
    assert.equal(xj.state, "done", JSON.stringify(xj));
    assert.equal(xj.result.path, `/out/rt-${format}`);
    const dir = path.join(tmp, "out", `rt-${format}`);
    assert.equal(fs.readFileSync(path.join(dir, "a.txt"), "utf8"), "alpha");
    assert.equal(fs.readFileSync(path.join(dir, "sub/b c.txt"), "utf8"), "bravo");
    assert.equal(fs.statSync(path.join(dir, "big.bin")).size, 300_000);
    assert.deepEqual(fs.readdirSync(path.join(tmp, "out")).filter((n) => n.startsWith(".")), []); // staging gone
  });
}

test("compress skips nothing silently: symlink stored as a link, never followed", needTool, async () => {
  const r = await post("/api/jobs/compress", { dir: "/src", names: ["lnk"], format: "tar.gz", name: "lnk" });
  const job = await waitJob((await j(r)).id);
  assert.equal(job.state, "done");
  const out = spawnSync("bsdtar", ["-tvf", path.join(tmp, "src/lnk.tar.gz")]).stdout.toString();
  assert.match(out, /lnk -> \/etc\/passwd/);
  const x = await waitJob((await j(await post("/api/jobs/extract", { path: "/src/lnk.tar.gz", destDir: "/out" }))).id);
  assert.equal(x.state, "done");
  assert.equal(x.result.skipped.symlinks, 1);
  assert.deepEqual(fs.readdirSync(path.join(tmp, "out/lnk")), []);
});

test("zip-slip zip fails the job and touches nothing outside", needTool, async () => {
  fs.writeFileSync(
    path.join(tmp, "src/evil.zip"),
    zipOf({ "ok.txt": "fine", "../../escaped.txt": "pwn", "/abs-escaped.txt": "pwn" }),
  );
  const x = await waitJob((await j(await post("/api/jobs/extract", { path: "/src/evil.zip", destDir: "/out" }))).id);
  // libarchive may sanitise the name itself or hand it to us; either way nothing escapes.
  const escaped = [path.join(tmp, "escaped.txt"), path.join(work, "escaped.txt"), "/abs-escaped.txt", path.join(tmp, "out/abs-escaped.txt")];
  for (const e of escaped.slice(0, 3)) assert.equal(fs.existsSync(e), false, e);
  if (x.state === "failed") {
    assert.match(x.error, /unsafe archive entry|cannot read archive/);
    assert.deepEqual(fs.readdirSync(path.join(tmp, "out")).filter((n) => n.startsWith(".filedeck-extract") || n === "evil"), []);
  } else {
    // sanitised: everything landed under the extraction folder
    assert.equal(x.state, "done");
    const dir = path.join(tmp, "out", "evil");
    const all = fs.readdirSync(dir, { recursive: true }).map(String);
    for (const f of all) assert.ok(!f.includes(".."), f);
  }
});

test("zip with a symlink entry: link not created, file through it not written", needTool, async () => {
  const victim = path.join(work, "victim-http");
  fs.mkdirSync(victim);
  // symlink entry: unix mode 0120777 in the external attributes, data = target
  fs.writeFileSync(
    path.join(tmp, "src/sym.zip"),
    zipOf({ link: victim, "link/pwn.txt": "pwn", "fine.txt": "ok" }, { link: 0o120777 }),
  );
  const x = await waitJob((await j(await post("/api/jobs/extract", { path: "/src/sym.zip", destDir: "/out" }))).id);
  assert.deepEqual(fs.readdirSync(victim), []);
  if (x.state === "done") {
    assert.equal(fs.lstatSync(path.join(tmp, "out/sym/fine.txt")).isFile(), true);
    for (const f of fs.readdirSync(path.join(tmp, "out/sym"), { recursive: true }).map(String)) {
      assert.equal(fs.lstatSync(path.join(tmp, "out/sym", f)).isSymbolicLink(), false, f);
    }
  }
});

test("huge archive is rejected by the size cap and leaves no staging dir", needTool, async () => {
  sh("bsdtar", ["--format", "zip", "-cf", path.join(tmp, "src/bomb.zip"), "-C", path.join(tmp, "src"), "big.bin", "a.txt"]);
  fs.writeFileSync(path.join(tmp, "src/huge.bin"), Buffer.alloc(1_500_000, 1));
  sh("bsdtar", ["--format", "zip", "-cf", path.join(tmp, "src/huge.zip"), "-C", path.join(tmp, "src"), "huge.bin"]);
  const before = fs.readdirSync(path.join(tmp, "out"));
  const x = await waitJob((await j(await post("/api/jobs/extract", { path: "/src/huge.zip", destDir: "/out" }))).id);
  assert.equal(x.state, "failed");
  assert.match(x.error, /limit/);
  assert.deepEqual(fs.readdirSync(path.join(tmp, "out")), before);
});

test("entry-count cap rejects a many-file archive", needTool, async () => {
  const d = path.join(tmp, "many");
  fs.mkdirSync(d);
  for (let i = 0; i < 60; i++) fs.writeFileSync(path.join(d, `f${i}`), "x");
  sh("bsdtar", ["--format", "zip", "-cf", path.join(tmp, "src/many.zip"), "-C", tmp, "many"]);
  const x = await waitJob((await j(await post("/api/jobs/extract", { path: "/src/many.zip", destDir: "/out" }))).id);
  assert.equal(x.state, "failed");
  assert.match(x.error, /limit|entries/);
});

test("job can be cancelled; no partial output remains", needTool, async () => {
  // Many small files keep the job busy long enough to cancel mid-flight.
  const d = path.join(tmp, "cancelme");
  fs.mkdirSync(d);
  for (let i = 0; i < 40; i++) fs.writeFileSync(path.join(d, `f${i}`), Buffer.alloc(20_000, i));
  const r = await post("/api/jobs/compress", { dir: "/", names: ["cancelme"], format: "zip", name: "cancelled" });
  const job = await j(r);
  const c = await post(`/api/jobs/${job.id}/cancel`, {});
  assert.equal(c.status, 200);
  const done = await waitJob(job.id, ["done", "canceled", "failed"]);
  if (done.state === "canceled") {
    assert.equal(fs.existsSync(path.join(tmp, "cancelled.zip")), false);
    assert.deepEqual(fs.readdirSync(tmp).filter((n) => n.endsWith(".part")), []);
  }
  assert.ok(["done", "canceled"].includes(done.state));
  assert.equal((await fetch(`${base}/api/jobs/nope`)).status, 404);
  const dis = await fetch(`${base}/api/jobs/${job.id}`, { method: "DELETE" });
  assert.equal(dis.status, 200);
});

test("multi-file/folder download streams a valid zip", needTool, async () => {
  const r = await fetch(`${base}/api/fs/zip?dir=/src&name=a.txt&name=sub`);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("content-type"), "application/zip");
  assert.match(r.headers.get("content-disposition") ?? "", /filename="src\.zip"/);
  const buf = Buffer.from(await r.arrayBuffer());
  const f = path.join(work, "dl.zip");
  fs.writeFileSync(f, buf);
  const names = spawnSync("bsdtar", ["-tf", f]).stdout.toString().trim().split("\n").sort();
  assert.deepEqual(names, ["a.txt", "sub/", "sub/b c.txt"]);
  const one = await fetch(`${base}/api/fs/zip?dir=/src&name=sub`);
  assert.match(one.headers.get("content-disposition") ?? "", /filename="sub\.zip"/);
  await one.arrayBuffer();
});

test("download and compress reject traversal and non-children", async () => {
  assert.equal((await fetch(`${base}/api/fs/zip?dir=/src&name=..%2Fetc`)).status, 400);
  assert.equal((await fetch(`${base}/api/fs/zip?dir=/src&name=nope`)).status, 404);
  assert.equal((await fetch(`${base}/api/fs/zip?dir=/src`)).status, 400);
  assert.equal((await post("/api/jobs/compress", { dir: "/src", names: ["a.txt"], format: "rar" })).status, 400);
  assert.equal((await post("/api/jobs/compress", { dir: "/../..", names: ["a.txt"], format: "zip" })).status, 400);
  assert.equal((await post("/api/jobs/extract", { path: "/nope.zip", destDir: "/out" })).status, 404);
  assert.equal((await post("/api/jobs/extract", { path: "/src/a.txt", destDir: "/src/a.txt" })).status, 400);
});

test("not an archive fails cleanly", needTool, async () => {
  const x = await waitJob((await j(await post("/api/jobs/extract", { path: "/src/a.txt", destDir: "/out" }))).id);
  assert.equal(x.state, "failed");
  assert.match(x.error, /cannot read archive/);
});
