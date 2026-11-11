import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { archiveBase, extractTar, prepareCompress, prepareExtract, runCompress, runExtract, sweepWorkArea } from "../src/archive.ts";
import { assertNotTrash } from "../src/paths.ts";
import * as ops from "../src/fsops.ts";
import { Readable } from "node:stream";
import type { JobCtl } from "../src/jobs.ts";

/**
 * Extraction and compression stage in a private work folder and write into pinned folders. These tests
 * replace the staging folder, the destination and the output folder with a link to a folder outside the
 * root while a job is running, and check that nothing is written outside. Stand-ins for bsdtar and 7zz
 * stall until a signal file appears, which gives each test a deterministic window.
 */

function entry(name: string, data: string): Buffer {
  const h = Buffer.alloc(512);
  h.write(name, 0, 100);
  h.write("0000644\0", 100);
  h.write("0000000\0", 108);
  h.write("0000000\0", 116);
  h.write(data.length.toString(8).padStart(11, "0") + "\0", 124);
  h.write("00000000000\0", 136);
  h.write("        ", 148);
  h.write("0", 156);
  h.write("ustar\0" + "00", 257);
  let sum = 0;
  for (const b of h) sum += b;
  h.write(sum.toString(8).padStart(6, "0") + "\0 ", 148);
  const body = Buffer.from(data);
  return Buffer.concat([h, body, Buffer.alloc((512 - (body.length % 512)) % 512)]);
}

let tmp: string;
let work: string;
const saved: Record<string, string | undefined> = {};
const ENVS = ["FILEDECK_BSDTAR", "FILEDECK_7Z", "FILEDECK_7Z_RECHECK", "FILEDECK_WORK_DIR"];
before(() => {
  for (const k of ENVS) saved[k] = process.env[k];
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fd-pinned-"));
  work = path.join(tmp, "work");
  fs.mkdirSync(work, { mode: 0o700 });
  process.env.FILEDECK_WORK_DIR = work;
  process.env.FILEDECK_7Z_RECHECK = "1";
});
after(() => {
  for (const k of ENVS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(f: () => T | undefined | false, what: string): Promise<T> {
  for (let i = 0; i < 400; i++) {
    const v = f();
    if (v) return v;
    await sleep(25);
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** A scene: root/out (destination), a folder outside the root, and stalling stand-ins for bsdtar and 7zz. */
function scene(name: string) {
  const dir = path.join(tmp, name);
  const root = path.join(dir, "root");
  const outside = path.join(dir, "outside");
  fs.mkdirSync(path.join(root, "out"), { recursive: true });
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(root, "a.tar"), "placeholder");
  fs.writeFileSync(path.join(root, "set.7z.001"), "placeholder");
  fs.writeFileSync(path.join(dir, "first.tar"), entry("first.txt", "one"));
  fs.writeFileSync(path.join(dir, "rest.tar"), Buffer.concat([entry("second.txt", "two"), entry("sub/third.txt", "three"), Buffer.alloc(1024)]));
  const go = path.join(dir, "go");
  const tar = path.join(dir, "fake-bsdtar.sh");
  fs.writeFileSync(
    tar,
    `#!/bin/sh
case "$*" in *-tvf*) exit 0;; esac
case "$*" in
  *" -cf -"*) ;;
  *) # compressing: take the archive path after -cf, wait, write it
    cat > /dev/null
    out=""; prev=""
    for a in "$@"; do [ "$prev" = "-cf" ] && out="$a"; prev="$a"; done
    while [ ! -e '${go}' ]; do sleep 0.05; done
    printf ARCHIVE > "$out"; exit 0;;
esac
cat '${path.join(dir, "first.tar")}'
while [ ! -e '${go}' ]; do sleep 0.05; done
cat '${path.join(dir, "rest.tar")}'
`,
    { mode: 0o755 },
  );
  const sz = path.join(dir, "fake-7zz.sh");
  const rec = (n: string, size: number, folder: boolean) => `Path = ${n}\\nSize = ${size}\\nFolder = ${folder ? "+" : "-"}\\nEncrypted = -\\n\\n`;
  fs.writeFileSync(
    sz,
    `#!/bin/sh
case "$1" in
  l) printf '${rec("first.txt", 3, false) + rec("second.txt", 3, false) + rec("sub", 0, true) + rec("sub/third.txt", 5, false)}'; exit 0;;
  x) printf one > first.txt
     while [ ! -e '${go}' ]; do sleep 0.05; done
     mkdir -p sub; printf two > second.txt; printf three > sub/third.txt; exit 0;;
  *) exit 0;;
esac
`,
    { mode: 0o755 },
  );
  process.env.FILEDECK_BSDTAR = tar;
  process.env.FILEDECK_7Z = sz;
  return { dir, root, outside, go, dest: path.join(root, "out"), wd: path.join(root, ".filedeck-work") };
}

const mkCtl = () => {
  const ac = new AbortController();
  const c = { signal: ac.signal, progress: { bytes: 0, totalBytes: 0, entries: 0, totalEntries: 0, current: "" } } as unknown as JobCtl;
  return { ctl: c, ac };
};
const LIM = { maxEntries: 100, maxBytes: 1 << 20 };
const tree = (d: string): string[] => fs.readdirSync(d, { recursive: true }).map(String).sort();
/** the job's staging folder in the private work area that already holds `file` */
const stagingWith = (wd: string, file: string) => (fs.existsSync(wd) ? fs.readdirSync(wd) : []).find((n) => fs.existsSync(path.join(wd, n, file)));
const leftovers = (wd: string) => (fs.existsSync(wd) ? fs.readdirSync(wd) : []).filter((n) => /^\d+-/.test(n));

test("the start-up sweep removes dead runs' staging in the work folders and nothing else", async () => {
  const s = scene("sweep");
  fs.mkdirSync(s.wd, { mode: 0o700 });
  for (const w of [work, s.wd]) {
    fs.mkdirSync(path.join(w, "99999999-x-stale"));
    fs.writeFileSync(path.join(w, "99999999-x-stale", "f"), "x");
    fs.mkdirSync(path.join(w, `${process.pid}-x-mine`));
    fs.mkdirSync(path.join(w, "1-x-live"));
    fs.mkdirSync(path.join(w, "unrelated"));
  }
  fs.mkdirSync(path.join(s.root, "99999999-not-in-a-work-folder"));
  await sweepWorkArea(s.root, path.join(s.dir, "no-such-mounts"));
  for (const w of [work, s.wd]) {
    assert.deepEqual(fs.readdirSync(w).sort(), ["1-x-live", "unrelated"]);
    fs.rmdirSync(path.join(w, "1-x-live"));
    fs.rmdirSync(path.join(w, "unrelated"));
  }
  assert.ok(fs.existsSync(path.join(s.root, "99999999-not-in-a-work-folder")));
});

for (const policy of ["rename", "overwrite", "skip"] as const) {
  for (const swap of ["staging", "destination"] as const) {
    test(`${policy}: swapping the ${swap} for an outside link mid-extract writes nothing outside the root`, async () => {
      const s = scene(`${swap}-${policy}`);
      fs.mkdirSync(path.join(s.dest, "a"));
      fs.writeFileSync(path.join(s.dest, "a/first.txt"), "old");
      const plan = await prepareExtract(s.root, "/a.tar", "/out", true, { overwrite: policy });
      const { ctl } = mkCtl();
      const job = runExtract(plan, LIM, ctl);
      const staging = await until(() => stagingWith(s.wd, "first.txt"), "the first file");
      assert.deepEqual(fs.readdirSync(s.dest).filter((n) => n.startsWith(".filedeck-")), [], "no staging in the served folder");
      let moved = s.dest;
      if (swap === "staging") {
        fs.renameSync(path.join(s.wd, staging), path.join(s.wd, staging + "-moved"));
        fs.symlinkSync(s.outside, path.join(s.wd, staging));
      } else {
        moved = path.join(s.root, "out-moved");
        fs.renameSync(s.dest, moved);
        fs.symlinkSync(s.outside, s.dest);
      }
      fs.writeFileSync(s.go, "");
      const r = await job;
      assert.deepEqual(fs.readdirSync(s.outside), [], "nothing may appear outside the root");
      const folder = policy === "rename" ? "a (2)" : "a";
      assert.equal(r.path, `/out/${folder}`);
      assert.equal(fs.readFileSync(path.join(moved, folder, "sub/third.txt"), "utf8"), "three");
      assert.equal(fs.readFileSync(path.join(moved, "a/first.txt"), "utf8"), policy === "overwrite" ? "one" : policy === "skip" ? "old" : "old");
      if (swap === "staging") {
        fs.rmSync(path.join(s.wd, staging), { force: true });
        fs.rmSync(path.join(s.wd, staging + "-moved"), { recursive: true, force: true });
      }
    });
  }
}

test("a 7-Zip extraction runs in the private work folder; swapping the destination writes nothing outside", async () => {
  const s = scene("sz");
  const plan = await prepareExtract(s.root, "/set.7z.001", "/out", false, { overwrite: "rename" });
  assert.equal(plan.viaSz, true);
  const { ctl } = mkCtl();
  const job = runExtract(plan, LIM, ctl);
  await until(() => stagingWith(s.wd, "first.txt"), "7-Zip's first file in the work folder");
  assert.deepEqual(fs.readdirSync(s.dest), [], "7-Zip must not work inside the served folder");
  const moved = path.join(s.root, "out-moved");
  fs.renameSync(s.dest, moved);
  fs.symlinkSync(s.outside, s.dest);
  fs.writeFileSync(s.go, "");
  await job;
  assert.deepEqual(fs.readdirSync(s.outside), []);
  assert.deepEqual(tree(moved), ["first.txt", "second.txt", "sub", "sub/third.txt"]);
});

test("keep-both never replaces an entry that is already there", async () => {
  const s = scene("keepboth");
  const plan = await prepareExtract(s.root, "/a.tar", "/out", false, { overwrite: "rename" });
  const { ctl } = mkCtl();
  const job = runExtract(plan, LIM, ctl);
  await until(() => stagingWith(s.wd, "first.txt"), "the first file");
  fs.writeFileSync(path.join(s.dest, "second.txt"), "mine");
  fs.writeFileSync(s.go, "");
  await job;
  assert.equal(fs.readFileSync(path.join(s.dest, "second.txt"), "utf8"), "mine");
  assert.equal(fs.readFileSync(path.join(s.dest, "second (2).txt"), "utf8"), "two");
});

test("cancelling an extraction leaves no staging behind and nothing in the destination", async () => {
  const s = scene("cancel");
  const plan = await prepareExtract(s.root, "/a.tar", "/out", false, { overwrite: "overwrite" });
  const { ctl, ac } = mkCtl();
  const job = runExtract(plan, LIM, ctl);
  await until(() => stagingWith(s.wd, "first.txt"), "the first file");
  ac.abort();
  await assert.rejects(job);
  assert.deepEqual(leftovers(s.wd), []);
  assert.deepEqual(fs.readdirSync(s.dest), []);
  assert.deepEqual(fs.readdirSync(s.outside), []);
});

test("compress: swapping the output folder for an outside link mid-job writes nothing outside the root", async () => {
  const s = scene("compress");
  fs.mkdirSync(path.join(s.root, "src"));
  fs.writeFileSync(path.join(s.root, "src/f.txt"), "data");
  const plan = await prepareCompress(s.root, "/src", ["f.txt"], "tar.gz", "result", { destDir: "/out" });
  const { ctl } = mkCtl();
  const job = runCompress(plan, LIM, ctl);
  await until(() => fs.existsSync(s.wd) && fs.readdirSync(s.wd).some((n) => /^\d+-c-/.test(n)), "the work folder");
  assert.deepEqual(fs.readdirSync(s.dest), [], "the archive is not written inside the served folder");
  const moved = path.join(s.root, "out-moved");
  fs.renameSync(s.dest, moved);
  fs.symlinkSync(s.outside, s.dest);
  fs.writeFileSync(s.go, "");
  const r = await job;
  assert.deepEqual(fs.readdirSync(s.outside), []);
  assert.equal(r.path, "/out/result.tar.gz");
  assert.equal(fs.readFileSync(path.join(moved, "result.tar.gz"), "utf8"), "ARCHIVE");
  assert.deepEqual(leftovers(s.wd), []);
});

test("archive names that would give the destination itself or the trash name fall back to a plain folder name", () => {
  assert.equal(archiveBase("..tar"), "extracted");
  assert.equal(archiveBase("...zip"), "extracted");
  assert.equal(archiveBase(".filedeck-trash.zip"), "extracted");
  assert.equal(archiveBase("photos.tar.gz"), "photos");
});

test("jobs stage on the destination's volume and finish with renames: no copy, the inode is kept", async () => {
  const s = scene("volume");
  const plan = await prepareExtract(s.root, "/a.tar", "/out", false, { overwrite: "rename" });
  const { ctl } = mkCtl();
  const job = runExtract(plan, LIM, ctl);
  const staging = await until(() => fs.existsSync(s.wd) && stagingWith(s.wd, "first.txt"), "the first file");
  assert.equal(fs.readdirSync(work).filter((n) => /^\d+-/.test(n)).length, 0, "the temp work folder is not used");
  assert.equal(fs.statSync(s.wd).mode & 0o777, 0o700);
  const ino = fs.statSync(path.join(s.wd, staging, "first.txt")).ino;
  fs.writeFileSync(s.go, "");
  await job;
  assert.equal(fs.statSync(path.join(s.dest, "first.txt")).ino, ino, "the file was moved, not copied");
  assert.deepEqual(leftovers(s.wd), []);
});

test("the temp work folder is the fallback when the volume root cannot hold a private folder", async () => {
  const s = scene("fallback");
  fs.chmodSync(s.root, 0o777); // others could rename entries in the volume root
  const plan = await prepareExtract(s.root, "/a.tar", "/out", false, { overwrite: "rename" });
  const { ctl } = mkCtl();
  const job = runExtract(plan, LIM, ctl);
  await until(() => stagingWith(work, "first.txt"), "the first file in the temp work folder");
  assert.equal(fs.existsSync(s.wd), false, "no work folder was left on the volume");
  fs.writeFileSync(s.go, "");
  await job;
  assert.deepEqual(tree(s.dest), ["first.txt", "second.txt", "sub", "sub/third.txt"]);
  assert.deepEqual(fs.readdirSync(work).filter((n) => /^\d+-/.test(n)), []);
  fs.chmodSync(s.root, 0o755);
});

test("on the fallback, a job that cannot fit fails at once and says what it needs", async () => {
  const s = scene("nofit");
  fs.chmodSync(s.root, 0o777);
  fs.mkdirSync(path.join(s.root, "src"));
  const big = path.join(s.root, "src/huge.bin");
  try {
    fs.closeSync(fs.openSync(big, "w"));
    fs.truncateSync(big, 2 ** 42);
  } catch {
    fs.chmodSync(s.root, 0o755);
    return; // this filesystem cannot make a sparse file that large
  }
  const plan = await prepareCompress(s.root, "/src", ["huge.bin"], "tar.gz", "huge", { destDir: "/out" });
  const { ctl } = mkCtl();
  await assert.rejects(runCompress(plan, { maxEntries: 10, maxBytes: 2 ** 50 }, ctl), (e: { status?: number; message?: string }) => e.status === 507 && /needs \d+ bytes free/.test(e.message ?? ""));
  assert.deepEqual(fs.readdirSync(work).filter((n) => /^\d+-/.test(n)), []);
  fs.chmodSync(s.root, 0o755);
});

test("the work folder name is Filedeck's own: refused as a target, hidden from listings, never extracted", async () => {
  const s = scene("reserved");
  fs.mkdirSync(s.wd, { mode: 0o700 });
  fs.writeFileSync(path.join(s.root, "visible.txt"), "v");
  assert.throws(() => assertNotTrash("/out/.filedeck-work"), (e: { status?: number }) => e.status === 403);
  assert.throws(() => assertNotTrash("/.filedeck-work/x.txt"), (e: { status?: number }) => e.status === 403);
  for (const hidden of [true, false]) {
    const l = (await ops.list(s.root, "/", hidden)) as unknown as { entries: { name: string }[] };
    assert.ok(l.entries.some((e) => e.name === "visible.txt"));
    assert.ok(!l.entries.some((e) => e.name === ".filedeck-work"), `listed with hidden=${hidden}`);
  }
  await assert.rejects(
    extractTar(Readable.from([Buffer.concat([entry(".filedeck-work/x", "x"), Buffer.alloc(1024)])]), fs.mkdtempSync(path.join(s.dir, "st-")), LIM, mkCtl().ctl),
    /reserved name/,
  );
});
