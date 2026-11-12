import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { prepareCompress, prepareExtract, runCompress, runExtract } from "../src/archive.ts";
import { haveSevenZip } from "../src/sevenzip.ts";
import type { JobCtl } from "../src/jobs.ts";

/**
 * Tests with the real 7-Zip (`7zz`); they skip where it is not installed (CI has it). They check that what the
 * agent promises about 7-Zip holds for the real program, not only for the stand-ins used elsewhere.
 */
const HAVE = spawnSync("bsdtar", ["--version"]).status === 0 && haveSevenZip();
const needSz = { skip: HAVE ? false : "7-Zip (7zz) or bsdtar not installed" };
const needSzRoot = { skip: !HAVE ? "7-Zip (7zz) or bsdtar not installed" : process.getuid?.() === 0 ? false : "needs root (the privilege drop only happens for a root agent)" };
const NOBODY = 65534;

let tmp: string;
before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fd-7z-"));
  fs.chmodSync(tmp, 0o755);
  process.env.FILEDECK_WORK_DIR = path.join(tmp, "workdir");
  fs.mkdirSync(process.env.FILEDECK_WORK_DIR, { mode: 0o700 });
});
after(() => {
  delete process.env.FILEDECK_WORK_DIR;
  fs.rmSync(tmp, { recursive: true, force: true });
});

const mkCtl = () => ({ signal: new AbortController().signal, progress: { bytes: 0, totalBytes: 0, entries: 0, totalEntries: 0, current: "" } }) as unknown as JobCtl;
const LIM = { maxEntries: 100000, maxBytes: 1 << 30 };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function scene(name: string) {
  const dir = path.join(tmp, name);
  const root = path.join(dir, "root");
  const outside = path.join(dir, "outside");
  fs.mkdirSync(path.join(root, "out"), { recursive: true });
  fs.mkdirSync(path.join(root, "src"));
  fs.mkdirSync(outside);
  fs.chmodSync(dir, 0o755);
  fs.chmodSync(root, 0o755);
  return { dir, root, outside, out: path.join(root, "out"), src: path.join(root, "src") };
}

test("a split 7z set without a password compresses; a subfolder swapped for an outside link mid-job puts no outside file in the archive (user-owned folder, agent as root)", needSzRoot, async () => {
  // The selected folder belongs to an unprivileged user, so the agent runs 7-Zip as that user: a link that user (or anyone
  // else able to write there) swaps in cannot lead 7-Zip to a file that user could not read. Without the privilege drop (a
  // root-owned selection with a user-writable subfolder) this is closed only by the sandbox in a later change.
  const s = scene("swap-compress");
  const sel = path.join(s.src, "sel");
  fs.mkdirSync(path.join(sel, "z"), { recursive: true });
  for (let i = 0; i < 40; i++) fs.writeFileSync(path.join(sel, `a${String(i).padStart(2, "0")}.bin`), randomBytes(200_000));
  fs.writeFileSync(path.join(sel, "z/inner.txt"), "inner");
  fs.writeFileSync(path.join(s.outside, "inner.txt"), "OUTSIDE-SECRET-OUTSIDE-SECRET", { mode: 0o600 });
  fs.chmodSync(s.outside, 0o755);
  for (const p of [s.src, sel, path.join(sel, "z"), s.out]) fs.chownSync(p, NOBODY, NOBODY);
  for (const f of fs.readdirSync(sel)) if (f !== "z") fs.chownSync(path.join(sel, f), NOBODY, NOBODY);
  fs.chownSync(path.join(sel, "z/inner.txt"), NOBODY, NOBODY);

  const plan = await prepareCompress(s.root, "/src", ["sel"], "7z", "split", { destDir: "/out", splitBytes: 65_536, level: 0 });
  const job = runCompress(plan, LIM, mkCtl()).then(
    (r) => ({ ok: true as const, r }),
    (e: Error) => ({ ok: false as const, e }),
  );
  // after 7-Zip has scanned and started writing, swap the subfolder it listed for a link
  for (let i = 0; i < 400; i++) {
    if (fs.readdirSync(s.out).some((n) => n.includes(".7z"))) break;
    await sleep(10);
  }
  fs.renameSync(path.join(sel, "z"), path.join(sel, "z-moved"));
  fs.symlinkSync(s.outside, path.join(sel, "z"));
  const res = await job;
  const all = fs.readdirSync(s.out).map((n) => fs.readFileSync(path.join(s.out, n)));
  for (const b of all) assert.ok(!b.includes("OUTSIDE-SECRET"), "an outside file must not be in any volume");
  console.log(`# swap-compress: job ${res.ok ? "finished" : "failed: " + res.e.message}, volumes: ${fs.readdirSync(s.out).filter((n) => !n.startsWith(".")).length}`);
});

test("the real 7-Zip extracts a split set without a password; swapping the destination for an outside link mid-job writes nothing outside", needSz, async () => {
  const s = scene("swap-extract");
  const files = path.join(s.src, "pack");
  fs.mkdirSync(files);
  for (let i = 0; i < 60; i++) fs.writeFileSync(path.join(files, `f${i}.bin`), randomBytes(150_000));
  const c = await runCompress(await prepareCompress(s.root, "/src", ["pack"], "7z", "set", { destDir: "/src", splitBytes: 65_536, level: 0 }), LIM, mkCtl());
  assert.ok(c.path.endsWith("set.7z.001"), c.path);
  const plan = await prepareExtract(s.root, c.path, "/out", true, { overwrite: "rename" });
  assert.equal(plan.viaSz, true, "a split set is extracted by 7-Zip");
  const job = runExtract(plan, LIM, mkCtl());
  const wd = path.join(s.root, ".filedeck-work");
  for (let i = 0; i < 400 && !(fs.existsSync(wd) && fs.readdirSync(wd).some((n) => n.endsWith(".alive"))); i++) await sleep(5); // the job holds its destination now

  const moved = path.join(s.root, "out-moved");
  fs.renameSync(s.out, moved);
  fs.symlinkSync(s.outside, s.out);
  const r = await job;
  assert.deepEqual(fs.readdirSync(s.outside), [], "nothing may appear outside the root");
  assert.equal(fs.readdirSync(path.join(moved, path.basename(r.path), "pack")).length, 60);
  assert.deepEqual(fs.readdirSync(path.join(s.root, ".filedeck-work")).filter((n) => !n.endsWith(".alive")), [], "no staging left behind");
});

test("7-Zip compression leaves a nested volume's reserved folders out of the archive", needSz, async () => {
  const s = scene("reserved");
  const vol = path.join(s.src, "vol");
  fs.mkdirSync(path.join(vol, ".filedeck-work"), { recursive: true });
  fs.mkdirSync(path.join(vol, ".filedeck-trash"));
  fs.writeFileSync(path.join(vol, "keep.txt"), "k");
  fs.writeFileSync(path.join(vol, ".filedeck-work/staged"), "s");
  fs.writeFileSync(path.join(vol, ".filedeck-trash/item"), "t");
  const r = await runCompress(await prepareCompress(s.root, "/src", ["vol"], "7z", "vol", { destDir: "/out", splitBytes: 65_536 }), LIM, mkCtl());
  const first = path.join(s.root, r.path);
  const list = spawnSync(process.env.FILEDECK_7Z || "7zz", ["l", "-slt", "-ba", first], { encoding: "utf8" }).stdout;
  assert.match(list, /keep\.txt/);
  assert.doesNotMatch(list, /\.filedeck-(work|trash)/);
});

test("diagnostic: does 7-Zip open nested paths by name? (recorded in the log; never fails)", needSz, () => {
  const strace = spawnSync("strace", ["-V"], { encoding: "utf8" });
  if (strace.status !== 0) {
    console.log("# strace not available: diagnostic skipped");
    return;
  }
  try {
    const d = path.join(tmp, "strace");
    fs.mkdirSync(path.join(d, "t/sub/deeper"), { recursive: true });
    fs.writeFileSync(path.join(d, "t/sub/deeper/f.txt"), "x");
    const log = path.join(d, "trace.log");
    spawnSync("strace", ["-f", "-o", log, "-e", "trace=openat,mkdir,mkdirat,newfstatat", process.env.FILEDECK_7Z || "7zz", "a", "-t7z", "-snl", path.join(d, "out.7z"), "./t"], { cwd: d, encoding: "utf8" });
    const lines = fs.readFileSync(log, "utf8").split("\n").filter((l) => /t\/sub|"\.\/t|f\.txt/.test(l));
    console.log("# 7-Zip system calls touching the nested folder (a relative path through t/sub means it opens by name):");
    for (const l of lines.slice(0, 40)) console.log("#   " + l);
  } catch (e) {
    console.log("# strace diagnostic failed:", (e as Error).message);
  }
});
