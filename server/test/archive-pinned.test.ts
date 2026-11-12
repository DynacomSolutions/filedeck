import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { archiveBase, extractTar, prepareCompress, prepareExtract, runCompress, runExtract, sweepWorkArea } from "../src/archive.ts";
import { assertNotTrash, resolveRead } from "../src/paths.ts";
import { spawnSync } from "node:child_process";
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
  // every stand-in gives up after 30 s, so a cut-off test never leaves one running
  const wait = `i=0; while [ ! -e '${go}' ] && [ $i -lt 600 ]; do sleep 0.05; i=$((i+1)); done`;
  const seen = path.join(dir, "seen-archive");
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
    ${wait}
    if [ "$out" = "-" ]; then id -u; else printf ARCHIVE > "$out"; fi; exit 0;;
esac
cat '${path.join(dir, "first.tar")}'
${wait}
case "$*" in *"@/dev/fd/3"*) cat /dev/fd/3 > '${seen}';; esac
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
     ${wait}
     mkdir -p sub; printf two > second.txt; printf three > sub/third.txt; exit 0;;
  *) exit 0;;
esac
`,
    { mode: 0o755 },
  );
  process.env.FILEDECK_BSDTAR = tar;
  process.env.FILEDECK_7Z = sz;
  return { dir, root, outside, go, seen, dest: path.join(root, "out"), wd: path.join(root, ".filedeck-work") };
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
const STAGING = /^[a-z0-9-]+\.[0-9a-f]{12}\.[xcs]\.[A-Za-z0-9]{6}(\.alive)?$/;
const leftovers = (wd: string) => (fs.existsSync(wd) ? fs.readdirSync(wd) : []).filter((n) => STAGING.test(n));

test("the sweep removes only staging that has been idle for ages and never judges liveness by process ids", async () => {
  const s = scene("sweep");
  fs.mkdirSync(s.wd, { mode: 0o700 });
  const DAY = 86_400_000;
  const make = (w: string, name: string, ageMs: number, markerAgeMs: number | null) => {
    fs.mkdirSync(path.join(w, name));
    fs.writeFileSync(path.join(w, name, "f"), "x");
    fs.utimesSync(path.join(w, name), new Date(Date.now() - ageMs), new Date(Date.now() - ageMs));
    if (markerAgeMs !== null) {
      fs.writeFileSync(path.join(w, `${name}.alive`), "");
      fs.utimesSync(path.join(w, `${name}.alive`), new Date(Date.now() - markerAgeMs), new Date(Date.now() - markerAgeMs));
    }
  };
  for (const w of [work, s.wd]) {
    make(w, "oldhost.aaaaaaaaaaaa.x.AbCdE1", 3 * DAY, 3 * DAY); // another agent's crashed run: idle for days
    make(w, "pod2.bbbbbbbbbbbb.x.AbCdE2", 3 * DAY, 1000); // another agent's long job: folder untouched but heartbeat fresh
    make(w, "pod3.cccccccccccc.c.AbCdE3", 1000, null); // another agent's job that has just started
    make(w, "pid1.dddddddddddd.x.AbCdE4", 3 * DAY, 3 * DAY); // names carrying a pid-like prefix mean nothing either way
    fs.mkdirSync(path.join(w, "4000000-x-othernode")); // the old naming: not ours to judge, left alone
    fs.mkdirSync(path.join(w, "unrelated"));
  }
  fs.mkdirSync(path.join(s.root, "oldhost.aaaaaaaaaaaa.x.AbCdE9"));
  fs.utimesSync(path.join(s.root, "oldhost.aaaaaaaaaaaa.x.AbCdE9"), new Date(Date.now() - 3 * DAY), new Date(Date.now() - 3 * DAY));
  await sweepWorkArea(s.root, path.join(s.dir, "no-such-mounts"));
  for (const w of [work, s.wd]) {
    assert.deepEqual(fs.readdirSync(w).filter((n) => !n.endsWith(".alive")).sort(), ["4000000-x-othernode", "pod2.bbbbbbbbbbbb.x.AbCdE2", "pod3.cccccccccccc.c.AbCdE3", "unrelated"], w);
    assert.equal(fs.existsSync(path.join(w, "oldhost.aaaaaaaaaaaa.x.AbCdE1.alive")), false, "the idle run's heartbeat goes with it");
  }
  assert.ok(fs.existsSync(path.join(s.root, "oldhost.aaaaaaaaaaaa.x.AbCdE9")), "nothing outside a work folder is touched");
  for (const w of [work, s.wd]) for (const n of fs.readdirSync(w)) fs.rmSync(path.join(w, n), { recursive: true, force: true }); // the other tests expect an empty work folder
});

test("a running job keeps a heartbeat beside its staging folder", async () => {
  const s = scene("beat");
  const plan = await prepareExtract(s.root, "/a.tar", "/out", false, { overwrite: "rename" });
  const { ctl } = mkCtl();
  const job = runExtract(plan, LIM, ctl);
  const staging = await until(() => stagingWith(s.wd, "first.txt"), "the first file");
  assert.ok(fs.existsSync(path.join(s.wd, `${staging}.alive`)));
  fs.writeFileSync(s.go, "");
  await job;
  assert.deepEqual(leftovers(s.wd), []);
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
  await until(() => fs.existsSync(s.wd) && fs.readdirSync(s.wd).some((n) => /\.c\.[A-Za-z0-9]{6}$/.test(n)), "the work folder");
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
  assert.equal(leftovers(work).length, 0, "the temp work folder is not used");
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
  assert.deepEqual(leftovers(work), []);
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
  assert.deepEqual(leftovers(work), []);
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

/* ---- the archive is read through the descriptor opened when the job starts ---- */

test("an archive swapped for a link after the request but before the job is refused, not extracted", async () => {
  const s = scene("arch-before");
  fs.writeFileSync(path.join(s.root, "a.tar"), "ORIGINAL");
  fs.writeFileSync(path.join(s.outside, "secret.tar"), "SECRET");
  const plan = await prepareExtract(s.root, "/a.tar", "/out", false, { overwrite: "rename" });
  fs.rmSync(path.join(s.root, "a.tar"));
  fs.symlinkSync(path.join(s.outside, "secret.tar"), path.join(s.root, "a.tar"));
  fs.writeFileSync(s.go, "");
  await assert.rejects(runExtract(plan, LIM, mkCtl().ctl));
  assert.deepEqual(fs.readdirSync(s.dest), []);
  assert.equal(fs.existsSync(s.seen), false);
});

test("an archive swapped for a link while the job runs is still read from the file that was opened", async () => {
  const s = scene("arch-during");
  fs.writeFileSync(path.join(s.root, "a.tar"), "ORIGINAL");
  fs.writeFileSync(path.join(s.outside, "secret.tar"), "SECRET");
  const plan = await prepareExtract(s.root, "/a.tar", "/out", false, { overwrite: "rename" });
  const job = runExtract(plan, LIM, mkCtl().ctl);
  await until(() => stagingWith(s.wd, "first.txt"), "the first file");
  fs.rmSync(path.join(s.root, "a.tar"));
  fs.symlinkSync(path.join(s.outside, "secret.tar"), path.join(s.root, "a.tar"));
  fs.writeFileSync(s.go, "");
  await job;
  assert.equal(fs.readFileSync(s.seen, "utf8"), "ORIGINAL", "the tool must read the opened file, not the name");
});

test("a split part that is a link is refused; the parts are copied into the work folder", async () => {
  const s = scene("split");
  fs.writeFileSync(path.join(s.root, "set.7z.001"), "part one");
  fs.writeFileSync(path.join(s.outside, "p2"), "outside part");
  fs.symlinkSync(path.join(s.outside, "p2"), path.join(s.root, "set.7z.002"));
  const plan = await prepareExtract(s.root, "/set.7z.001", "/out", false, { overwrite: "rename" });
  fs.writeFileSync(s.go, "");
  await assert.rejects(runExtract(plan, LIM, mkCtl().ctl));
  assert.deepEqual(leftovers(s.wd), []);
  fs.rmSync(path.join(s.root, "set.7z.002"));
  fs.writeFileSync(path.join(s.root, "set.7z.002"), "part two");
  const r = await runExtract(await prepareExtract(s.root, "/set.7z.001", "/out", false, { overwrite: "rename" }), LIM, mkCtl().ctl);
  assert.equal(r.files, 3);
  assert.deepEqual(leftovers(s.wd), []);
});

/* ---- the fallback folder, the file API and what compression reads ---- */

test("without FILEDECK_WORK_DIR the fallback is a fresh mkdtemp folder, not a predictable name", async () => {
  const s = scene("default-fallback");
  fs.chmodSync(s.root, 0o777);
  const saved = process.env.FILEDECK_WORK_DIR;
  delete process.env.FILEDECK_WORK_DIR;
  try {
    const plan = await prepareExtract(s.root, "/a.tar", "/out", false, { overwrite: "rename" });
    const job = runExtract(plan, LIM, mkCtl().ctl);
    const found = await until(
      () => fs.readdirSync(os.tmpdir()).filter((n) => /^filedeck-work-[A-Za-z0-9]{6}$/.test(n)).map((n) => path.join(os.tmpdir(), n)).find((d) => stagingWith(d, "first.txt")),
      "staging in a temp work folder",
    );
    assert.equal(fs.statSync(found).mode & 0o777, 0o700);
    fs.writeFileSync(s.go, "");
    await job;
    assert.deepEqual(tree(s.dest), ["first.txt", "second.txt", "sub", "sub/third.txt"]);
  } finally {
    process.env.FILEDECK_WORK_DIR = saved;
    fs.chmodSync(s.root, 0o755);
  }
});

test("Filedeck's own folders are not readable through the file API", () => {
  const s = scene("readapi");
  fs.mkdirSync(s.wd, { mode: 0o700 });
  fs.mkdirSync(path.join(s.root, ".filedeck-trash"));
  for (const p of ["/.filedeck-work", "/.filedeck-work/x/y", "/.filedeck-trash", "/out/.filedeck-trash/z"]) {
    assert.throws(() => resolveRead(s.root, p), (e: { status?: number }) => e.status === 403, p);
  }
  assert.doesNotThrow(() => resolveRead(s.root, "/out"));
});

const needTool = { skip: spawnSync("bsdtar", ["--version"]).status === 0 ? false : "bsdtar not installed" };
const listTar = (f: string) => spawnSync("bsdtar", ["-tf", f]).stdout.toString().split("\n").filter(Boolean);

test("compress and zip download never read a nested volume's trash or work folder into an archive", needTool, async () => {
  const s = scene("reserved-compress");
  delete process.env.FILEDECK_BSDTAR; // the real tool
  fs.mkdirSync(path.join(s.root, "src/vol/.filedeck-work"), { recursive: true });
  fs.mkdirSync(path.join(s.root, "src/vol/.filedeck-trash"));
  fs.writeFileSync(path.join(s.root, "src/vol/keep.txt"), "k");
  fs.writeFileSync(path.join(s.root, "src/vol/.filedeck-work/staged"), "s");
  fs.writeFileSync(path.join(s.root, "src/vol/.filedeck-trash/item"), "t");
  const plan = await prepareCompress(s.root, "/src", ["vol"], "tar.gz", "vol", { destDir: "/out" });
  const r = await runCompress(plan, LIM, mkCtl().ctl);
  const names = listTar(path.join(s.dest, "vol.tar.gz"));
  assert.ok(names.some((n) => n.endsWith("keep.txt")), names.join(","));
  assert.ok(!names.some((n) => n.includes(".filedeck-")), names.join(","));
  assert.equal(r.path, "/out/vol.tar.gz");
  const { zipStream } = await import("../src/archive.ts");
  const zip = path.join(s.dir, "dl.zip");
  const out = fs.createWriteStream(zip);
  await new Promise<void>((res, rej) => {
    const z = zipStream(path.join(s.root, "src"), ["vol"], new AbortController().signal);
    z.on("error", rej);
    out.on("close", () => res());
    z.pipe(out);
  });
  const zn = listTar(zip);
  assert.ok(zn.some((n) => n.endsWith("keep.txt")) && !zn.some((n) => n.includes(".filedeck-")), zn.join(","));
});

/* ---- privileges: these need the agent to run as root (CI runs the server tests as root) ---- */

const asRoot = { skip: process.getuid?.() === 0 ? false : "needs root" };
const NOBODY = 65534;
/** make a scene tree traversable by another user */
const opened = (s: { dir: string }) => {
  for (let d = s.dir; d !== path.dirname(tmp); d = path.dirname(d)) fs.chmodSync(d, 0o755);
  fs.chmodSync(tmp, 0o755);
  for (const f of fs.readdirSync(s.dir)) if (f !== "root") fs.chmodSync(path.join(s.dir, f), 0o755);
};

test("a child started with a user and group has no supplementary groups left", asRoot, () => {
  const r = spawnSync("grep", ["^Groups:", "/proc/self/status"], { uid: NOBODY, gid: NOBODY, encoding: "utf8" });
  assert.match(r.stdout, /^Groups:\s*$/m);
});

test("extracted files and folders belong to the destination folder's owner and group", asRoot, async () => {
  const s = scene("owner");
  opened(s);
  fs.chownSync(s.dest, NOBODY, NOBODY);
  fs.writeFileSync(s.go, "");
  const r = await runExtract(await prepareExtract(s.root, "/a.tar", "/out", true, { overwrite: "rename" }), LIM, mkCtl().ctl);
  const dir = path.join(s.root, r.path);
  for (const f of ["", "first.txt", "sub", "sub/third.txt"]) {
    const st = fs.lstatSync(path.join(dir, f));
    assert.deepEqual([st.uid, st.gid], [NOBODY, NOBODY], f || "folder");
  }
});

test("compression of a user's folder runs the tool as that user and the archive ends up theirs", asRoot, async () => {
  const s = scene("drop");
  opened(s);
  fs.mkdirSync(path.join(s.root, "src"));
  fs.writeFileSync(path.join(s.root, "src/f.txt"), "data");
  fs.chownSync(path.join(s.root, "src"), NOBODY, NOBODY);
  fs.chownSync(s.dest, NOBODY, NOBODY);
  fs.writeFileSync(s.go, "");
  const plan = await prepareCompress(s.root, "/src", ["f.txt"], "tar.gz", "mine", { destDir: "/out" });
  await runCompress(plan, LIM, mkCtl().ctl);
  const f = path.join(s.dest, "mine.tar.gz");
  assert.equal(fs.readFileSync(f, "utf8").trim(), String(NOBODY), "the stand-in tool reports the user it ran as");
  const st = fs.statSync(f);
  assert.deepEqual([st.uid, st.gid], [NOBODY, NOBODY]);
});

test("compression of a root-owned folder runs as the agent and leaves the archive private to it", asRoot, async () => {
  const s = scene("rootowned");
  fs.mkdirSync(path.join(s.root, "src"));
  fs.writeFileSync(path.join(s.root, "src/f.txt"), "data");
  fs.writeFileSync(s.go, "");
  const plan = await prepareCompress(s.root, "/src", ["f.txt"], "tar.gz", "priv", { destDir: "/out" });
  await runCompress(plan, LIM, mkCtl().ctl);
  assert.equal(fs.statSync(path.join(s.dest, "priv.tar.gz")).mode & 0o777, 0o600);
});
