import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { archiveBase, extractTar, prepareCompress, prepareExtract, runCompress, runExtract, sweepWorkArea } from "../src/archive.ts";
import { assertNotTrash, resolveRead } from "../src/paths.ts";
import { jobMayWrite } from "../src/readonly.ts";
import { spawnSync } from "node:child_process";
import * as ops from "../src/fsops.ts";
import { Readable } from "node:stream";
import type { JobCtl } from "../src/jobs.ts";
import { resetSandbox } from "../src/sandbox.ts";

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
const ENVS = ["FILEDECK_SANDBOX", "FILEDECK_BSDTAR", "FILEDECK_7Z", "FILEDECK_7Z_RECHECK", "FILEDECK_WORK_DIR"];
before(() => {
  for (const k of ENVS) saved[k] = process.env[k];
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fd-pinned-"));
  work = path.join(tmp, "work");
  fs.mkdirSync(work, { mode: 0o700 });
  process.env.FILEDECK_WORK_DIR = work;
  process.env.FILEDECK_7Z_RECHECK = "1";
  // The stand-in tools here are shell scripts in a temporary folder, which the sandbox (rightly) would not let them run from: this file tests
  // the pinning and the moves around the tools. archive-sandbox.test.ts runs the real tools in the real sandbox.
  process.env.FILEDECK_SANDBOX = "off";
  resetSandbox();
});
after(() => {
  for (const k of ENVS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  resetSandbox();
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
  *"-T -"*) # compressing: take the archive path after -cf (or write to stdout for "-"), wait, write it
    cat > /dev/null
    out=""; prev=""
    for a in "$@"; do [ "$prev" = "-cf" ] && out="$a"; prev="$a"; done
    ${wait}
    printf "ARCHIVE:%s" "$(id -u)" > "$out"; exit 0;;
esac
cat '${path.join(dir, "first.tar")}'
${wait}
case "$*" in *"@-"*) cat > '${seen}';; esac
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
  a) # compressing: the archive path follows "--"; what it makes depends on the test's mode file
     out=""; prev=""
     for a in "$@"; do [ "$prev" = "--" ] && out="$a"; prev="$a"; done
     case "$(cat '${path.join(dir, "szmode")}' 2>/dev/null)" in
       dir) mkdir "$out"; echo x > "$out/inner"; exit 0;;
       two) printf 7Z > "$out.001"; printf 7Z > "$out.002"; exit 0;;
       sparse) printf 7Z > "$out"; truncate -s 300M "$out"; exit 0;;
       args) printf '%s\n' "$@" > '${path.join(dir, "szargs")}'; for a in "$@"; do case "$a" in -x@*) f="$(printf %s "$a" | cut -c4-)"; { cat "$f" 2>&1 || echo "cannot read $f as $(id -u)"; } > '${path.join(dir, "szlist")}';; esac; done; printf 7Z > "$out"; exit 0;;
       hardlink) ln '${path.join(dir, "outside", "secret.bin")}' "$out"; exit 0;;
       *) printf 7Z > "$out"; exit 0;;
     esac;;
  *) exit 0;;
esac
`,
    { mode: 0o755 },
  );
  process.env.FILEDECK_BSDTAR = tar;
  process.env.FILEDECK_7Z = sz;
  const szmode = path.join(dir, "szmode");
  return { dir, root, outside, go, seen, szmode, dest: path.join(root, "out"), wd: path.join(root, ".filedeck-work") };
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
  // a writer whose clock runs ahead is never mistaken for an idle one, and the sweep can run again later
  make(s.wd, "ahead.eeeeeeeeeeee.x.AbCdE5", -3 * DAY, -3 * DAY);
  make(s.wd, "late.ffffffffffff.x.AbCdE6", 3 * DAY, 3 * DAY);
  await sweepWorkArea(s.root, path.join(s.dir, "no-such-mounts"));
  assert.ok(fs.existsSync(path.join(s.wd, "ahead.eeeeeeeeeeee.x.AbCdE5")), "a future time is not idle");
  assert.equal(fs.existsSync(path.join(s.wd, "late.ffffffffffff.x.AbCdE6")), false, "a later sweep removes what became idle meanwhile");
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
  assert.match(fs.readFileSync(path.join(moved, "result.tar.gz"), "utf8"), /^ARCHIVE/);
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
  fs.writeFileSync(s.go, "");
  // refused when the request is checked, or at the latest when the job opens the parts
  await assert.rejects(async () => runExtract(await prepareExtract(s.root, "/set.7z.001", "/out", false, { overwrite: "rename" }), LIM, mkCtl().ctl));
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
const listTar = (f: string) => spawnSync("bsdtar", ["-tf", f], { timeout: 60_000 }).stdout.toString().split("\n").filter(Boolean);

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

/*
 * Privilege tests. They run everywhere (CI forbids skipped tests): as root they check the real behaviour, as an
 * ordinary user the same scenario checks that nothing is changed for an agent that cannot hand out ownership.
 */
const IS_ROOT = process.getuid?.() === 0;
const ME = process.getuid?.() ?? 0;
const NOBODY = 65534;
const OWNER = IS_ROOT ? NOBODY : ME;
/** make a scene tree traversable by another user */
const opened = (s: { dir: string }) => {
  for (let d = s.dir; d !== path.dirname(tmp); d = path.dirname(d)) fs.chmodSync(d, 0o755);
  fs.chmodSync(tmp, 0o755);
  for (const f of fs.readdirSync(s.dir)) if (f !== "root") fs.chmodSync(path.join(s.dir, f), 0o755);
};
const chownIfRoot = (p: string) => {
  if (IS_ROOT) fs.chownSync(p, NOBODY, NOBODY);
};

test("a child started with a user and group has no supplementary groups left (checked when root)", () => {
  if (!IS_ROOT) return; // starting a child as another user needs root
  const r = spawnSync("grep", ["^Groups:", "/proc/self/status"], { uid: NOBODY, gid: NOBODY, encoding: "utf8", timeout: 30_000 });
  assert.match(r.stdout, /^Groups:\s*$/m);
});

test("extracted files and folders belong to the destination folder's owner and group", async () => {
  const s = scene("owner");
  opened(s);
  chownIfRoot(s.dest);
  fs.writeFileSync(s.go, "");
  const r = await runExtract(await prepareExtract(s.root, "/a.tar", "/out", true, { overwrite: "rename" }), LIM, mkCtl().ctl);
  const dir = path.join(s.root, r.path);
  for (const f of ["", "first.txt", "sub", "sub/third.txt"]) {
    const st = fs.lstatSync(path.join(dir, f));
    assert.equal(st.uid, OWNER, f || "folder");
    if (IS_ROOT) assert.equal(st.gid, NOBODY, f || "folder");
  }
});

test("compression of a user's folder runs the tool as that user and the archive ends up theirs", async () => {
  const s = scene("drop");
  opened(s);
  fs.mkdirSync(path.join(s.root, "src"));
  fs.writeFileSync(path.join(s.root, "src/f.txt"), "data");
  chownIfRoot(path.join(s.root, "src"));
  chownIfRoot(s.dest);
  fs.writeFileSync(s.go, "");
  const plan = await prepareCompress(s.root, "/src", ["f.txt"], "tar.gz", "mine", { destDir: "/out" });
  await runCompress(plan, LIM, mkCtl().ctl);
  const f = path.join(s.dest, "mine.tar.gz");
  if (IS_ROOT) assert.equal(fs.readFileSync(f, "utf8").trim(), `ARCHIVE:${NOBODY}`, "the stand-in tool reports the user it ran as");
  assert.equal(fs.statSync(f).uid, OWNER);
});

test("compression of a root-owned folder runs as the agent and leaves the archive private to it", async () => {
  const s = scene("rootowned");
  fs.mkdirSync(path.join(s.root, "src"));
  fs.writeFileSync(path.join(s.root, "src/f.txt"), "data");
  fs.writeFileSync(s.go, "");
  const plan = await prepareCompress(s.root, "/src", ["f.txt"], "tar.gz", "priv", { destDir: "/out" });
  await runCompress(plan, LIM, mkCtl().ctl);
  const mode = fs.statSync(path.join(s.dest, "priv.tar.gz")).mode & 0o777;
  if (IS_ROOT) assert.equal(mode, 0o600);
  else assert.ok(mode & 0o400, "readable by its owner");
});

/* ---- read-only folders: the pinned locations are checked where they really are ---- */

/** the guard the job routes pass: a folder may be written when it is not under (or, for a merge, holding) a read-only prefix */
const roGuard = (root: string) => (loc: string, contains: boolean) => {
  if (!jobMayWrite(root, ["/ro"], loc, { contains })) throw Object.assign(new Error("read-only volume"), { status: 403 });
};
function roScene(name: string) {
  const s = scene(name);
  fs.mkdirSync(path.join(s.root, "ro"));
  fs.writeFileSync(path.join(s.root, "ro/protected.txt"), "ORIGINAL");
  fs.writeFileSync(path.join(s.dir, "first.tar"), entry("ro/protected.txt", "OVERWRITTEN"));
  fs.writeFileSync(path.join(s.dir, "rest.tar"), Buffer.concat([entry("second.txt", "two"), Buffer.alloc(1024)]));
  return s;
}
const protectedFile = (s: { root: string }) => fs.readFileSync(path.join(s.root, "ro/protected.txt"), "utf8");

for (const policy of ["overwrite", "skip"] as const) {
  test(`${policy}: a destination swapped for a link to a read-only folder's parent before the job starts is refused`, async () => {
    const s = roScene(`ro-start-${policy}`);
    fs.writeFileSync(s.go, "");
    fs.mkdirSync(path.join(s.root, "d"));
    const plan = await prepareExtract(s.root, "/a.tar", "/d", false, { overwrite: policy });
    fs.rmdirSync(path.join(s.root, "d"));
    fs.symlinkSync(s.root, path.join(s.root, "d")); // the job now resolves to the folder that holds /ro
    await assert.rejects(runExtract(plan, LIM, mkCtl().ctl, roGuard(s.root)), (e: { status?: number }) => e.status === 403 || /ELOOP|ENOTDIR/.test(String(e)));
    assert.equal(protectedFile(s), "ORIGINAL");
    assert.deepEqual(leftovers(s.wd), []);
  });

  test(`${policy}: a folder merged into that is swapped for a link to a read-only folder's parent mid-job leaves the protected file alone`, async () => {
    const s = roScene(`ro-merge-${policy}`);
    fs.mkdirSync(path.join(s.dest, "a"));
    const plan = await prepareExtract(s.root, "/a.tar", "/out", true, { overwrite: policy });
    const job = runExtract(plan, LIM, mkCtl().ctl, roGuard(s.root));
    await until(() => stagingWith(s.wd, "ro/protected.txt"), "the staged files");
    fs.rmdirSync(path.join(s.dest, "a"));
    fs.symlinkSync(s.root, path.join(s.dest, "a"));
    fs.writeFileSync(s.go, "");
    await job.catch(() => undefined); // it may finish into a new folder or refuse; either way the protected file is untouched
    assert.equal(protectedFile(s), "ORIGINAL");
    assert.deepEqual(fs.readdirSync(path.join(s.root, "ro")), ["protected.txt"]);
  });
}

test("a destination reached through a swapped parent folder that now leads into a read-only folder is refused (extract and compress)", async () => {
  const s = roScene("ro-parent");
  fs.writeFileSync(s.go, "");
  fs.mkdirSync(path.join(s.root, "d/ro"), { recursive: true });
  fs.mkdirSync(path.join(s.root, "src"));
  fs.writeFileSync(path.join(s.root, "src/f.txt"), "data");
  const ex = await prepareExtract(s.root, "/a.tar", "/d/ro", false, { overwrite: "overwrite" });
  const co = await prepareCompress(s.root, "/src", ["f.txt"], "tar.gz", "x", { destDir: "/d/ro" });
  fs.rmSync(path.join(s.root, "d"), { recursive: true });
  fs.symlinkSync(s.root, path.join(s.root, "d")); // /d/ro now means /ro, which is read-only
  await assert.rejects(runExtract(ex, LIM, mkCtl().ctl, roGuard(s.root)), (e: { status?: number }) => e.status === 403);
  await assert.rejects(runCompress(co, LIM, mkCtl().ctl, roGuard(s.root)), (e: { status?: number }) => e.status === 403);
  assert.deepEqual(fs.readdirSync(path.join(s.root, "ro")), ["protected.txt"]);
  assert.equal(protectedFile(s), "ORIGINAL");
  assert.deepEqual(leftovers(s.wd), []);
});

/* ---- a user's tool never gets its output walked or moved by root ---- */

const outDirs = () => fs.readdirSync(os.tmpdir()).filter((n) => /^filedeck-out-/.test(n));
function szCompressScene(name: string, mode: string) {
  const s = scene(name);
  opened(s);
  fs.mkdirSync(path.join(s.root, "src"));
  fs.writeFileSync(path.join(s.root, "src/f.txt"), "data");
  fs.writeFileSync(path.join(s.outside, "secret.bin"), "ROOT-ONLY", { mode: 0o600 });
  fs.chmodSync(s.outside, 0o755);
  fs.writeFileSync(s.szmode, mode);
  chownIfRoot(path.join(s.root, "src"));
  chownIfRoot(s.dest);
  return s;
}
const szPlan = (s: { root: string }) => prepareCompress(s.root, "/src", ["f.txt"], "7z", "x", { destDir: "/out", splitBytes: 65_536 });

test("a user-run 7-Zip's file is copied into the output folder through descriptors and belongs to the folder's owner", async () => {
  const before = outDirs().length;
  const s = szCompressScene("sz-ok", "ok");
  const r = await runCompress(await szPlan(s), LIM, mkCtl().ctl);
  assert.equal(r.volumes, 1);
  const f = path.join(s.dest, "x.7z");
  assert.equal(fs.readFileSync(f, "utf8"), "7Z");
  assert.equal(fs.statSync(f).uid, OWNER);
  assert.equal(outDirs().length, before, "the tool's private folder is removed");
});

test("a user-run 7-Zip that leaves a folder as its output is refused, nothing is walked or moved", async () => {
  if (!IS_ROOT) return; // without the privilege drop 7-Zip writes into the agent's own private folder
  const s = szCompressScene("sz-dir", "dir");
  await assert.rejects(runCompress(await szPlan(s), LIM, mkCtl().ctl), (e: { status?: number }) => e.status === 500);
  assert.deepEqual(fs.readdirSync(s.dest), []);
  assert.equal(fs.readFileSync(path.join(s.outside, "secret.bin"), "utf8"), "ROOT-ONLY");
});

test("a user-run 7-Zip that leaves a hard link to someone else's file is refused", async () => {
  if (!IS_ROOT) return;
  const s = szCompressScene("sz-hl", "hardlink");
  await assert.rejects(runCompress(await szPlan(s), LIM, mkCtl().ctl));
  assert.deepEqual(fs.readdirSync(s.dest), []);
  assert.equal(fs.statSync(path.join(s.outside, "secret.bin")).uid, 0, "the file was not handed to the folder's owner");
});

/* ---- opening a name the user controls never blocks, and only plain, readable archives are taken ---- */

const mkfifo = (p: string) => assert.equal(spawnSync("mkfifo", [p], { timeout: 30_000 }).status, 0);
const within = <T,>(p: Promise<T>, ms: number) => Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(new Error("blocked")), ms))]);

test("a pipe swapped in for the archive is refused at once instead of blocking the open", { timeout: 60_000 }, async () => {
  const s = scene("fifo");
  const plan = await prepareExtract(s.root, "/a.tar", "/out", false, { overwrite: "rename" });
  fs.rmSync(path.join(s.root, "a.tar"));
  mkfifo(path.join(s.root, "a.tar"));
  await assert.rejects(within(runExtract(plan, LIM, mkCtl().ctl), 5000), (e: Error) => e.message !== "blocked" && /regular file/.test(e.message));
});

test("a pipe swapped in for a split part is refused at once", { timeout: 60_000 }, async () => {
  const s = scene("fifo-split");
  fs.writeFileSync(path.join(s.root, "set.7z.001"), "one");
  const plan = await prepareExtract(s.root, "/set.7z.001", "/out", false, { overwrite: "rename" });
  mkfifo(path.join(s.root, "set.7z.002"));
  await assert.rejects(within(runExtract(plan, LIM, mkCtl().ctl), 5000), (e: Error) => e.message !== "blocked");
  assert.deepEqual(leftovers(s.wd), []);
});

test("a hard link to an archive only someone else can read is not taken as the folder's archive (checked when root)", async () => {
  if (!IS_ROOT) return;
  const s = scene("hl-archive");
  opened(s);
  fs.writeFileSync(path.join(s.outside, "private.tar"), "x", { mode: 0o600 });
  fs.mkdirSync(path.join(s.root, "mine"));
  fs.chownSync(path.join(s.root, "mine"), NOBODY, NOBODY);
  fs.linkSync(path.join(s.outside, "private.tar"), path.join(s.root, "mine/a.tar"));
  const plan = await prepareExtract(s.root, "/mine/a.tar", "/out", false, { overwrite: "rename" });
  await assert.rejects(runExtract(plan, LIM, mkCtl().ctl), (e: { status?: number }) => e.status === 403);
});

/* ---- Filedeck's own folders are out of reach of stat, properties and git as well ---- */

test("stat, properties and git refuse the reserved folders", async () => {
  const s = scene("reserved-reads");
  fs.mkdirSync(s.wd, { mode: 0o700 });
  fs.mkdirSync(path.join(s.root, ".filedeck-trash"));
  await assert.rejects(ops.stat(s.root, "/.filedeck-work"), (e: { status?: number }) => e.status === 403);
  await assert.rejects(ops.stat(s.root, "/.filedeck-trash"), (e: { status?: number }) => e.status === 403);
  const { props } = await import("../src/props.ts");
  const { loadConfig } = await import("../src/config.ts");
  const cfg = loadConfig({ FILEDECK_ROOT: s.root, FILEDECK_NODE: "t" } as never);
  await assert.rejects(props(cfg, "/.filedeck-work"), (e: { status?: number }) => e.status === 403);
  const { createAgent } = await import("../src/agent.ts");
  const app = createAgent(cfg);
  for (const u of ["/api/git/info?path=/.filedeck-work", "/api/git/show?path=/.filedeck-work/x&rev=HEAD", "/api/fs/stat?path=/.filedeck-work"]) {
    const r = await app.request(u);
    assert.equal(r.status, 403, u);
  }
  await (app as unknown as { close(): Promise<void> }).close();
});

/* ---- queued jobs run outside the request that made them: they open their own read-only scope ---- */

test("extract and compress jobs from the queue still work with read-only prefixes configured", needTool, async () => {
  const { createAgent } = await import("../src/agent.ts");
  const { loadConfig } = await import("../src/config.ts");
  const root = path.join(tmp, "queued");
  fs.mkdirSync(path.join(root, "ro"), { recursive: true });
  fs.mkdirSync(path.join(root, "src"));
  fs.mkdirSync(path.join(root, "out"));
  fs.writeFileSync(path.join(root, "src/f.txt"), "queued-data");
  delete process.env.FILEDECK_BSDTAR; // the real tool
  const app = createAgent(loadConfig({ FILEDECK_ROOT: root, FILEDECK_NODE: "q", FILEDECK_READONLY: "/ro" } as never));
  const post = (u: string, b: unknown) => app.request(u, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) });
  const finish = async (id: string) => {
    for (let i = 0; i < 400; i++) {
      const v = (await (await app.request(`/api/jobs/${id}`)).json()) as { state: string; error?: string };
      if (["done", "failed", "canceled"].includes(v.state)) return v;
      await sleep(25);
    }
    throw new Error("job did not finish");
  };
  const c = await post("/api/jobs/compress", { dir: "/src", names: ["f.txt"], format: "tar.gz", name: "q", destDir: "/out" });
  assert.equal(c.status, 202, await c.clone().text());
  const cj = await finish(((await c.json()) as { id: string }).id);
  assert.equal(cj.state, "done", JSON.stringify(cj));
  assert.ok(fs.existsSync(path.join(root, "out/q.tar.gz")));
  const x = await post("/api/jobs/extract", { path: "/out/q.tar.gz", destDir: "/src", subfolder: true, overwrite: "overwrite" });
  assert.equal(x.status, 202, await x.clone().text());
  const xj = await finish(((await x.json()) as { id: string }).id);
  assert.equal(xj.state, "done", JSON.stringify(xj));
  assert.equal(fs.readFileSync(path.join(root, "src/q/f.txt"), "utf8"), "queued-data");
  // and a job aimed at the read-only prefix is still refused
  const bad = await post("/api/jobs/extract", { path: "/out/q.tar.gz", destDir: "/ro", subfolder: false, overwrite: "overwrite" });
  assert.equal(bad.status, 403);
  await (app as unknown as { close(): Promise<void> }).close();
});

/* ---- bounds on what a user's tool writes, the output name, the mode rule and the exclude list ---- */

test("a tiny selection whose tool leaves a huge sparse output is refused before anything is copied", async () => {
  const s = szCompressScene("sz-sparse", "sparse");
  const before = outDirs().length;
  await assert.rejects(runCompress(await szPlan(s), LIM, mkCtl().ctl), (e: { status?: number; message?: string }) => e.status === 413 && /over the limit/.test(e.message ?? ""));
  assert.deepEqual(fs.readdirSync(s.dest), [], "nothing was written to the output folder");
  assert.equal(outDirs().length, before);
});

test("the produced archive is held to the configured archive size limit", async () => {
  const s = szCompressScene("sz-limit", "ok");
  await assert.rejects(runCompress(await szPlan(s), { maxEntries: 100, maxBytes: 1 }, mkCtl().ctl), (e: { status?: number }) => e.status === 413);
  assert.deepEqual(fs.readdirSync(s.dest), []);
});

test("an archive named like a reserved folder is refused", async () => {
  const s = szCompressScene("sz-name", "ok");
  for (const n of [".filedeck-work-abc", ".filedeck-work", ".filedeck-trash"]) {
    await assert.rejects(prepareCompress(s.root, "/src", ["f.txt"], "tar.gz", n, { destDir: "/out" }), (e: { status?: number }) => e.status === 400, n);
  }
});

test("7-Zip gets the fixed reserved names as patterns and the scanned paths in a list file, not on the command line", async () => {
  const s = szCompressScene("sz-args", "args");
  for (const f of ["szargs", "szlist"]) fs.writeFileSync(path.join(s.dir, f), "", { mode: 0o666 }), fs.chmodSync(path.join(s.dir, f), 0o666); // the stand-in may run as another user
  fs.mkdirSync(path.join(s.root, "src/vol/deep/.filedeck-work-abc"), { recursive: true });
  fs.writeFileSync(path.join(s.root, "src/vol/deep/.filedeck-work-abc/x"), "x");
  const plan = await prepareCompress(s.root, "/src", ["vol"], "7z", "x", { destDir: "/out", splitBytes: 65_536 });
  await runCompress(plan, LIM, mkCtl().ctl);
  const args = fs.readFileSync(path.join(s.dir, "szargs"), "utf8");
  assert.match(args, /^-xr!\.filedeck-trash$/m);
  assert.match(args, /^-xr!\.filedeck-work$/m);
  assert.doesNotMatch(args, /deep\/\.filedeck-work-abc/, "scanned paths are not arguments");
  assert.match(fs.readFileSync(path.join(s.dir, "szlist"), "utf8"), /^vol\/deep\/\.filedeck-work-abc$/m);
});

test("the mode of a produced archive follows one rule: private when read with more privilege than the destination's owner", async () => {
  const s = szCompressScene("sz-mode", "ok");
  const r = await runCompress(await szPlan(s), LIM, mkCtl().ctl);
  void r;
  const mode = fs.statSync(path.join(s.dest, "x.7z")).mode & 0o777;
  // the tool ran as the destination's owner (or the agent is that user): world-readable like any file the owner makes
  assert.equal(mode & 0o600, 0o600);
  const t = await prepareCompress(s.root, "/src", ["f.txt"], "tar.gz", "t", { destDir: "/out" });
  await runCompress(t, LIM, mkCtl().ctl);
  const tm = fs.statSync(path.join(s.dest, "t.tar.gz")).mode & 0o777;
  assert.equal(IS_ROOT ? tm : tm & 0o600, IS_ROOT ? 0o644 : 0o600, "the bsdtar path follows the same rule");
});

test("an archive that is a second name for a file in a root-owned folder is refused (checked when root)", async () => {
  if (!IS_ROOT) return;
  const s = scene("hl-root");
  opened(s);
  fs.writeFileSync(path.join(s.outside, "p.tar"), "x", { mode: 0o644 });
  fs.chmodSync(s.root, 0o777);
  fs.linkSync(path.join(s.outside, "p.tar"), path.join(s.root, "planted.tar"));
  const plan = await prepareExtract(s.root, "/planted.tar", "/out", false, { overwrite: "rename" });
  await assert.rejects(runExtract(plan, LIM, mkCtl().ctl), (e: { status?: number }) => e.status === 403);
});

test("the archive size setting applies to the total of the volumes the agent's own tool produced", async () => {
  const s = scene("sz-total");
  fs.mkdirSync(path.join(s.root, "src"), { recursive: true });
  fs.writeFileSync(path.join(s.root, "src/f.txt"), "data");
  fs.writeFileSync(s.szmode, "two");
  const plan = await prepareCompress(s.root, "/src", ["f.txt"], "7z", "x", { destDir: "/out", splitBytes: 65_536 });
  // each volume (2 bytes) is within the limit, the two together (4 bytes) are not
  await assert.rejects(runCompress(plan, { maxEntries: 100, maxBytes: 3 }, mkCtl().ctl), (e: { status?: number; message?: string }) => e.status === 413 && /the archive is 4 bytes/.test(e.message ?? ""));
  assert.deepEqual(fs.readdirSync(s.dest), []);
  const ok = await runCompress(plan, { maxEntries: 100, maxBytes: 1 << 20 }, mkCtl().ctl);
  assert.equal(ok.volumes, 2);
});

test("the exclude list file keeps its mode whatever the umask (set on its descriptor)", async () => {
  if (!IS_ROOT) return; // needs the tool to run as another user than the file's creator (a root agent); a umask that hides the file from its owner also stops a plain user from making the work folder
  const s = szCompressScene("sz-umask", "args");
  for (const f of ["szargs", "szlist"]) fs.writeFileSync(path.join(s.dir, f), "", { mode: 0o666 }), fs.chmodSync(path.join(s.dir, f), 0o666);
  fs.mkdirSync(path.join(s.root, "src/vol/.filedeck-work-abc"), { recursive: true });
  const old = process.umask(0o777);
  try {
    await runCompress(await prepareCompress(s.root, "/src", ["vol"], "7z", "x", { destDir: "/out", splitBytes: 65_536 }), LIM, mkCtl().ctl);
  } finally {
    process.umask(old);
  }
  assert.match(fs.readFileSync(path.join(s.dir, "szlist"), "utf8"), /^vol\/\.filedeck-work-abc$/m, "the tool could read the list");
});
