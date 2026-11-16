import { test as baseTest, mock, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as ops from "../src/fsops.ts";
import { noReplaceHelper, noReplaceWarning, renameNoReplace } from "../src/noreplace.ts";
import { STAGING_PREFIX, withoutReadOnly } from "../src/pinwalk.ts";
import { buildRenameHelper, noRenameHelper, useRenameHelper } from "./noreplace-env.ts";

// These tests call the operations directly, outside a request: they run in an explicit scope with no read-only prefixes.
const test = (name: string, fn: (t: { skip: (why: string) => void }) => unknown) => baseTest(name, (t) => withoutReadOnly(() => fn(t)) as never);

const built = buildRenameHelper();
let base: string, root: string;
let n = 0;
before(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "filedeck-noreplace-")));
});
after(() => {
  fs.rmSync(base, { recursive: true, force: true });
  fs.rmSync(built.dir, { recursive: true, force: true });
});
afterEach(() => mock.restoreAll());

function fresh() {
  root = path.join(base, `r${++n}`, "root");
  fs.mkdirSync(path.join(root, "src/tree/sub"), { recursive: true });
  fs.writeFileSync(path.join(root, "src/tree/a.txt"), "a");
  fs.writeFileSync(path.join(root, "src/tree/sub/b.txt"), "b");
  fs.writeFileSync(path.join(root, "src/f.txt"), "mine");
  fs.mkdirSync(path.join(root, "dst"));
}
const at = (...p: string[]) => path.join(root, ...p);
const names = (...p: string[]) => fs.readdirSync(at(...p)).filter((x) => !x.startsWith(STAGING_PREFIX)).sort();

/** The real helper, or the test is skipped with the reason (no C compiler here). */
function real(t: { skip: (why: string) => void }): boolean {
  if (!built.bin) {
    console.log(`# ${built.why}`);
    t.skip(built.why);
    return false;
  }
  useRenameHelper(built.bin);
  return true;
}

/** A program that stands in for the helper: a shell script (the helper is started with an empty environment, so it sets its own PATH). */
function script(body: string): string {
  const p = path.join(base, `helper-${++n}.sh`);
  fs.writeFileSync(p, `#!/bin/sh\nPATH=/usr/bin:/bin\n${body}\n`, { mode: 0o755 });
  return p;
}

/**
 * Do `plant` once, right after the placement's own check of the destination found nothing: the `nth` time an `lstat` on the pinned
 * path of `leaf` answers "no such entry". It is the moment between "nothing is there" and "put it there". A move makes one such
 * check per placement; a copy makes one more before it, when it picks a free name.
 */
function afterCheck(leaf: string, plant: () => void, nth = 1) {
  const realLstat = fsp.lstat.bind(fsp) as (p: string, ...r: unknown[]) => Promise<unknown>;
  let seen = 0;
  let done = false;
  mock.method(fsp, "lstat", async (p: string, ...r: unknown[]) => {
    const got = await realLstat(p, ...r).then(
      (v) => ({ v }),
      (e) => ({ e }),
    );
    if (!done && "e" in got && (got.e as NodeJS.ErrnoException).code === "ENOENT" && typeof p === "string" && p.startsWith("/proc/self/fd/") && path.basename(p) === leaf && ++seen === nth) {
      done = true;
      plant();
    }
    if ("e" in got) throw got.e;
    return got.v;
  });
  return { planted: () => done };
}

const exists409 = async (p: Promise<unknown>) => {
  const e = await p.then(
    () => null,
    (x) => x,
  );
  assert.ok(e, "the operation must fail");
  assert.deepEqual(ops.mapError(e), { status: 409, message: "already exists" });
};

test("an empty folder that appears at the destination between the check and the placement is kept: a move answers already exists", async (t) => {
  if (!real(t)) return;
  fresh();
  const hook = afterCheck("tree", () => fs.mkdirSync(at("dst/tree")));
  await exists409(ops.rename(root, "/src/tree", "/dst/tree"));
  assert.equal(hook.planted(), true, "control: the folder appeared after the check");
  assert.deepEqual(fs.readdirSync(at("dst/tree")), [], "the folder that appeared is still there, and still empty");
  assert.equal(fs.readFileSync(at("src/tree/sub/b.txt"), "utf8"), "b", "the source stays");
  assert.deepEqual(names("dst"), ["tree"]);
});

test("the same for a copy: the folder that appeared is kept and the copy takes a free name", async (t) => {
  if (!real(t)) return;
  fresh();
  let ino = 0;
  const hook = afterCheck(
    "tree",
    () => {
      fs.mkdirSync(at("dst/tree"));
      ino = fs.statSync(at("dst/tree")).ino;
    },
    2, // the first is the search for a free name
  );
  assert.equal(await ops.copy(root, "/src/tree", "/dst"), "/dst/tree (copy)");
  assert.equal(hook.planted(), true);
  assert.equal(fs.statSync(at("dst/tree")).ino, ino, "the folder that appeared was not replaced");
  assert.deepEqual(fs.readdirSync(at("dst/tree")), []);
  assert.equal(fs.readFileSync(at("dst/tree (copy)/sub/b.txt"), "utf8"), "b");
  assert.deepEqual(names("dst"), ["tree", "tree (copy)"]);
});

test("the same after a move across devices: the copy is not put over a folder that appeared, and the source stays", async (t) => {
  if (!real(t)) return;
  fresh();
  // the first start answers "other device", as the kernel does for two folders on different devices; every later one is the real helper
  const flag = path.join(base, `flag-${++n}`);
  useRenameHelper(script(`if [ ! -e '${flag}' ]; then : > '${flag}'; exit 5; fi\nexec '${built.bin}' "$@"`));
  const hook = afterCheck("tree", () => fs.mkdirSync(at("dst/tree")), 2); // the second check is the one before the finished copy is placed
  await exists409(ops.rename(root, "/src/tree", "/dst/tree"));
  assert.equal(fs.existsSync(flag), true, "control: the first placement was answered as another device");
  assert.equal(hook.planted(), true, "control: the folder appeared after the second check");
  assert.deepEqual(fs.readdirSync(at("dst/tree")), [], "the folder that appeared is kept");
  assert.equal(fs.readFileSync(at("src/tree/sub/b.txt"), "utf8"), "b");
  assert.deepEqual(fs.readdirSync(at("dst")), ["tree"], "no working folder is left");
});

test("a folder is placed by the helper, not by a rename of Node's, and a file with hard links starts no helper", async (t) => {
  if (!real(t)) return;
  fresh();
  const realRename = fsp.rename.bind(fsp);
  const renames: string[] = [];
  mock.method(fsp, "rename", async (a: string, b: string) => {
    renames.push(path.basename(b));
    return realRename(a, b);
  });
  await ops.rename(root, "/src/tree", "/dst/tree");
  assert.equal(fs.readFileSync(at("dst/tree/sub/b.txt"), "utf8"), "b");
  assert.equal(fs.existsSync(at("src/tree")), false);
  assert.deepEqual(renames, [], "the folder was not placed by rename(2)");
  // a file: link and unlink, exact without the helper; a helper that always fails shows that none is started
  const log = path.join(base, `started-${++n}`);
  useRenameHelper(script(`: > '${log}'\necho 'filedeck-rename: EIO' >&2\nexit 1`));
  await ops.rename(root, "/src/f.txt", "/dst/f.txt");
  assert.equal(await ops.copy(root, "/dst/f.txt", "/dst"), "/dst/f (copy).txt");
  assert.equal(fs.readFileSync(at("dst/f.txt"), "utf8"), "mine");
  assert.equal(fs.existsSync(log), false, "no helper was started for a file");
});

test("a file on a filesystem without hard links is placed by the helper, and a file that appears after the check is kept", async (t) => {
  if (!real(t)) return;
  fresh();
  // link(2) fails as it does on a filesystem without hard links
  const noLinks = () => mock.method(fsp, "link", async () => Promise.reject(Object.assign(new Error("EPERM: operation not permitted, link"), { code: "EPERM" })));
  const realRename = fsp.rename.bind(fsp);
  const renames: string[] = [];
  const watchRename = () =>
    mock.method(fsp, "rename", async (a: string, b: string) => {
      renames.push(path.basename(b));
      return realRename(a, b);
    });
  noLinks();
  watchRename();
  const hook = afterCheck("f.txt", () => fs.writeFileSync(at("dst/f.txt"), "theirs"));
  await exists409(ops.rename(root, "/src/f.txt", "/dst/f.txt"));
  assert.equal(hook.planted(), true, "control: the file appeared after the check");
  assert.equal(fs.readFileSync(at("dst/f.txt"), "utf8"), "theirs", "the file that appeared is kept");
  assert.equal(fs.readFileSync(at("src/f.txt"), "utf8"), "mine", "the source stays");
  mock.restoreAll();
  // nothing in the way: the helper moves the file
  fs.rmSync(at("dst/f.txt"));
  noLinks();
  watchRename();
  await ops.rename(root, "/src/f.txt", "/dst/f.txt");
  assert.equal(fs.readFileSync(at("dst/f.txt"), "utf8"), "mine");
  assert.equal(fs.existsSync(at("src/f.txt")), false);
  assert.deepEqual(renames, [], "the file was not placed by rename(2)");
});

test("another device still reaches the copy path of a move", async (t) => {
  if (!real(t)) return;
  fresh();
  const flag = path.join(base, `flag-${++n}`);
  useRenameHelper(script(`if [ ! -e '${flag}' ]; then : > '${flag}'; exit 5; fi\nexec '${built.bin}' "$@"`));
  const realCopy = fsp.copyFile.bind(fsp);
  let copies = 0;
  mock.method(fsp, "copyFile", async (a: string, b: string, m?: number) => {
    copies++;
    return realCopy(a, b, m);
  });
  await ops.rename(root, "/src/tree", "/dst/tree");
  assert.equal(fs.existsSync(flag), true, "control: the helper answered another device");
  assert.equal(copies, 2, "the tree was copied, file by file");
  assert.equal(fs.readFileSync(at("dst/tree/sub/b.txt"), "utf8"), "b");
  assert.equal(fs.existsSync(at("src/tree")), false, "the source is removed after the copy");
  assert.deepEqual(fs.readdirSync(at("dst")), ["tree"]);
  // and the kernel's own answer for two folders on different devices, where this machine has two
  useRenameHelper(built.bin!);
  const other = ["/dev/shm", "/run/user/" + process.getuid!(), "/var/tmp"].find((d) => {
    try {
      fs.accessSync(d, fs.constants.W_OK);
      return fs.statSync(d).dev !== fs.statSync(base).dev;
    } catch {
      return false;
    }
  });
  if (!other) return console.log("# rename helper: no second writable device here, the kernel's own answer was not asked for");
  const far = fs.mkdtempSync(path.join(other, "filedeck-noreplace-"));
  const [a, b] = [await fsp.open(at("dst"), fs.constants.O_RDONLY | fs.constants.O_DIRECTORY), await fsp.open(far, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY)];
  try {
    assert.equal(await renameNoReplace(`/proc/self/fd/${a.fd}/tree`, `/proc/self/fd/${b.fd}/tree`), "xdev");
    assert.equal(fs.existsSync(at("dst/tree/a.txt")), true, "nothing was moved");
  } finally {
    await a.close();
    await b.close();
    fs.rmSync(far, { recursive: true, force: true });
  }
});

test("without the helper a folder is placed as before: check, then rename", async () => {
  fresh();
  noRenameHelper();
  assert.equal(await noReplaceHelper(), null);
  assert.match((await noReplaceWarning()) ?? "", /filedeck-rename\) not found/);
  const realRename = fsp.rename.bind(fsp);
  const renames: string[] = [];
  mock.method(fsp, "rename", async (a: string, b: string) => {
    renames.push(path.basename(b));
    return realRename(a, b);
  });
  await ops.rename(root, "/src/tree", "/dst/tree");
  assert.deepEqual(renames, ["tree"]);
  assert.equal(fs.readFileSync(at("dst/tree/sub/b.txt"), "utf8"), "b");
  // a file at the name is refused by rename(2) itself, as before
  fs.mkdirSync(at("src/tree"));
  mock.restoreAll();
  mock.method(fsp, "rename", async (a: string, b: string) => {
    if (path.basename(b) === "two") fs.writeFileSync(at("dst/two"), "theirs");
    return realRename(a, b);
  });
  await exists409(ops.rename(root, "/src/tree", "/dst/two"));
  assert.equal(fs.readFileSync(at("dst/two"), "utf8"), "theirs");
  // a file with no hard links: check, then rename
  mock.restoreAll();
  mock.method(fsp, "link", async () => Promise.reject(Object.assign(new Error("EPERM"), { code: "EPERM" })));
  await ops.rename(root, "/src/f.txt", "/dst/f.txt");
  assert.equal(fs.readFileSync(at("dst/f.txt"), "utf8"), "mine");
});

test("a helper that answers not supported leaves the placement to the old steps, and is asked again unless the kernel lacks the call", async () => {
  fresh();
  for (const [errno, starts] of [
    ["EINVAL", 2],
    ["ENOSYS", 1],
  ] as const) {
    const log = path.join(base, `starts-${++n}`);
    useRenameHelper(script(`echo x >> '${log}'\necho 'filedeck-rename: ${errno}' >&2\nexit 4`));
    const [one, two] = [`one-${errno}`, `two-${errno}`];
    fs.mkdirSync(at("src", one));
    fs.mkdirSync(at("src", two));
    await ops.rename(root, `/src/${one}`, `/dst/${one}`);
    await ops.rename(root, `/src/${two}`, `/dst/${two}`);
    assert.deepEqual(names("dst"), [one, two], "both folders were placed by the old steps");
    assert.equal(fs.readFileSync(log, "utf8").trim().split("\n").length, starts, errno);
    fs.rmSync(at("dst", one), { recursive: true });
    fs.rmSync(at("dst", two), { recursive: true });
  }
});

test("any other failure of the helper is the error rename(2) would have given, and nothing is placed", async () => {
  fresh();
  useRenameHelper(script(`echo 'filedeck-rename: EACCES' >&2\nexit 1`));
  const e = await ops.rename(root, "/src/tree", "/dst/tree").then(
    () => null,
    (x) => x,
  );
  assert.equal((e as NodeJS.ErrnoException)?.code, "EACCES");
  assert.deepEqual(ops.mapError(e), { status: 403, message: "permission denied" });
  assert.deepEqual(names("dst"), []);
  assert.equal(fs.existsSync(at("src/tree/a.txt")), true);
  // a helper that ends without a word (killed, or an unknown status) is an input/output error, never a success
  useRenameHelper(script(`kill -9 $$`));
  const k = await ops.rename(root, "/src/tree", "/dst/tree").then(
    () => null,
    (x) => x,
  );
  assert.equal((k as NodeJS.ErrnoException)?.code, "EIO");
  assert.deepEqual(names("dst"), []);
});

test("the helper gets the two pinned folders as descriptors 3 and 4, the two names, an empty environment and no other descriptor", async () => {
  fresh();
  const out = path.join(base, `seen-${++n}`);
  // the last line replaces the shell by `ls`, which lists its own descriptors: what the helper was started with, and nothing a shell adds
  const me = script([`cat /proc/$$/environ > '${out}.env'`, `echo "$#|$1|$2|$PWD" > '${out}.args'`, `exec ls -l /proc/self/fd > '${out}.fds'`].join("\n"));
  useRenameHelper(me);
  // descriptors of this process that the helper must not see: a file and a folder inside the root, held open during the copy
  const held = [await fsp.open(at("src/f.txt"), "r"), await fsp.open(at("src"), fs.constants.O_RDONLY | fs.constants.O_DIRECTORY)];
  try {
    await ops.copy(root, "/src/tree", "/dst").catch(() => undefined); // the stand-in places nothing; what the copy then answers is not the point here
  } finally {
    for (const h of held) await h.close();
  }
  const fds = [...fs.readFileSync(`${out}.fds`, "utf8").matchAll(/(\d+) -> (.+)$/gm)].map((m) => [Number(m[1]), m[2]!] as const);
  const seen = new Map(fds);
  assert.equal(seen.get(0), "/dev/null");
  assert.equal(seen.get(1), `${out}.fds`, "the listing itself; the helper is started with /dev/null there (the next test of the helper's own output shows it prints nothing)");
  assert.match(seen.get(2) ?? "", /^(?:pipe|socket):/, "the one error line goes to a pipe of the agent");
  assert.match(seen.get(3) ?? "", new RegExp(`^${at("dst")}/\\.filedeck-work-[^/]+$`), "3 is the working folder that holds the finished copy");
  assert.equal(seen.get(4), at("dst"), "4 is the destination folder");
  // besides those five, only the handle `ls` itself holds on the folder it lists (and the script file, should a shell pass it on)
  const rest = fds.filter(([fd, target]) => fd > 4 && target !== me && !/^\/proc\/\d+\/fd$/.test(target));
  assert.deepEqual(rest, [], `no other descriptor reaches the helper: ${JSON.stringify(fds)}`);
  assert.equal(fds.filter(([fd]) => fd <= 4).length, 5, "the five it is given are all there");
  assert.equal(fs.readFileSync(`${out}.env`).length, 0, "the environment is empty");
  assert.equal(fs.readFileSync(`${out}.args`, "utf8").trim(), "2|staged|tree|/");
});

test("only an entry directly in a pinned folder is handed to the helper", async () => {
  fresh();
  const log = path.join(base, `started-${++n}`);
  useRenameHelper(script(`: > '${log}'\nexit 0`));
  const d = await fsp.open(at("dst"), fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
  try {
    const pin = `/proc/self/fd/${d.fd}`;
    for (const [from, to] of [
      [at("src/tree"), `${pin}/tree`],
      [`${pin}/tree`, at("dst/x")],
      [`${pin}/sub/tree`, `${pin}/x`],
      [`${pin}/tree`, `${pin}/..`],
      [`${pin}/.`, `${pin}/x`],
      [`${pin}`, `${pin}/x`],
      [`/proc/self/fd/${d.fd}x/tree`, `${pin}/x`],
      [`/proc/self/cwd/tree`, `${pin}/x`],
    ] as const) {
      assert.equal(await renameNoReplace(from, to), "absent", `${from} -> ${to}`);
    }
  } finally {
    await d.close();
  }
  assert.equal(fs.existsSync(log), false, "the helper was not started");
});

test("the helper itself: one path component per name, nothing replaced, a distinct status for each answer", (t) => {
  if (!real(t)) return;
  fresh();
  const run = (from: string, to: string, fromDir = at("src"), toDir = at("dst")) => {
    const [a, b] = [fs.openSync(fromDir, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY), fs.openSync(toDir, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY)];
    try {
      const r = spawnSync(built.bin!, [from, to], { stdio: ["ignore", "pipe", "pipe", a, b], env: {}, encoding: "utf8" });
      return { status: r.status, err: r.stderr.trim(), out: r.stdout };
    } finally {
      fs.closeSync(a);
      fs.closeSync(b);
    }
  };
  fs.mkdirSync(at("dst/in"));
  for (const [from, to] of [
    ["", "x"],
    ["f.txt", ""],
    [".", "x"],
    ["f.txt", "."],
    ["..", "x"],
    ["f.txt", ".."],
    ["tree/a.txt", "x"],
    ["f.txt", "in/x"],
    ["f.txt", "/x"],
    ["f.txt", "../x"],
    ["/f.txt", "x"],
    ["f.txt", "x/"],
  ] as const) {
    assert.deepEqual(run(from, to), { status: 2, err: "filedeck-rename: a name must be one path component", out: "" }, `${JSON.stringify(from)} -> ${JSON.stringify(to)}`);
  }
  assert.equal(spawnSync(built.bin!, ["f.txt"], { stdio: "pipe", env: {} }).status, 2, "one name only");
  assert.equal(spawnSync(built.bin!, ["f.txt", "x", "y"], { stdio: "pipe", env: {} }).status, 2, "three names");
  assert.deepEqual(names("src"), ["f.txt", "tree"], "nothing was moved");
  assert.deepEqual(names("dst"), ["in"]);
  // exists: a file, an empty folder, a link that leads nowhere; each is kept
  fs.writeFileSync(at("dst/file"), "theirs");
  fs.symlinkSync("nowhere", at("dst/link"));
  for (const taken of ["file", "in", "link"]) {
    assert.deepEqual(run("tree", taken), { status: 3, err: "", out: "" }, taken);
    assert.deepEqual(run("f.txt", taken), { status: 3, err: "", out: "" }, taken);
  }
  assert.equal(fs.readFileSync(at("dst/file"), "utf8"), "theirs");
  assert.deepEqual(fs.readdirSync(at("dst/in")), []);
  assert.equal(fs.readlinkSync(at("dst/link")), "nowhere");
  // any other error names the errno; a folder into itself is the kernel's EINVAL, which is "not supported" (the caller's own rename then fails the same way)
  assert.deepEqual(run("missing", "x"), { status: 1, err: "filedeck-rename: ENOENT", out: "" });
  assert.deepEqual(run("tree", "x", at("src"), at("src/tree/sub")), { status: 4, err: "filedeck-rename: EINVAL", out: "" });
  assert.deepEqual(spawnSync(built.bin!, ["f.txt", "x"], { stdio: ["ignore", "pipe", "pipe"], env: {}, encoding: "utf8" }).stderr.trim(), "filedeck-rename: EBADF", "no folders given");
  // done: a link is moved as a link, a folder as a folder
  fs.symlinkSync("/etc", at("src/out"));
  assert.deepEqual(run("out", "out"), { status: 0, err: "", out: "" });
  assert.equal(fs.readlinkSync(at("dst/out")), "/etc");
  assert.deepEqual(run("tree", "tree"), { status: 0, err: "", out: "" });
  assert.equal(fs.readFileSync(at("dst/tree/sub/b.txt"), "utf8"), "b");
  assert.deepEqual(names("src"), ["f.txt"]);
});
