import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createAgent } from "../src/agent.ts";
import { loadConfig } from "../src/config.ts";
import { haveSevenZip } from "../src/sevenzip.ts";
import { listArchive, outputBounds, prepareCompress, prepareExtract, runCompress, runExtract, selectionGrants, zipStream } from "../src/archive.ts";
import { resetSandbox, sandboxInfo, spawnSandboxed } from "../src/sandbox.ts";
import type { JobCtl } from "../src/jobs.ts";
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
