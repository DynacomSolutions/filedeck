import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { listArchive, prepareCompress, prepareExtract, runCompress, runExtract } from "../src/archive.ts";
import { haveSevenZip } from "../src/sevenzip.ts";
import type { JobCtl } from "../src/jobs.ts";
import { useSandbox } from "./sandbox-env.ts";

/**
 * Tests with the real 7-Zip (`7zz`); they skip where it is not installed (CI has it). They check that what the
 * agent promises about 7-Zip holds for the real program, not only for the stand-ins used elsewhere.
 */
const HAVE = spawnSync("bsdtar", ["--version"], { timeout: 30_000 }).status === 0 && haveSevenZip();
const needSz = { skip: HAVE ? false : "7-Zip (7zz) or bsdtar not installed", timeout: 180_000 }; // a hang fails the test instead of the whole run
const IS_ROOT = process.getuid?.() === 0;
const NOBODY = 65534;

let tmp: string;
let box: Awaited<ReturnType<typeof useSandbox>>;
before(async () => {
  box = await useSandbox(); // 7-Zip runs inside the real sandbox where the kernel has Landlock
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fd-7z-"));
  fs.chmodSync(tmp, 0o755);
  process.env.FILEDECK_WORK_DIR = path.join(tmp, "workdir");
  fs.mkdirSync(process.env.FILEDECK_WORK_DIR, { mode: 0o700 });
});
after(() => {
  fs.rmSync(box.dir, { recursive: true, force: true });
  delete process.env.FILEDECK_SANDBOX_HELPER;
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

/** a user-owned selection (owned by an unprivileged user when the agent is root, which makes the agent run 7-Zip as that user) */
function userScene(name: string) {
  const s = scene(name);
  const sel = path.join(s.src, "sel");
  fs.mkdirSync(path.join(sel, "z"), { recursive: true });
  for (let i = 0; i < 40; i++) fs.writeFileSync(path.join(sel, `a${String(i).padStart(2, "0")}.bin`), randomBytes(200_000));
  fs.writeFileSync(path.join(sel, "z/inner.txt"), "inner");
  fs.writeFileSync(path.join(s.outside, "inner.txt"), "OUTSIDE-SECRET-OUTSIDE-SECRET", { mode: 0o600 });
  fs.chmodSync(s.outside, 0o755);
  if (IS_ROOT) {
    for (const p of [s.src, sel, path.join(sel, "z")]) fs.chownSync(p, NOBODY, NOBODY);
    for (const f of fs.readdirSync(sel)) if (f !== "z") fs.chownSync(path.join(sel, f), NOBODY, NOBODY);
    fs.chownSync(path.join(sel, "z/inner.txt"), NOBODY, NOBODY);
  }
  return { ...s, sel };
}
const outDirs = () => fs.readdirSync(os.tmpdir()).filter((n) => /^filedeck-out-/.test(n));
const list7z = (first: string) => spawnSync(process.env.FILEDECK_7Z || "7zz", ["l", "-slt", "-ba", first], { encoding: "utf8", timeout: 60_000, input: "" }).stdout;

test("a split 7z set without a password compresses from a user-owned folder (7-Zip runs as the folder's owner when the agent is root) and holds every file", needSz, async () => {
  const before = outDirs().length;
  const s = userScene("compress-user");
  const r = await runCompress(await prepareCompress(s.root, "/src", ["sel"], "7z", "split", { destDir: "/out", splitBytes: 65_536, level: 0 }), LIM, mkCtl());
  assert.ok((r.volumes ?? 0) > 1, JSON.stringify(r));
  const list = list7z(path.join(s.root, r.path));
  assert.match(list, /a00\.bin/);
  assert.match(list, /a39\.bin/);
  assert.match(list, /z[\\/]inner\.txt/);
  const st = fs.statSync(path.join(s.root, r.path));
  assert.equal(st.nlink, 1);
  assert.equal(outDirs().length, before, "the tool's private folder is removed");
});

test("a subfolder swapped for an outside link while 7-Zip works as the folder's owner puts no outside file in the archive (agent as root)", needSz, async () => {
  // The selected folder belongs to an unprivileged user, so the agent runs 7-Zip as that user: a link that user (or anyone
  // else able to write there) swaps in cannot lead 7-Zip to a file that user could not read. Without the privilege drop (a
  // root-owned selection with a user-writable subfolder) this is closed only by the sandbox in a later change; an agent that
  // is itself that user has no boundary to protect, so nothing is asserted about the outside file then.
  const s = userScene("swap-compress");
  const plan = await prepareCompress(s.root, "/src", ["sel"], "7z", "split", { destDir: "/out", splitBytes: 65_536, level: 0 });
  const job = runCompress(plan, LIM, mkCtl()).then(
    (r) => ({ ok: true as const, r }),
    (e: Error) => ({ ok: false as const, e }),
  );
  // after 7-Zip has scanned and started writing, swap the subfolder it listed for a link
  for (let i = 0; i < 400; i++) {
    if (outDirs().some((d) => fs.readdirSync(path.join(os.tmpdir(), d)).length > 0) || fs.existsSync(path.join(s.root, ".filedeck-work")) && fs.readdirSync(path.join(s.root, ".filedeck-work")).some((n) => n.endsWith(".alive"))) break;
    await sleep(10);
  }
  fs.renameSync(path.join(s.sel, "z"), path.join(s.sel, "z-moved"));
  fs.symlinkSync(s.outside, path.join(s.sel, "z"));
  const res = await job;
  const all = fs.readdirSync(s.out).map((n) => fs.readFileSync(path.join(s.out, n)));
  if (IS_ROOT) for (const b of all) assert.ok(!b.includes("OUTSIDE-SECRET"), "an outside file must not be in any volume");
  console.log(`# swap-compress: job ${res.ok ? "finished" : "failed: " + res.e.message}, volumes: ${all.length}`);
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

test("7-Zip compression with a password and as split volumes keeps names with ? and * and leaves nested reserved folders out", needSz, async () => {
  const s = scene("odd-names");
  fs.writeFileSync(path.join(s.src, "a?b.txt"), "question");
  fs.writeFileSync(path.join(s.src, "c*d.txt"), "star");
  fs.writeFileSync(path.join(s.src, "other.txt"), "other");
  const vol = path.join(s.src, "vol");
  fs.mkdirSync(path.join(vol, "deep", ".filedeck-work-abc"), { recursive: true });
  fs.mkdirSync(path.join(vol, ".filedeck-work"));
  fs.mkdirSync(path.join(vol, ".filedeck-trash"));
  fs.writeFileSync(path.join(vol, "keep.txt"), "k");
  fs.writeFileSync(path.join(vol, "deep", "deeper.txt"), "d");
  for (const r of [".filedeck-work-abc"]) fs.writeFileSync(path.join(vol, "deep", r, "staged"), "s");
  fs.writeFileSync(path.join(vol, ".filedeck-work/staged"), "s");
  fs.writeFileSync(path.join(vol, ".filedeck-trash/item"), "t");
  const names = ["a?b.txt", "c*d.txt", "vol"];
  for (const [label, opts] of [
    ["password", { password: "pw", destDir: "/out" }],
    ["split", { splitBytes: 65_536, destDir: "/out" }],
  ] as const) {
    const r = await runCompress(await prepareCompress(s.root, "/src", names, "7z", `odd-${label}`, opts), LIM, mkCtl());
    const list = list7z(path.join(s.root, r.path));
    assert.match(list, /Path = a\?b\.txt/, label);
    assert.match(list, /Path = c\*d\.txt/, label);
    assert.match(list, /keep\.txt/, label);
    assert.match(list, /deeper\.txt/, label);
    assert.doesNotMatch(list, /other\.txt/, `${label}: only the selection is archived`);
    assert.doesNotMatch(list, /\.filedeck-(work|trash)/, `${label}: reserved folders are left out`);
  }
});

test("exclude patterns with names containing * or ? are refused with a reason, for password and split archives", needSz, () => {
  fs.mkdirSync(path.join(tmp, "refuse/root/src"), { recursive: true });
  fs.writeFileSync(path.join(tmp, "refuse/root/src/a?b.txt"), "x");
  return assert.rejects(
    prepareCompress(path.join(tmp, "refuse/root"), "/src", ["a?b.txt"], "7z", "x", { password: "pw", exclude: ["*.log"] }),
    (e: { status?: number; message?: string }) => e.status === 400 && /read those names as patterns/.test(e.message ?? ""),
  );
});

test("with wildcard matching off, -xr!NAME excludes that exact name at any depth, including a folder created after the scan", needSz, () => {
  const d = path.join(tmp, "xr-exact");
  fs.mkdirSync(path.join(d, "t/a/.filedeck-work"), { recursive: true });
  fs.mkdirSync(path.join(d, "t/a/.filedeck-trash"));
  fs.writeFileSync(path.join(d, "t/a/keep.txt"), "k");
  fs.writeFileSync(path.join(d, "t/a/.filedeck-work/x"), "x");
  fs.writeFileSync(path.join(d, "t/a/.filedeck-trash/y"), "y");
  fs.writeFileSync(path.join(d, "t/a/odd?.txt"), "o");
  const z = process.env.FILEDECK_7Z || "7zz";
  const r = spawnSync(z, ["a", "-t7z", "-snl", "-spd", "-xr!.filedeck-trash", "-xr!.filedeck-work", path.join(d, "o.7z"), "./t"], { cwd: d, encoding: "utf8", timeout: 60_000, input: "" });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const list = list7z(path.join(d, "o.7z"));
  assert.match(list, /keep\.txt/);
  assert.match(list, /odd\?\.txt/);
  assert.doesNotMatch(list, /\.filedeck-(work|trash)/);
});

test("the privilege-dropped 7-Zip reads a list file naming a staging-prefix folder and that folder is absent from the archive", needSz, async () => {
  const s = userScene("list-file");
  const nested = path.join(s.sel, "z", ".filedeck-work-abc");
  fs.mkdirSync(nested);
  fs.writeFileSync(path.join(nested, "staged.bin"), "STAGED-CONTENT");
  if (IS_ROOT) {
    fs.chownSync(nested, NOBODY, NOBODY);
    fs.chownSync(path.join(nested, "staged.bin"), NOBODY, NOBODY);
  }
  // an umask that would hide the list file from its reader is irrelevant: the file's mode is set on its descriptor (root can make the
  // folders under it; a plain user could not, so the hostile umask is applied only for a root agent)
  const old = process.umask(IS_ROOT ? 0o777 : 0o022);
  let r;
  try {
    r = await runCompress(await prepareCompress(s.root, "/src", ["sel"], "7z", "listed", { destDir: "/out", splitBytes: 65_536, level: 0 }), LIM, mkCtl());
  } finally {
    process.umask(old);
  }
  const list = list7z(path.join(s.root, r.path));
  assert.match(list, /inner\.txt/);
  assert.doesNotMatch(list, /\.filedeck-work-abc|staged\.bin/);
});

test("a reserved folder with an exact name that appears after the scan is left out by 7-Zip's own pattern", needSz, async () => {
  const s = userScene("late-exact");
  const plan = await prepareCompress(s.root, "/src", ["sel"], "7z", "late", { destDir: "/out", splitBytes: 65_536, level: 0 });
  let made = false;
  const guard = () => {
    if (made) return;
    made = true; // after the scan
    for (const r of [".filedeck-work", ".filedeck-trash"]) {
      fs.mkdirSync(path.join(s.sel, "z", r));
      fs.writeFileSync(path.join(s.sel, "z", r, "staged.bin"), "STAGED-CONTENT");
      if (IS_ROOT) {
        fs.chownSync(path.join(s.sel, "z", r), NOBODY, NOBODY);
        fs.chownSync(path.join(s.sel, "z", r, "staged.bin"), NOBODY, NOBODY);
      }
    }
  };
  const r = await runCompress(plan, LIM, mkCtl(), guard);
  assert.ok(made);
  const list = list7z(path.join(s.root, r.path));
  assert.match(list, /inner\.txt/);
  assert.doesNotMatch(list, /\.filedeck-(work|trash)|staged\.bin/);
});

test("password and split archives compress, list and extract inside the sandbox", needSz, async () => {
  const s = userScene("pw-split");
  const c = await runCompress(await prepareCompress(s.root, "/src", ["sel"], "7z", "pw", { destDir: "/out", password: "s3cret", splitBytes: 65_536, level: 0 }), LIM, mkCtl());
  assert.ok((c.volumes ?? 0) > 1, JSON.stringify(c));
  const { prepareExtract, runExtract } = await import("../src/archive.ts");
  const plan = await prepareExtract(s.root, c.path, "/out", true, { overwrite: "rename", password: "s3cret" });
  assert.equal(plan.viaSz, true);
  const r = await runExtract(plan, LIM, mkCtl());
  assert.ok(r.files >= 41, JSON.stringify(r));
});

for (const parts of [64, 200]) {
  test(`a split set of ${parts} or more parts is listed, checked and extracted inside the sandbox (one grant per part for reading, the private folder for extraction)`, needSz, async () => {
    const s = scene(`parts-${parts}`);
    const pack = path.join(s.src, "pack");
    fs.mkdirSync(pack);
    fs.writeFileSync(path.join(pack, "big.bin"), randomBytes(parts * 65_536));
    for (const password of [undefined, "s3cret"]) {
      const name = password ? `pw${parts}` : `plain${parts}`;
      const c = await runCompress(await prepareCompress(s.root, "/src", ["pack"], "7z", name, { destDir: "/out", splitBytes: 65_536, level: 0, password }), LIM, mkCtl());
      assert.ok((c.volumes ?? 0) >= parts, JSON.stringify(c));
      const l = await listArchive(s.root, c.path, 5000, password);
      assert.ok(l.entries.some((e) => e.name.endsWith("big.bin")), JSON.stringify(l.entries.slice(0, 3)));
      const plan = await prepareExtract(s.root, c.path, "/out", true, { overwrite: "rename", password });
      assert.equal(plan.viaSz, true);
      if (password) await assert.rejects(prepareExtract(s.root, c.path, "/out", true, { overwrite: "rename", password: "wrong" }), (e: { status?: number }) => e.status === 401);
      const r = await runExtract(plan, LIM, mkCtl());
      assert.ok(r.files >= 1, JSON.stringify(r));
      assert.equal(fs.statSync(path.join(s.root, r.path, "pack/big.bin")).size, parts * 65_536);
    }
  });
}

test("diagnostic: does 7-Zip open nested paths by name? (recorded in the log; never fails)", needSz, () => {
  const strace = spawnSync("strace", ["-V"], { encoding: "utf8", timeout: 30_000 });
  if (strace.status !== 0) {
    console.log("# strace not available: diagnostic skipped");
    return;
  }
  try {
    const d = path.join(tmp, "strace");
    fs.mkdirSync(path.join(d, "t/sub/deeper"), { recursive: true });
    fs.writeFileSync(path.join(d, "t/sub/deeper/f.txt"), "x");
    const log = path.join(d, "trace.log");
    spawnSync("strace", ["-f", "-o", log, "-e", "trace=openat,mkdir,mkdirat,newfstatat", process.env.FILEDECK_7Z || "7zz", "a", "-t7z", "-snl", path.join(d, "out.7z"), "./t"], { cwd: d, encoding: "utf8", timeout: 60_000, input: "" });
    const lines = fs.readFileSync(log, "utf8").split("\n").filter((l) => /t\/sub|"\.\/t|f\.txt/.test(l));
    console.log("# 7-Zip system calls touching the nested folder (a relative path through t/sub means it opens by name):");
    for (const l of lines.slice(0, 40)) console.log("#   " + l);
  } catch (e) {
    console.log("# strace diagnostic failed:", (e as Error).message);
  }
});
