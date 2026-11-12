import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { randomBytes } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createAgent } from "../src/agent.ts";
import { loadConfig } from "../src/config.ts";
import { haveSevenZip, runSz, szReadArgs } from "../src/sevenzip.ts";
import { GRANT_LIMIT, MAX_SELECTED, archiveUser, grantHooks, zipLimits, listArchive, outputBounds, prepareCompress, prepareExtract, runCompress, runExtract, selectionGrants, spawnBsdtar, zipStream } from "../src/archive.ts";
import { resetSandbox, sandboxInfo, spawnSandboxed } from "../src/sandbox.ts";
import type { JobCtl } from "../src/jobs.ts";
import { ToolGate, toolGate } from "../src/tool-gate.ts";
import { useSandbox } from "./sandbox-env.ts";

/**
 * The archive tools (bsdtar, 7-Zip) run inside the Landlock sandbox: what they can read and write is limited by the kernel to
 * the pinned folders of the job, whoever owns the tree and whatever is swapped while they run. These tests use the real launcher
 * and the real tools (the 7-Zip ones skip without `7zz`, which CI has). `FILEDECK_REQUIRE_SANDBOX=1` (CI, the image build) turns
 * "Landlock is not usable here" into a failure instead of a skip.
 */
const HAVE_BSDTAR = spawnSync("bsdtar", ["--version"], { timeout: 30_000 }).status === 0;
const needTool = { skip: HAVE_BSDTAR ? false : "bsdtar not installed" };
const IS_ROOT = process.getuid?.() === 0;
const NOBODY = 65534;
const ROOT_ONLY = IS_ROOT ? false : "sandbox live: skipped (not running as root)";

let tmp: string;
let box: Awaited<ReturnType<typeof useSandbox>>;
before(async () => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "fd-archsb-")));
  fs.chmodSync(tmp, 0o755);
  box = await useSandbox();
  process.env.FILEDECK_WORK_DIR = path.join(tmp, "workdir");
  fs.mkdirSync(process.env.FILEDECK_WORK_DIR, { mode: 0o700 });
});
after(() => {
  delete process.env.FILEDECK_WORK_DIR;
  delete process.env.FILEDECK_SANDBOX;
  delete process.env.FILEDECK_SANDBOX_HELPER;
  resetSandbox();
  fs.rmSync(box.dir, { recursive: true, force: true });
  fs.rmSync(tmp, { recursive: true, force: true });
});

const live = (name: string, fn: () => Promise<void>, opts: { skip?: string | false } = {}) =>
  test(name, { ...needTool, ...(opts.skip ? { skip: opts.skip } : {}), timeout: 120_000 }, async (t) => {
    if (box.state !== "landlock") return t.skip(`sandbox live: skipped (${box.why})`);
    await fn();
  });

const mkCtl = (): JobCtl => ({ signal: new AbortController().signal, progress: { bytes: 0, totalBytes: 0, entries: 0, totalEntries: 0, current: "" } }) as unknown as JobCtl;
const LIM = { maxEntries: 100_000, maxBytes: 1 << 30 };
function scene(name: string) {
  const dir = path.join(tmp, name);
  const root = path.join(dir, "root");
  const outside = path.join(dir, "outside");
  fs.mkdirSync(path.join(root, "out"), { recursive: true });
  fs.mkdirSync(path.join(root, "src"));
  fs.mkdirSync(outside);
  fs.chmodSync(dir, 0o755);
  fs.chmodSync(root, 0o755);
  fs.writeFileSync(path.join(outside, "secret.txt"), "OUTSIDE-SECRET-OUTSIDE-SECRET", { mode: 0o644 });
  fs.chmodSync(outside, 0o755);
  return { dir, root, src: path.join(root, "src"), out: path.join(root, "out"), outside };
}
const listTar = (f: string) => spawnSync("bsdtar", ["-tf", f], { encoding: "utf8", timeout: 60_000 }).stdout.split("\n").filter(Boolean);
const contentOf = (f: string) => spawnSync("bsdtar", ["-xOf", f], { timeout: 60_000, maxBuffer: 1 << 28 }).stdout.toString("latin1");

live("the sandbox is on: Landlock is the state in this run", async () => {
  assert.equal((await sandboxInfo()).state, "landlock");
});

/* ---- the first case: a user-writable subfolder swapped for a link to an outside folder ---- */

live("a link-following tool given the production grants cannot read through a subfolder swapped for a link to an outside folder", async () => {
  const s = scene("swap-grants");
  fs.mkdirSync(path.join(s.src, "sel/z"), { recursive: true });
  fs.writeFileSync(path.join(s.src, "sel/z/inner.txt"), "inner");
  fs.writeFileSync(path.join(s.src, "sel/keep.txt"), "keep");
  const fd = fs.openSync(s.src, "r");
  try {
    const grants = await selectionGrants(s.src, fd, ["sel"]);
    // the swap, after the grants were taken (the folder is held by descriptor from here on)
    fs.renameSync(path.join(s.src, "sel/z"), path.join(s.src, "sel/z-moved"));
    fs.symlinkSync(s.outside, path.join(s.src, "sel/z"));
    const run = async (confined: boolean) => {
      const args = ["--null", "-L", "-cf", "-", "-T", "-"]; // -L: follow links, as a tool that opens a swapped folder would
      const child = confined ? await spawnSandboxed("bsdtar", args, { cwd: s.src, readOnly: grants.roots, stdio: ["pipe", "pipe", "pipe"] }) : spawn("bsdtar", args, { cwd: s.src, stdio: ["pipe", "pipe", "pipe"] });
      const out: Buffer[] = [];
      child.stdout!.on("data", (d) => out.push(d));
      child.stdin!.end("sel\0");
      await new Promise((r) => child.on("close", r));
      return Buffer.concat(out).toString("latin1");
    };
    assert.match(await run(false), /OUTSIDE-SECRET/, "control: without the sandbox the link is followed");
    const confined = await run(true);
    assert.doesNotMatch(confined, /OUTSIDE-SECRET/, "inside the sandbox the outside folder cannot be opened");
    assert.match(confined, /keep\.txt/);
    await grants.close();
  } finally {
    fs.closeSync(fd);
  }
});

live("a compression whose subfolder is swapped for an outside link after the scan puts no outside file in the archive", async () => {
  const s = scene("swap-job");
  fs.mkdirSync(path.join(s.src, "sel/z"), { recursive: true });
  fs.writeFileSync(path.join(s.src, "sel/z/inner.txt"), "inner");
  fs.writeFileSync(path.join(s.src, "sel/keep.txt"), "keep");
  if (IS_ROOT) fs.chownSync(path.join(s.src, "sel/z"), NOBODY, NOBODY); // a root-owned selection holding a user-writable subfolder
  const plan = await prepareCompress(s.root, "/src", ["sel"], "tar.gz", "swap", { destDir: "/out" });
  let swapped = false;
  const guard = () => {
    if (swapped) return;
    swapped = true; // called after the scan, before the tool starts
    fs.renameSync(path.join(s.src, "sel/z"), path.join(s.src, "sel/z-moved"));
    fs.symlinkSync(s.outside, path.join(s.src, "sel/z"));
  };
  const r = await runCompress(plan, LIM, mkCtl(), guard);
  assert.ok(swapped);
  const archive = path.join(s.root, r.path);
  assert.ok(!contentOf(archive).includes("OUTSIDE-SECRET"));
  assert.ok(listTar(archive).some((n) => n.endsWith("keep.txt")));
});

/* ---- the second case: another user's subfolder inside the selection ---- */

live(
  "another user's private subfolder inside a user's selection is not archived (the tool runs as the selection's owner)",
  async () => {
    const s = scene("other-user");
    for (const d of [s.dir, s.root, s.src]) fs.chmodSync(d, 0o755);
    fs.mkdirSync(path.join(s.src, "sel/theirs"), { recursive: true });
    fs.writeFileSync(path.join(s.src, "sel/mine.txt"), "mine");
    fs.writeFileSync(path.join(s.src, "sel/theirs/private.txt"), "OTHER-USERS-SECRET");
    fs.chmodSync(path.join(s.src, "sel/theirs"), 0o700);
    fs.chownSync(path.join(s.src, "sel"), NOBODY, NOBODY);
    fs.chownSync(path.join(s.src, "sel/mine.txt"), NOBODY, NOBODY);
    fs.chownSync(path.join(s.src, "sel/theirs"), 4242, 4242);
    fs.chownSync(path.join(s.src, "sel/theirs/private.txt"), 4242, 4242);
    fs.chownSync(s.src, NOBODY, NOBODY);
    fs.chownSync(s.out, NOBODY, NOBODY);
    const plan = await prepareCompress(s.root, "/src", ["sel"], "tar.gz", "other", { destDir: "/out" });
    const r = await runCompress(plan, LIM, mkCtl()).catch((e) => e as Error); // the tool may fail on the folder it cannot read
    if (!(r instanceof Error)) assert.ok(!contentOf(path.join(s.root, r.path)).includes("OTHER-USERS-SECRET"));
    assert.deepEqual(fs.readdirSync(s.out).filter((n) => !n.startsWith(".")).flatMap((n) => (contentOf(path.join(s.out, n)).includes("OTHER-USERS-SECRET") ? [n] : [])), []);
  },
  { skip: ROOT_ONLY },
);

/* ---- the third case: reserved folders created or renamed after the scan ---- */

live("reserved folders that appear in the selection after the scan are left out of a bsdtar archive (exclude patterns); the choice for 7-Zip is in the README", async () => {
  const s = scene("late-reserved");
  fs.mkdirSync(path.join(s.src, "sel/deep"), { recursive: true });
  fs.writeFileSync(path.join(s.src, "sel/keep.txt"), "keep");
  fs.writeFileSync(path.join(s.src, "sel/deep/deeper.txt"), "deeper");
  const plan = await prepareCompress(s.root, "/src", ["sel"], "tar.gz", "late", { destDir: "/out" });
  let made = false;
  const guard = () => {
    if (made) return;
    made = true; // after the scan: none of these was seen by it
    for (const r of [".filedeck-trash", ".filedeck-work", ".filedeck-work-late-1"]) {
      fs.mkdirSync(path.join(s.src, "sel/deep", r));
      fs.writeFileSync(path.join(s.src, "sel/deep", r, "staged.bin"), "STAGED-CONTENT");
    }
  };
  const r = await runCompress(plan, LIM, mkCtl(), guard);
  assert.ok(made);
  const names = listTar(path.join(s.root, r.path));
  assert.ok(names.some((n) => n.endsWith("deeper.txt")), names.join(","));
  assert.deepEqual(names.filter((n) => n.includes(".filedeck-")), []);
  assert.ok(!contentOf(path.join(s.root, r.path)).includes("STAGED-CONTENT"));
});

/* ---- the fourth case: the zip download's working folder, resolved by name before, is now pinned ---- */

live("a zip download whose folder is swapped for an outside link right after it was pinned still streams the original folder", async () => {
  const s = scene("zip-swap");
  fs.mkdirSync(path.join(s.src, "pack"));
  fs.writeFileSync(path.join(s.src, "pack/own.txt"), "own");
  fs.writeFileSync(path.join(s.src, "own.txt"), "own");
  fs.writeFileSync(path.join(s.outside, "outside-only.txt"), "OUTSIDE-ONLY");
  const swapped = path.join(s.root, "src-moved");
  const zip = path.join(s.dir, "dl.zip");
  await new Promise<void>((resolve, reject) => {
    const z = zipStream(s.src, ["own.txt", "pack"], new AbortController().signal, {
      root: s.root,
      afterPin: () => {
        fs.renameSync(s.src, swapped);
        fs.symlinkSync(s.outside, s.src);
      },
    });
    const out = fs.createWriteStream(zip);
    z.on("error", reject);
    out.on("close", () => resolve());
    z.pipe(out);
  });
  const names = listTar(zip);
  assert.ok(names.includes("own.txt") && names.some((n) => n.endsWith("pack/own.txt")), names.join(","));
  assert.ok(!names.some((n) => n.includes("outside-only")));
});

/* ---- extraction and listing are granted nothing beneath the served root ---- */

live("bsdtar given an archive on standard input and no folders cannot open any file below the served root", async () => {
  const s = scene("extract-grants");
  fs.writeFileSync(path.join(s.src, "a.txt"), "ROOT-FILE-CONTENT");
  const child = await spawnSandboxed("bsdtar", ["-cf", "-", path.join(s.src, "a.txt")], { stdio: ["ignore", "pipe", "pipe"] });
  const out: Buffer[] = [];
  child.stdout!.on("data", (d) => out.push(d));
  const code = await new Promise<number | null>((r) => child.on("close", r));
  assert.notEqual(code, 0, "reading a served file is refused by the kernel");
  assert.ok(!Buffer.concat(out).toString("latin1").includes("ROOT-FILE-CONTENT"));
});

/* ---- ordinary jobs, every format, inside the sandbox ---- */

for (const [format, ext] of [["zip", ".zip"], ["tar.gz", ".tar.gz"], ["tar.zst", ".tar.zst"], ["tar.xz", ".tar.xz"], ["7z", ".7z"]] as const) {
  live(`ordinary jobs in the sandbox: ${format} compress, list, extract with each overwrite policy`, async () => {
    if (format === "7z" && !haveSevenZip()) return; // the 7z writer is 7-Zip's; a machine without it has no such archive
    const s = scene(`ordinary-${format}`);
    fs.mkdirSync(path.join(s.src, "pack/sub"), { recursive: true });
    fs.writeFileSync(path.join(s.src, "pack/a.txt"), "alpha");
    fs.writeFileSync(path.join(s.src, "pack/sub/b.txt"), "bravo");
    const c = await runCompress(await prepareCompress(s.root, "/src", ["pack"], format, "ord", { destDir: "/out", level: 3 }), LIM, mkCtl());
    assert.equal(c.path, `/out/ord${ext}`);
    const l = await listArchive(s.root, c.path);
    assert.ok(l.entries.some((e) => e.name.endsWith("a.txt")), JSON.stringify(l.entries));
    for (const policy of ["rename", "overwrite", "skip"] as const) {
      const dest = path.join(s.root, `x-${policy}`);
      fs.mkdirSync(dest);
      for (let i = 0; i < 2; i++) {
        const r = await runExtract(await prepareExtract(s.root, c.path, `/x-${policy}`, true, { overwrite: policy }), LIM, mkCtl());
        assert.ok(r.files >= 2, `${policy} round ${i}: ${JSON.stringify(r)}`);
      }
      const folders = fs.readdirSync(dest).sort();
      assert.deepEqual(folders, policy === "rename" ? ["ord", "ord (2)"] : ["ord"], policy);
      assert.equal(fs.readFileSync(path.join(dest, "ord/pack/sub/b.txt"), "utf8"), "bravo");
    }
  });
}

live("ordinary jobs in the sandbox: a zip download streams a valid zip of a selection", async () => {
  const s = scene("ordinary-zipdl");
  fs.mkdirSync(path.join(s.src, "d"));
  fs.writeFileSync(path.join(s.src, "d/in.txt"), "in");
  fs.writeFileSync(path.join(s.src, "top.txt"), "top");
  const zip = path.join(s.dir, "dl.zip");
  await new Promise<void>((resolve, reject) => {
    const z = zipStream(s.src, ["top.txt", "d"], new AbortController().signal, { root: s.root });
    const out = fs.createWriteStream(zip);
    z.on("error", reject);
    out.on("close", () => resolve());
    z.pipe(out);
  });
  assert.deepEqual(listTar(zip).sort(), ["d/", "d/in.txt", "top.txt"]);
});

live("ordinary jobs in the sandbox: a selection longer than the per-entry grants is given as the pinned folder and compresses", async () => {
  const s = scene("many");
  const names: string[] = [];
  for (let i = 0; i < 60; i++) {
    names.push(`f${i}.txt`);
    fs.writeFileSync(path.join(s.src, `f${i}.txt`), `n${i}`);
  }
  const c = await runCompress(await prepareCompress(s.root, "/src", names, "tar.gz", "many", { destDir: "/out" }), LIM, mkCtl());
  assert.equal(listTar(path.join(s.root, c.path)).length, 60);
});

live("a selected symlink is stored as the link and needs no grant", async () => {
  const s = scene("link-selected");
  fs.writeFileSync(path.join(s.src, "real.txt"), "real");
  fs.symlinkSync(s.outside, path.join(s.src, "lnk"));
  const c = await runCompress(await prepareCompress(s.root, "/src", ["real.txt", "lnk"], "tar.gz", "lk", { destDir: "/out" }), LIM, mkCtl());
  const names = listTar(path.join(s.root, c.path));
  assert.deepEqual(names.sort(), ["lnk", "real.txt"]);
  assert.ok(!contentOf(path.join(s.root, c.path)).includes("OUTSIDE-SECRET"));
});

/* ---- when the sandbox is required and missing, every archive feature answers the same 503 ---- */

test("with the sandbox required and Landlock missing every archive feature answers 503; in auto the tools still run", needTool, async () => {
  const s = scene("required");
  fs.writeFileSync(path.join(s.src, "f.txt"), "f");
  const prev = [process.env.FILEDECK_SANDBOX, process.env.FILEDECK_SANDBOX_HELPER];
  try {
    process.env.FILEDECK_SANDBOX_HELPER = path.join(tmp, "no-such-launcher");
    process.env.FILEDECK_SANDBOX = "require";
    resetSandbox();
    const status = (e: unknown) => (e as { status?: number }).status;
    await assert.rejects(prepareCompress(s.root, "/src", ["f.txt"], "tar.gz", "r", { destDir: "/out" }), (e) => status(e) === 503);
    await assert.rejects(listArchive(s.root, "/src/f.txt"), (e) => status(e) === 503);
    await assert.rejects(prepareExtract(s.root, "/src/f.txt", "/out", false), (e) => status(e) === 503);
    const app = createAgent(loadConfig({ FILEDECK_ROOT: s.root, FILEDECK_NODE: "t" } as never));
    for (const [method, url, body] of [
      ["GET", "/api/fs/zip?dir=/src&name=f.txt", undefined],
      ["GET", "/api/archive/list?path=/src/f.txt", undefined],
      ["POST", "/api/jobs/compress", { dir: "/src", names: ["f.txt"], format: "zip", name: "r" }],
      ["POST", "/api/jobs/extract", { path: "/src/f.txt", destDir: "/out" }],
    ] as const) {
      const r = await app.request(url, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
      assert.equal(r.status, 503, `${method} ${url}`);
    }
    await (app as unknown as { close(): Promise<void> }).close();
    // development start: the helper is missing but the sandbox is only "auto": the tools run, with today's checks
    process.env.FILEDECK_SANDBOX = "auto";
    resetSandbox();
    assert.equal((await sandboxInfo()).state, "fallback");
    const r = await runCompress(await prepareCompress(s.root, "/src", ["f.txt"], "tar.gz", "r", { destDir: "/out" }), LIM, mkCtl());
    assert.deepEqual(listTar(path.join(s.root, r.path)), ["f.txt"]);
    const x = await runExtract(await prepareExtract(s.root, r.path, "/src", true, { overwrite: "overwrite" }), LIM, mkCtl());
    assert.equal(x.files, 1);
  } finally {
    for (const [i, k] of ["FILEDECK_SANDBOX", "FILEDECK_SANDBOX_HELPER"].entries()) {
      if (prev[i] === undefined) delete process.env[k];
      else process.env[k] = prev[i];
    }
    resetSandbox();
  }
});

/* ---- the size bound follows the real names ---- */

test("the output bound grows with the names: a zip whose names average 900 bytes is not falsely refused", () => {
  const entries = 3000;
  const nameBytes = entries * 900;
  const totalBytes = entries * 10;
  // what such a zip really holds beyond the data: each name twice (local header and central directory) plus about 100 bytes per entry
  const realistic = totalBytes + entries * (2 * 900 + 100);
  const { setMax } = outputBounds({ totalBytes, entries, nameBytes, maxBytes: 2 ** 40 });
  assert.ok(setMax >= realistic, `${setMax} < ${realistic}`);
  const oldBound = totalBytes + Math.ceil(totalBytes / 8) + 1024 * 1024 + entries * 1024;
  assert.ok(oldBound < realistic, "the old per-entry margin was too small for such names");
  // the configured limit and a volume size still cap it
  assert.equal(outputBounds({ totalBytes, entries, nameBytes, maxBytes: 5000 }).setMax, 5000);
  assert.equal(outputBounds({ totalBytes, entries, nameBytes, maxBytes: 2 ** 40, splitBytes: 65536 }).partMax, 65536);
});

/* ---- the working folder is exact: many selected folders, a pinned folder on a low descriptor number ---- */

live("a zip download of 45 folders holds every folder's own content (the working folder is given by descriptor)", async () => {
  const s = scene("zip45");
  const names: string[] = [];
  for (let i = 0; i < 45; i++) {
    names.push(`d${i}`);
    fs.mkdirSync(path.join(s.src, `d${i}`, `sub${i}`), { recursive: true });
    fs.writeFileSync(path.join(s.src, `d${i}`, "x"), `x${i}`);
  }
  const zip = path.join(s.dir, "dl.zip");
  await new Promise<void>((resolve, reject) => {
    const z = zipStream(s.src, names, new AbortController().signal, { root: s.root });
    const out = fs.createWriteStream(zip);
    z.on("error", reject);
    out.on("close", () => resolve());
    z.pipe(out);
  });
  const got = listTar(zip);
  for (let i = 0; i < 45; i++) assert.ok(got.includes(`d${i}/x`) && got.includes(`d${i}/sub${i}/`), `d${i} missing: ${got.length} entries`);
  assert.equal(spawnSync("bsdtar", ["-xOf", zip, "d44/x"], { encoding: "utf8" }).stdout, "x44");
});

live("a compression of 45 folders holds every folder's own content", async () => {
  const s = scene("comp45");
  const names: string[] = [];
  for (let i = 0; i < 45; i++) {
    names.push(`d${i}`);
    fs.mkdirSync(path.join(s.src, `d${i}`));
    fs.writeFileSync(path.join(s.src, `d${i}`, "x"), `x${i}`);
  }
  const r = await runCompress(await prepareCompress(s.root, "/src", names, "tar.gz", "c45", { destDir: "/out" }), LIM, mkCtl());
  const got = listTar(path.join(s.root, r.path));
  for (let i = 0; i < 45; i++) assert.ok(got.includes(`d${i}/x`), `d${i} missing`);
  assert.equal(spawnSync("bsdtar", ["-xOf", path.join(s.root, r.path), "d7/x"], { encoding: "utf8" }).stdout, "x7");
});

/* ---- every selected entry on its own: no read of a FIFO or a device, no limit of 48 ---- */

live("a FIFO in the selection is not opened for reading (it would block) and is stored as a node", async () => {
  const s = scene("fifo-sel");
  fs.writeFileSync(path.join(s.src, "a.txt"), "a");
  assert.equal(spawnSync("mkfifo", [path.join(s.src, "pipe")], { timeout: 30_000 }).status, 0);
  const t = Date.now();
  const r = await runCompress(await prepareCompress(s.root, "/src", ["a.txt", "pipe"], "tar.gz", "fifo", { destDir: "/out" }), LIM, mkCtl());
  assert.ok(Date.now() - t < 20_000, "no wait on the pipe");
  assert.deepEqual(listTar(path.join(s.root, r.path)).sort(), ["a.txt", "pipe"]);
  const zip = path.join(s.dir, "f.zip");
  await new Promise<void>((resolve, reject) => {
    const z = zipStream(s.src, ["a.txt", "pipe"], new AbortController().signal, { root: s.root });
    const out = fs.createWriteStream(zip);
    z.on("error", reject);
    out.on("close", () => resolve());
    z.pipe(out);
  });
  assert.ok(listTar(zip).includes("a.txt"));
});

live(
  "a device node in the selection is not opened (root)",
  async () => {
    const s = scene("dev-sel");
    fs.writeFileSync(path.join(s.src, "a.txt"), "a");
    const mk = spawnSync("mknod", [path.join(s.src, "null-node"), "c", "1", "3"], { timeout: 30_000 });
    if (mk.status !== 0) return; // this container cannot make device nodes (it also could not have one in a selection)
    const r = await runCompress(await prepareCompress(s.root, "/src", ["a.txt", "null-node"], "tar.gz", "dev", { destDir: "/out" }), LIM, mkCtl());
    assert.ok(listTar(path.join(s.root, r.path)).includes("a.txt"));
  },
  { skip: ROOT_ONLY },
);

live("a selection of 600 files compresses and each is granted on its own; more than the limit is refused clearly", async () => {
  const s = scene("sel600");
  const names: string[] = [];
  for (let i = 0; i < 600; i++) {
    names.push(`f${i}.txt`);
    fs.writeFileSync(path.join(s.src, `f${i}.txt`), `n${i}`);
  }
  fs.writeFileSync(path.join(s.src, "sibling.txt"), "NOT-SELECTED");
  const r = await runCompress(await prepareCompress(s.root, "/src", names, "tar.gz", "m600", { destDir: "/out" }), LIM, mkCtl());
  const got = listTar(path.join(s.root, r.path));
  assert.equal(got.length, 600);
  assert.ok(!got.includes("sibling.txt"));
  const many = Array.from({ length: MAX_SELECTED + 1 }, (_, i) => `x${i}`);
  await assert.rejects(prepareCompress(s.root, "/src", many, "tar.gz", "m", { destDir: "/out" }), (e: { status?: number; message?: string }) => e.status === 400 && /select between 1 and 10000 items/.test(e.message ?? ""));
});

/* ---- one test per tool and operation: a path outside its grants is refused under Landlock and works without it ---- */

/** run `fn` under the sandbox (it must report "denied") and again with the sandbox off (it must work) */
async function sandboxedAndNot(name: string, fn: () => Promise<{ denied: boolean; detail: string }>) {
  const inBox = await fn();
  assert.ok(inBox.denied, `${name}: under Landlock this must be refused: ${inBox.detail}`);
  const prev = process.env.FILEDECK_SANDBOX;
  process.env.FILEDECK_SANDBOX = "off";
  resetSandbox();
  try {
    const free = await fn();
    assert.ok(!free.denied, `${name}: without the sandbox this works (so the refusal above is the sandbox's): ${free.detail}`);
  } finally {
    if (prev === undefined) delete process.env.FILEDECK_SANDBOX;
    else process.env.FILEDECK_SANDBOX = prev;
    resetSandbox();
  }
}
async function finish(child: import("node:child_process").ChildProcess): Promise<{ code: number | null; out: Buffer; err: string }> {
  const out: Buffer[] = [];
  let err = "";
  child.stdout?.on("data", (d) => out.push(d));
  child.stderr?.on("data", (d) => (err += d));
  const code = await new Promise<number | null>((r) => child.on("close", r));
  return { code, out: Buffer.concat(out), err };
}
const deniedWith = (r: { code: number | null; err: string }) => r.code !== 0 && r.err.length > 0;

function opScene(name: string) {
  const s = scene(name);
  fs.writeFileSync(path.join(s.src, "own.txt"), "own");
  fs.writeFileSync(path.join(s.src, "sibling.txt"), "SIBLING-SECRET");
  fs.writeFileSync(path.join(s.outside, "outside.tar"), spawnSync("bsdtar", ["-cf", "-", "-C", s.src, "sibling.txt"], { timeout: 30_000, maxBuffer: 1 << 24 }).stdout);
  fs.writeFileSync(path.join(s.src, "own.tar"), spawnSync("bsdtar", ["-cf", "-", "-C", s.src, "own.txt"], { timeout: 30_000, maxBuffer: 1 << 24 }).stdout);
  return s;
}

live("bsdtar list is told to read an archive outside its grants: refused under Landlock, listed without it", async () => {
  const s = opScene("op-list");
  const fd = fs.openSync(path.join(s.src, "own.tar"), "r"); // the archive it was handed, as streamList hands it
  try {
    await sandboxedAndNot("bsdtar list", async () => {
      const r = await finish(await spawnBsdtar(["-tvf", path.join(s.outside, "outside.tar")], { stdin: fd, readOnly: [] }));
      return { denied: deniedWith(r), detail: `${r.code} ${r.err}` };
    });
  } finally {
    fs.closeSync(fd);
  }
});

live("bsdtar extract is told (by a hostile archive's @ member) to read a file outside its grants: refused under Landlock", async () => {
  const s = opScene("op-extract");
  // the archive it extracts names another archive to include; the extraction command is the production one plus that argument
  const fd = fs.openSync(path.join(s.src, "own.tar"), "r");
  try {
    await sandboxedAndNot("bsdtar extract", async () => {
      const r = await finish(await spawnBsdtar(["--format=pax", "-cf", "-", "@-", `@${path.join(s.outside, "outside.tar")}`], { stdin: fd }));
      return { denied: deniedWith(r), detail: `${r.code} ${r.err}` };
    });
  } finally {
    fs.closeSync(fd);
  }
});

live("bsdtar compress is told to read a sibling that was not selected, and to write outside its scratch folder: refused under Landlock", async () => {
  const s = opScene("op-compress");
  const srcFd = fs.openSync(s.src, "r");
  const scratchDir = path.join(s.dir, "scratch");
  fs.mkdirSync(scratchDir);
  const scratchFd = fs.openSync(scratchDir, "r");
  try {
    const grants = await selectionGrants(s.src, srcFd, ["own.txt"]);
    await sandboxedAndNot("bsdtar compress (read)", async () => {
      const child = await spawnBsdtar(["--null", "-cf", "-", "-T", "-"], { cwdFd: srcFd, stdin: "pipe", readOnly: grants.roots, scratch: { fd: scratchFd, dir: scratchDir } });
      child.stdin!.end("own.txt\0sibling.txt\0");
      const r = await finish(child);
      return { denied: deniedWith(r) && !r.out.includes("SIBLING-SECRET"), detail: `${r.code} ${r.err}` };
    });
    await sandboxedAndNot("bsdtar compress (write)", async () => {
      const target = path.join(s.outside, `w-${Date.now()}-${Math.random()}.tar`);
      const child = await spawnBsdtar(["--null", "-cf", target, "-T", "-"], { cwdFd: srcFd, stdin: "pipe", readOnly: grants.roots, scratch: { fd: scratchFd, dir: scratchDir } });
      child.stdin!.end("own.txt\0");
      const r = await finish(child);
      return { denied: deniedWith(r) && !fs.existsSync(target), detail: `${r.code} ${r.err}` };
    });
    await grants.close();
  } finally {
    fs.closeSync(srcFd);
    fs.closeSync(scratchFd);
  }
});

live("the zip tool is told to read a sibling that was not selected: refused under Landlock", async () => {
  const s = opScene("op-zip");
  const srcFd = fs.openSync(s.src, "r");
  try {
    const grants = await selectionGrants(s.src, srcFd, ["own.txt"]);
    await sandboxedAndNot("zip", async () => {
      const child = await spawnBsdtar(["--null", "--format", "zip", "-cf", "-", "-T", "-"], { cwdFd: srcFd, stdin: "pipe", readOnly: grants.roots });
      child.stdin!.end("own.txt\0sibling.txt\0");
      const r = await finish(child);
      return { denied: deniedWith(r) && !r.out.includes("SIBLING-SECRET"), detail: `${r.code} ${r.err}` };
    });
    await grants.close();
  } finally {
    fs.closeSync(srcFd);
  }
});

/* ---- the same for 7-Zip (CI: needs 7zz) ---- */

const needSz = { skip: HAVE_BSDTAR && haveSevenZip() ? false : "7-Zip (7zz) or bsdtar not installed" };
const liveSz = (name: string, fn: () => Promise<void>) =>
  test(name, { ...needSz, timeout: 120_000 }, async (t) => {
    if (box.state !== "landlock") return t.skip(`sandbox live: skipped (${box.why})`);
    await fn();
  });
const sz = process.env.FILEDECK_7Z || "7zz";

liveSz("7-Zip list is told to read an archive outside its grants: refused under Landlock, listed without it", async () => {
  const s = opScene("op-sz-list");
  const archive = path.join(s.outside, "o.7z");
  assert.equal(spawnSync(sz, ["a", "-t7z", archive, path.join(s.src, "sibling.txt")], { timeout: 60_000, input: "" }).status, 0);
  const mine = path.join(s.src, "own.7z");
  assert.equal(spawnSync(sz, ["a", "-t7z", mine, path.join(s.src, "own.txt")], { timeout: 60_000, input: "" }).status, 0);
  const fd = fs.openSync(mine, "r");
  try {
    await sandboxedAndNot("7z list", async () => {
      const how = await szReadArgs({ arg: mine, file: fd });
      const p = await runSz(["l", "-slt", "-ba", "--", archive], { readOnly: how.readOnly, fd: how.fd });
      const r = await p.done;
      return { denied: r.code !== 0 && !/sibling/.test(r.text), detail: `${r.code} ${r.text}` };
    });
  } finally {
    fs.closeSync(fd);
  }
});

liveSz("7-Zip extract is told to write outside its staging folder and to read a file outside its grants: refused under Landlock", async () => {
  const s = opScene("op-sz-extract");
  const mine = path.join(s.src, "own.7z");
  assert.equal(spawnSync(sz, ["a", "-t7z", mine, path.join(s.src, "own.txt")], { timeout: 60_000, input: "" }).status, 0);
  const fd = fs.openSync(mine, "r");
  const staging = path.join(s.dir, "staging");
  fs.mkdirSync(staging);
  const stFd = fs.openSync(staging, "r");
  try {
    await sandboxedAndNot("7z extract (write)", async () => {
      const out = path.join(s.outside, `x-${Date.now()}-${Math.random()}`);
      const how = await szReadArgs({ arg: mine, file: fd });
      const p = await runSz(["x", "-aoa", `-o${out}`, "--", how.arg], { cwdFd: stFd, readOnly: how.readOnly, readWrite: [stFd], fd: how.fd });
      const r = await p.done;
      return { denied: r.code !== 0 && !fs.existsSync(path.join(out, "own.txt")), detail: `${r.code} ${r.text}` };
    });
  } finally {
    fs.closeSync(fd);
    fs.closeSync(stFd);
  }
});

liveSz("7-Zip compress is told to read a file outside the source folder and to write outside its folder: refused under Landlock", async () => {
  const s = opScene("op-sz-compress");
  const srcFd = fs.openSync(s.src, "r");
  const outDir = path.join(s.dir, "outdir");
  fs.mkdirSync(outDir);
  const outFd = fs.openSync(outDir, "r");
  try {
    await sandboxedAndNot("7z compress (read)", async () => {
      const outName = `r-${Date.now()}-${Math.random()}.7z`;
      const p = await runSz(["a", "-t7z", "-snl", "-spd", path.join(outDir, outName), "./own.txt", path.join(s.outside, "secret.txt")], { cwdFd: srcFd, readOnly: [srcFd], readWrite: [outFd] });
      const r = await p.done;
      const made = path.join(outDir, outName);
      const leaked = fs.existsSync(made) && spawnSync(sz, ["l", "-ba", made], { encoding: "utf8", timeout: 60_000, input: "" }).stdout.includes("secret.txt");
      if (fs.existsSync(made)) fs.rmSync(made);
      return { denied: !leaked && r.code !== 0, detail: `${r.code} ${r.text}` };
    });
    await sandboxedAndNot("7z compress (write)", async () => {
      const target = path.join(s.outside, `w-${Date.now()}-${Math.random()}.7z`);
      const p = await runSz(["a", "-t7z", "-snl", "-spd", target, "./own.txt"], { cwdFd: srcFd, readOnly: [srcFd], readWrite: [outFd] });
      const r = await p.done;
      const existed = fs.existsSync(target);
      if (existed) fs.rmSync(target);
      return { denied: !existed && r.code !== 0, detail: `${r.code} ${r.text}` };
    });
  } finally {
    fs.closeSync(srcFd);
    fs.closeSync(outFd);
  }
});

/* ---- the limit is one number for every entry point: 3,001 and 10,000 names work for a zip download, a ticket and a compression ---- */

for (const count of [GRANT_LIMIT + 1, 3001, MAX_SELECTED]) {
  live(`${count} selected items: a zip download, a ticketed download and a compression all work (above ${GRANT_LIMIT} the pinned folder is granted to bsdtar)`, async () => {
    const s = scene(`many-${count}`);
    const names: string[] = [];
    for (let i = 0; i < count; i++) {
      names.push(`f${i}.txt`);
      fs.writeFileSync(path.join(s.src, `f${i}.txt`), `n${i}`);
    }
    fs.writeFileSync(path.join(s.src, "sibling.txt"), "NOT-SELECTED");
    const zip = path.join(s.dir, "dl.zip");
    await new Promise<void>((resolve, reject) => {
      const z = zipStream(s.src, names, new AbortController().signal, { root: s.root });
      const out = fs.createWriteStream(zip);
      z.on("error", reject);
      out.on("close", () => resolve());
      z.pipe(out);
    });
    const inZip = listTar(zip);
    assert.equal(inZip.length, count);
    assert.ok(!inZip.includes("sibling.txt"));
    const c = await runCompress(await prepareCompress(s.root, "/src", names, "tar.gz", `m${count}`, { destDir: "/out" }), LIM, mkCtl());
    const inTar = listTar(path.join(s.root, c.path));
    assert.equal(inTar.length, count);
    assert.ok(!inTar.includes("sibling.txt"));
    // the HTTP routes accept the same count
    const app = createAgent(loadConfig({ FILEDECK_ROOT: s.root, FILEDECK_NODE: "t" } as never));
    try {
      const t = await app.request("/api/fs/zip-ticket", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ dir: "/src", names }) });
      assert.equal(t.status, 201, await t.clone().text());
      const { id } = (await t.json()) as { id: string };
      const dl = await app.request(`/api/fs/zip?ticket=${id}`);
      assert.equal(dl.status, 200);
      const f = path.join(s.dir, "ticket.zip");
      fs.writeFileSync(f, Buffer.from(await dl.arrayBuffer()));
      assert.equal(listTar(f).length, count);
    } finally {
      await (app as unknown as { close(): Promise<void> }).close();
    }
  });
}

test("one more than the limit is refused by every entry point with the same number", needTool, async () => {
  const s = scene("over-limit");
  const names = Array.from({ length: MAX_SELECTED + 1 }, (_, i) => `x${i}`);
  await assert.rejects(prepareCompress(s.root, "/src", names, "tar.gz", "m", { destDir: "/out" }), (e: { status?: number; message?: string }) => e.status === 400 && new RegExp(`${MAX_SELECTED}`).test(e.message ?? ""));
  const app = createAgent(loadConfig({ FILEDECK_ROOT: s.root, FILEDECK_NODE: "t" } as never));
  try {
    const t = await app.request("/api/fs/zip-ticket", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ dir: "/src", names }) });
    assert.equal(t.status, 400);
    assert.match(await t.text(), new RegExp(`${MAX_SELECTED}`));
  } finally {
    await (app as unknown as { close(): Promise<void> }).close();
  }
});

test("the archive tools' user is their own: not root, not the media tools' user, configurable by one setting", () => {
  const prev = [process.env.FILEDECK_ARCHIVE_UID, process.env.FILEDECK_ARCHIVE_GID];
  try {
    delete process.env.FILEDECK_ARCHIVE_UID;
    delete process.env.FILEDECK_ARCHIVE_GID;
    assert.deepEqual(archiveUser(), { uid: 65533, gid: 65533 });
    assert.notEqual(archiveUser().uid, 65534);
    process.env.FILEDECK_ARCHIVE_UID = "70001";
    assert.deepEqual(archiveUser(), { uid: 70001, gid: 70001 });
    process.env.FILEDECK_ARCHIVE_GID = "70002";
    assert.deepEqual(archiveUser(), { uid: 70001, gid: 70002 });
    for (const bad of ["0", "-1", "abc", "4294967295", ""]) {
      process.env.FILEDECK_ARCHIVE_UID = bad;
      assert.equal(archiveUser().uid, 65533, `${JSON.stringify(bad)} is refused`);
    }
  } finally {
    for (const [i, k] of ["FILEDECK_ARCHIVE_UID", "FILEDECK_ARCHIVE_GID"].entries()) {
      if (prev[i] === undefined) delete process.env[k];
      else process.env[k] = prev[i];
    }
  }
});

/* ---- descriptors: the agent does not hold one per selected item while a tool runs ---- */

const openFds = () => fs.readdirSync("/proc/self/fd").length;
const scene3001 = (name: string, count: number) => {
  const s = scene(name);
  const names: string[] = [];
  for (let i = 0; i < count; i++) {
    names.push(`f${i}.txt`);
    fs.writeFileSync(path.join(s.src, `f${i}.txt`), `n${i}`);
  }
  return { s, names };
};

live("a zip download of 3,001 names that nobody reads holds only a few descriptors in the agent once the tool runs", async () => {
  const { s, names } = scene3001("fd-hold", 3001);
  const before = openFds();
  let during = -1;
  const z = zipStream(s.src, names, new AbortController().signal, { root: s.root, afterSpawn: () => void (during = openFds()) });
  await until(() => during >= 0, "the tool to have started");
  assert.ok(during - before < 40, `descriptors: ${before} before, ${during} while the tool runs and the body is unread`);
  // the body still arrives complete
  const zip = path.join(s.dir, "fd.zip");
  await new Promise<void>((resolve, reject) => {
    const out = fs.createWriteStream(zip);
    z.on("error", reject);
    out.on("close", () => resolve());
    z.pipe(out);
  });
  assert.equal(listTar(zip).length, 3001);
  assert.ok(openFds() - before < 10, "everything is released afterwards");
});

live("a compression of 3,001 names holds only a few descriptors in the agent while the tool runs", async () => {
  const { s, names } = scene3001("fd-hold-c", 3001);
  const before = openFds();
  let peak = 0;
  const timer = setInterval(() => (peak = Math.max(peak, openFds())), 5);
  try {
    await runCompress(await prepareCompress(s.root, "/src", names, "tar.gz", "m", { destDir: "/out" }), LIM, mkCtl());
  } finally {
    clearInterval(timer);
  }
  assert.ok(peak - before < 3100, `peak ${peak}, before ${before}`); // the grants are taken one by one while the list is built; they are gone once the tool is started
  assert.ok(openFds() - before < 10);
});

live("a grant that cannot be held for lack of descriptors is an explicit, logged fallback to the whole folder", async () => {
  const { s, names } = scene3001("fd-limit", 200);
  const logged: string[] = [];
  const save = grantHooks.log;
  grantHooks.log = (m) => logged.push(m);
  const hog: number[] = [];
  const fd = fs.openSync(s.src, "r");
  try {
    // fill the table: open files until the process refuses (the limit of this run is whatever `ulimit -n` says)
    try {
      for (;;) hog.push(fs.openSync("/dev/null", "r"));
    } catch {
      /* EMFILE */
    }
    for (let i = 0; i < 20; i++) fs.closeSync(hog.pop()!); // leave room for the folder, not for 200 grants
    const g = await selectionGrants(s.src, fd, names);
    assert.equal(g.wholeFolder, true);
    assert.match(logged.join("\n"), /cannot hold 200 descriptors/);
    await g.close();
  } finally {
    for (const h of hog) fs.closeSync(h);
    fs.closeSync(fd);
    grantHooks.log = save;
  }
});

live("a download nobody reads is ended after the stall time and gives its slot back", async () => {
  const s = scene("fd-stall");
  fs.writeFileSync(path.join(s.src, "big.bin"), randomBytes(4 << 20));
  const save = zipLimits.stallMs;
  zipLimits.stallMs = 400;
  try {
    const z = zipStream(s.src, ["big.bin"], new AbortController().signal, { root: s.root });
    const err = await new Promise<Error | undefined>((resolve) => {
      z.on("error", (e) => resolve(e));
      z.on("close", () => resolve(undefined));
    });
    assert.match(String(err), /not read in time/);
    await until(() => toolGate.running === 0, "the tool gate to be empty");
  } finally {
    zipLimits.stallMs = save;
  }
});

test("the tool gate runs a few at a time, queues some, and answers 429 beyond that or after a wait", async () => {
  const g = new ToolGate({ concurrency: 2, queue: 1, waitMs: 150 });
  const a = await g.acquire();
  const b = await g.acquire();
  const waiter = g.acquire();
  await assert.rejects(g.acquire(), (e: { status?: number }) => e.status === 429); // queue full
  a.release();
  const c = await waiter; // the freed slot passes on
  assert.equal(g.running, 2);
  const late = g.acquire();
  await assert.rejects(late, (e: { status?: number }) => e.status === 429); // waited for nothing
  b.release();
  b.release(); // idempotent
  c.release();
  assert.equal(g.running, 0);
  const ac = new AbortController();
  const x = await g.acquire(), y = await g.acquire();
  const pending = g.acquire(ac.signal);
  ac.abort();
  await assert.rejects(pending, (e: { status?: number }) => e.status === 400);
  x.release();
  y.release();
  assert.equal(g.queued, 0);
});

async function until(f: () => boolean, what: string, ms = 20_000) {
  const end = Date.now() + ms;
  while (!f()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

/* ---- root only: the tools never run as root, and still reach what only root can (a 0600 selection, a 0600 archive, a split set, a 0700 folder) ---- */

live("as root, root-only files and folders are archived, listed and extracted by tools that hold only the read-search capability", async () => {
  const s = scene("root-only");
  const body = randomBytes(200_000);
  fs.mkdirSync(path.join(s.src, "pick"));
  fs.chmodSync(path.join(s.src, "pick"), 0o700);
  fs.writeFileSync(path.join(s.src, "pick/a.bin"), body, { mode: 0o600 });
  fs.writeFileSync(path.join(s.src, "pick/b.txt"), "bee", { mode: 0o600 });
  fs.chmodSync(s.src, 0o700);
  // a zip download
  const zip = path.join(s.dir, "dl.zip");
  await new Promise<void>((resolve, reject) => {
    const z = zipStream(s.src, ["pick"], new AbortController().signal, { root: s.root });
    const out = fs.createWriteStream(zip);
    z.on("error", reject);
    out.on("close", () => resolve());
    z.pipe(out);
  });
  assert.deepEqual(listTar(zip).sort(), ["pick/", "pick/a.bin", "pick/b.txt"]);
  // compression in every bsdtar format, and its extraction from a 0600 archive in a 0700 folder
  let gz = "";
  for (const format of ["zip", "tar.gz", "tar.xz"] as const) {
    const c = await runCompress(await prepareCompress(s.root, "/src", ["pick"], format, `r-${format}`, { destDir: "/out" }), LIM, mkCtl());
    const made = path.join(s.root, c.path);
    assert.equal(fs.statSync(made).mode & 0o777, 0o600);
    assert.ok(listTar(made).includes("pick/a.bin"), `${format}: ${listTar(made)}`);
    if (format === "tar.gz") gz = c.path;
  }
  fs.chmodSync(s.out, 0o700);
  const listed = await listArchive(s.root, gz);
  assert.ok(JSON.stringify(listed).includes("a.bin"));
  const ex = await runExtract(await prepareExtract(s.root, gz, "/out", true, { overwrite: "rename" }), LIM, mkCtl());
  assert.deepEqual(fs.readFileSync(path.join(s.root, ex.path, "pick/a.bin")), body);
  // 7-Zip: password, split volumes, listing and extraction of the 0600 set
  if (haveSevenZip()) {
    const c = await runCompress(await prepareCompress(s.root, "/src", ["pick"], "7z", "pw", { destDir: "/out", password: "secret", splitBytes: 65_536 }), LIM, mkCtl());
    assert.ok((c.volumes ?? 0) >= 2, "split into volumes");
    const first = path.join(s.root, c.path);
    assert.equal(fs.statSync(first).mode & 0o777, 0o600);
    const l = await listArchive(s.root, c.path, 5000, "secret");
    assert.ok(JSON.stringify(l).includes("a.bin"));
    const x = await runExtract(await prepareExtract(s.root, c.path, "/out", true, { overwrite: "rename", password: "secret" }), LIM, mkCtl());
    assert.deepEqual(fs.readFileSync(path.join(s.root, x.path, "pick/a.bin")), body);
    // a single 0600 zip with a password (not split), listed and extracted
    const z = await runCompress(await prepareCompress(s.root, "/src", ["pick"], "zip", "pwz", { destDir: "/out", password: "secret" }), LIM, mkCtl());
    const xz = await runExtract(await prepareExtract(s.root, z.path, "/out", true, { overwrite: "rename", password: "secret" }), LIM, mkCtl());
    assert.deepEqual(fs.readFileSync(path.join(s.root, xz.path, "pick/a.bin")), body);
  }
}, { skip: ROOT_ONLY });
