import { test, mock, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import * as ops from "../src/fsops.ts";
import { uploadChunk } from "../src/chunked.ts";
import { deleteItems, restoreItems } from "../src/trash.ts";
import { registerReadOnly } from "../src/pinwalk.ts";
import { applyPerms, planPerms } from "../src/props.ts";
import { loadConfig } from "../src/config.ts";

// Each test swaps a folder for a link to a folder outside the root at the moment between "the folder was looked at"
// and "the folder is used", and then checks that nothing outside was read, written or changed.
let base: string, root: string, outside: string, swapped = false;
before(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "filedeck-pin-")));
});
after(() => fs.rmSync(base, { recursive: true, force: true }));
afterEach(() => {
  mock.restoreAll();
  for (const fn of WATCHED) pending[fn] = null;
});

function fresh(name: string) {
  swapped = false;
  root = path.join(base, name, "root");
  outside = path.join(base, name, "outside");
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(outside, "secret.txt"), "TOP SECRET");
  fs.chmodSync(path.join(outside, "secret.txt"), 0o644);
}

/**
 * Once, the first time `fn` is called on a path whose last component is `leaf`, replace the folder `dir` by a link to
 * `outside`: right after the call (`after`, the default) or right before it (`before`).
 *
 * The wrappers are installed once for the whole file and only look up what to do when they are called. Node's own
 * recursive copy keeps the first function it saw (a later mock would never be seen by it), so a wrapper that came and
 * went with each test would make the tests depend on their order.
 */
type Pending = { leaf: string; dir: () => string; when: "before" | "after" } | null;
const WATCHED = ["lstat", "mkdir", "open"] as const;
const pending: Record<(typeof WATCHED)[number], Pending> = { lstat: null, mkdir: null, open: null };
const originals = new Map<string, unknown>();
before(() => {
  for (const fn of WATCHED) {
    const real = fsp[fn] as (...a: unknown[]) => Promise<unknown>;
    originals.set(fn, real);
    (fsp as unknown as Record<string, unknown>)[fn] = async function (p: unknown, ...rest: unknown[]) {
      const fire = (when: "before" | "after") => {
        const pd = pending[fn];
        if (!pd || pd.when !== when || typeof p !== "string" || path.basename(p) !== pd.leaf) return;
        pending[fn] = null;
        swapped = true;
        const d = pd.dir();
        fs.renameSync(d, d + ".orig");
        fs.symlinkSync(outside, d);
      };
      fire("before");
      const got = await real.call(fsp, p, ...rest).then(
        (v) => ({ v }),
        (e) => ({ e }),
      ); // the call may fail (nothing there yet); the swap happens right after it either way
      fire("after");
      if ("e" in got) throw got.e;
      return got.v;
    };
  }
});
after(() => {
  for (const fn of WATCHED) (fsp as unknown as Record<string, unknown>)[fn] = originals.get(fn);
});
function swapWhen(fn: (typeof WATCHED)[number], leaf: string, dir: () => string, when: "before" | "after" = "after") {
  pending[fn] = { leaf, dir, when };
  return { mock: { restore: () => void (pending[fn] = null) } };
}

const noSecret = (dir: string) => {
  const found: string[] = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === "secret.txt") found.push(path.join(d, e.name));
      if (e.isDirectory()) walk(path.join(d, e.name));
    }
  };
  walk(dir);
  return found;
};

test("recursive chmod does not enter a folder that was swapped for a link after it was listed", async () => {
  fresh("perms");
  fs.mkdirSync(path.join(root, "top/sub"), { recursive: true });
  fs.writeFileSync(path.join(root, "top/sub/inner.txt"), "i");
  fs.writeFileSync(path.join(root, "top/a.txt"), "a");
  const cfg = loadConfig({ FILEDECK_ROOT: root, FILEDECK_NODE: "t" } as never);
  const plan = await planPerms(cfg, { path: "/top", mode: 0o750, recursive: true });
  const hook = swapWhen("open", "sub", () => path.join(root, "top/sub"), "before");
  let res;
  try {
    res = await applyPerms(cfg, plan);
  } finally {
    hook.mock.restore();
  }
  assert.equal(fs.statSync(path.join(outside, "secret.txt")).mode & 0o777, 0o644, "the outside file must keep its mode");
  assert.equal(fs.statSync(path.join(root, "top/a.txt")).mode & 0o777, 0o750);
  assert.ok(res.errors >= 1);
});

test("copy does not read through a folder swapped for a link while it is being copied", async () => {
  fresh("copy");
  fs.mkdirSync(path.join(root, "src/tree/sub"), { recursive: true });
  fs.writeFileSync(path.join(root, "src/tree/sub/inner.txt"), "inner");
  fs.mkdirSync(path.join(root, "dst"));
  const hook = swapWhen("mkdir", "sub", () => path.join(root, "src/tree/sub"));
  try {
    await ops.copy(root, "/src/tree", "/dst");
  } finally {
    hook.mock.restore();
  }
  assert.deepEqual(noSecret(path.join(root, "dst")), []);
  assert.equal(fs.readFileSync(path.join(root, "dst/tree/sub/inner.txt"), "utf8"), "inner", "the folder that was listed is the one copied");
});

test("the cross-device move fallback does not read through a swapped folder", async () => {
  fresh("move");
  fs.mkdirSync(path.join(root, "src/tree/sub"), { recursive: true });
  fs.writeFileSync(path.join(root, "src/tree/sub/inner.txt"), "inner");
  fs.mkdirSync(path.join(root, "dst"));
  const realRename = fsp.rename.bind(fsp);
  let first = true;
  const ren = mock.method(fsp, "rename", async (a: string, b: string) => {
    if (first) {
      first = false;
      throw Object.assign(new Error("EXDEV"), { code: "EXDEV" });
    }
    return realRename(a, b);
  });
  const hook = swapWhen("mkdir", "sub", () => path.join(root, "src/tree/sub"));
  try {
    await ops.rename(root, "/src/tree", "/dst/tree");
  } finally {
    hook.mock.restore();
    ren.mock.restore();
  }
  assert.deepEqual(noSecret(path.join(root, "dst")), []);
  assert.equal(fs.readFileSync(path.join(root, "dst/tree/sub/inner.txt"), "utf8"), "inner");
  assert.equal(fs.readFileSync(path.join(outside, "secret.txt"), "utf8"), "TOP SECRET");
});

test("a recursive delete never follows a folder swapped for a link", async () => {
  fresh("rm");
  fs.mkdirSync(path.join(root, "tree/sub"), { recursive: true });
  fs.writeFileSync(path.join(root, "tree/sub/inner.txt"), "inner");
  const hook = swapWhen("open", "sub", () => path.join(root, "tree/sub"), "before");
  try {
    await ops.permanentDelete(root, "/tree").catch(() => undefined); // the swapped-in link is removed, the folder moved aside stays
  } finally {
    hook.mock.restore();
  }
  assert.ok(swapped, "the swap happened");
  assert.equal(fs.readFileSync(path.join(outside, "secret.txt"), "utf8"), "TOP SECRET");
});

test("a chunk lands in the folder that was resolved, even if it is swapped for a link before the part file is touched", async () => {
  fresh("chunk");
  fs.mkdirSync(path.join(root, "up"));
  const id = "b".repeat(32);
  const hook = swapWhen("lstat", `.big.bin.filedeck-up-${id}.part`, () => path.join(root, "up"));
  try {
    const r = await uploadChunk(root, "/up", "big.bin", id, 0, Readable.from([Buffer.from("abc")]), { total: 3, overwrite: true, maxBytes: 100 });
    assert.equal(r.done, true);
  } finally {
    hook.mock.restore();
  }
  assert.deepEqual(fs.readdirSync(outside), ["secret.txt"]);
  assert.equal(fs.readFileSync(path.join(root, "up.orig/big.bin"), "utf8"), "abc");
});

test("a trash restore lands in the folder that was checked, even if it is swapped for a link", async () => {
  fresh("restore");
  fs.mkdirSync(path.join(root, "docs"));
  fs.writeFileSync(path.join(root, "docs/report.txt"), "R");
  const meta = await ops.trash(root, "/docs/report.txt");
  const hook = swapWhen("lstat", "report.txt", () => path.join(root, "docs"));
  let out;
  try {
    out = await restoreItems(root, "/", [meta.id]);
  } finally {
    hook.mock.restore();
  }
  assert.equal(out[0]!.ok, true, JSON.stringify(out));
  assert.deepEqual(fs.readdirSync(outside), ["secret.txt"]);
  assert.equal(fs.readFileSync(path.join(root, "docs.orig/report.txt"), "utf8"), "R");
});

const forceExdevOnce = () => {
  const realRename = fsp.rename.bind(fsp);
  let first = true;
  return mock.method(fsp, "rename", async (a: string, b: string) => {
    if (first) {
      first = false;
      throw Object.assign(new Error("EXDEV"), { code: "EXDEV" });
    }
    return realRename(a, b);
  });
};

/** The methods of the descriptor objects, to watch the order of owner and mode changes. */
async function handleProto() {
  const probe = await fsp.open(base);
  const proto = Object.getPrototypeOf(probe) as Record<"chown" | "chmod", (...a: number[]) => Promise<void>>;
  await probe.close();
  return proto;
}

test("a copy never carries set-user-id or set-group-id bits it was not given an owner for", async () => {
  fresh("setuid");
  fs.mkdirSync(path.join(root, "src/dirg"), { recursive: true });
  fs.mkdirSync(path.join(root, "dst"));
  fs.writeFileSync(path.join(root, "src/prog"), "#!/bin/sh\n");
  fs.chmodSync(path.join(root, "src/prog"), 0o4755);
  fs.chmodSync(path.join(root, "src/dirg"), 0o2755);
  await ops.copy(root, "/src/prog", "/dst");
  await ops.copy(root, "/src/dirg", "/dst");
  assert.equal(fs.statSync(path.join(root, "dst/prog")).mode & 0o7777, 0o755);
  assert.equal(fs.statSync(path.join(root, "dst/dirg")).mode & 0o7777, 0o755);
});

test("a cross-device move sets the mode only after the owner, and drops the bits when the owner is refused", async () => {
  fresh("order");
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.mkdirSync(path.join(root, "dst"));
  fs.writeFileSync(path.join(root, "src/prog"), "x");
  fs.chmodSync(path.join(root, "src/prog"), 0o4755);
  fs.writeFileSync(path.join(root, "src/prog2"), "x");
  fs.chmodSync(path.join(root, "src/prog2"), 0o4755);
  const proto = await handleProto();
  const calls: string[] = [];
  const [realChown, realChmod] = [proto.chown, proto.chmod];
  mock.method(proto, "chown", async function (this: unknown, ...a: number[]) {
    calls.push("chown");
    return realChown.apply(this, a);
  });
  mock.method(proto, "chmod", async function (this: unknown, ...a: number[]) {
    calls.push(`chmod:${(a[0]! & 0o7777).toString(8)}`);
    return realChmod.apply(this, a);
  });
  forceExdevOnce();
  await ops.rename(root, "/src/prog", "/dst/prog");
  assert.deepEqual(calls, ["chown", "chmod:4755"], "owner first, then the full mode");
  assert.equal(fs.statSync(path.join(root, "dst/prog")).mode & 0o7777, 0o4755);
  // the owner cannot be given: the copy must not keep the bits
  mock.restoreAll();
  mock.method(proto, "chown", async () => {
    throw Object.assign(new Error("EPERM"), { code: "EPERM" });
  });
  forceExdevOnce();
  await ops.rename(root, "/src/prog2", "/dst/prog2");
  assert.equal(fs.statSync(path.join(root, "dst/prog2")).mode & 0o7777, 0o755);
});

test("the new top-level entry cannot be swapped for a hard link to another file while owner and times are set", async () => {
  fresh("hardlink");
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.mkdirSync(path.join(root, "dst"));
  fs.writeFileSync(path.join(root, "src/f.txt"), "payload");
  fs.utimesSync(path.join(root, "src/f.txt"), new Date("2001-01-01T00:00:00Z"), new Date("2001-01-01T00:00:00Z"));
  const victim = path.join(outside, "victim.txt");
  fs.writeFileSync(victim, "victim");
  fs.chmodSync(victim, 0o640);
  const before = fs.statSync(victim);
  // right after the data is copied, whoever may write to the destination folder renames the temporary entry away and links the victim under its name
  const real = fsp.copyFile.bind(fsp);
  mock.method(fsp, "copyFile", async (from: string, to: string, mode?: number) => {
    await real(from, to, mode);
    const dstDir = path.join(root, "dst");
    const hidden = fs.readdirSync(dstDir).find((n) => n.startsWith(".") && n.includes("filedeck"));
    if (hidden) {
      const p = path.join(dstDir, hidden);
      const wasDir = fs.statSync(p).isDirectory();
      fs.renameSync(p, p + ".moved");
      if (wasDir) {
        fs.mkdirSync(p);
        fs.linkSync(victim, path.join(p, "staged"));
      } else fs.linkSync(victim, p);
    }
  });
  forceExdevOnce();
  await ops.rename(root, "/src/f.txt", "/dst/f.txt").catch(() => undefined);
  const after = fs.statSync(victim);
  assert.equal(after.mtimeMs, before.mtimeMs, "the victim's times must not change");
  assert.equal(after.mode & 0o7777, 0o640, "the victim's mode must not change");
  assert.ok(fs.readdirSync(path.join(root, "dst")).some((n) => n.includes(".moved")), "the swap happened");
});

test("a recursive owner change skips files with other names, and never gives a folder a file mode", async () => {
  fresh("links");
  fs.mkdirSync(path.join(root, "top"), { recursive: true });
  fs.writeFileSync(path.join(root, "top/solo.txt"), "s");
  fs.writeFileSync(path.join(root, "top/linked.txt"), "l");
  fs.linkSync(path.join(root, "top/linked.txt"), path.join(outside, "other-name.txt"));
  fs.writeFileSync(path.join(root, "top/swap.txt"), "w");
  const cfg = loadConfig({ FILEDECK_ROOT: root, FILEDECK_NODE: "t" } as never);
  const plan = { ...(await planPerms(cfg, { path: "/top", mode: 0o640, recursive: true, scope: "files" })), uid: process.getuid!(), gid: process.getgid!() };
  // swap.txt becomes a folder between the listing and the change
  const hook = swapDirForFile(path.join(root, "top/swap.txt"));
  let res;
  try {
    res = await applyPerms(cfg, plan);
  } finally {
    hook.mock.restore();
  }
  assert.equal(fs.statSync(path.join(root, "top/solo.txt")).mode & 0o777, 0o640);
  assert.notEqual(fs.statSync(path.join(root, "top/linked.txt")).mode & 0o777, 0o640, "a file with another name is left alone");
  assert.equal(fs.statSync(path.join(root, "top/swap.txt")).mode & 0o777, 0o755 & ~process.umask(), "the folder keeps its mode");
  assert.ok(res.skipped >= 1 && res.errors >= 1);
});

function swapDirForFile(file: string) {
  const real = fsp.open.bind(fsp);
  let done = false;
  return mock.method(fsp, "open", async (p: string, ...rest: never[]) => {
    if (!done && path.basename(p) === path.basename(file)) {
      done = true;
      fs.renameSync(file, file + ".orig");
      fs.mkdirSync(file);
    }
    return real(p, ...rest);
  });
}

test("a folder swapped into a read-only prefix after the guard ran is refused", async () => {
  fresh("ro");
  fs.mkdirSync(path.join(root, "d"));
  fs.mkdirSync(path.join(root, "ro"));
  registerReadOnly(root, ["/ro"]);
  try {
    const real = fsp.open.bind(fsp);
    let done = false;
    mock.method(fsp, "open", async (p: string, ...rest: never[]) => {
      if (!done && p === path.join(root, "d")) {
        done = true;
        fs.renameSync(p, p + ".orig");
        fs.symlinkSync(path.join(root, "ro"), p);
      }
      return real(p, ...rest);
    });
    await assert.rejects(ops.upload(root, "/d", "x.txt", Readable.from([Buffer.from("x")]), false, 100), /read-only/);
    assert.deepEqual(fs.readdirSync(path.join(root, "ro")), []);
    mock.restoreAll();
    // a recursive change on a parent does not walk into a prefix
    fs.mkdirSync(path.join(root, "parent/ro"), { recursive: true });
    fs.writeFileSync(path.join(root, "parent/ro/f.txt"), "f");
    fs.chmodSync(path.join(root, "parent/ro/f.txt"), 0o644);
    registerReadOnly(root, ["/parent/ro"]);
    const cfg = loadConfig({ FILEDECK_ROOT: root, FILEDECK_NODE: "t" } as never);
    const plan = await planPerms(cfg, { path: "/parent", mode: 0o750, recursive: true });
    await assert.rejects(applyPerms(cfg, plan), /read-only/);
    assert.equal(fs.statSync(path.join(root, "parent/ro/f.txt")).mode & 0o777, 0o644);
  } finally {
    registerReadOnly(root, []);
  }
});

test("a part file with a second name is not appended to", async () => {
  fresh("part");
  fs.mkdirSync(path.join(root, "up"));
  const id = "c".repeat(32);
  const part = path.join(root, "up", `.f.bin.filedeck-up-${id}.part`);
  fs.writeFileSync(part, "ab");
  fs.linkSync(part, path.join(outside, "other-name"));
  await assert.rejects(uploadChunk(root, "/up", "f.bin", id, 2, Readable.from([Buffer.from("cd")]), { total: 4, overwrite: true, maxBytes: 100 }), (e: { status?: number }) => e.status === 409);
  assert.equal(fs.readFileSync(path.join(outside, "other-name"), "utf8"), "ab");
});

test("emptying a trash item never follows a folder swapped for a link", async () => {
  fresh("purge");
  fs.mkdirSync(path.join(root, "tree/sub"), { recursive: true });
  fs.writeFileSync(path.join(root, "tree/sub/inner.txt"), "inner");
  const meta = await ops.trash(root, "/tree");
  const item = path.join(root, ".filedeck-trash", meta.id, "data/sub");
  const hook = swapWhen("open", "sub", () => item, "before");
  try {
    assert.equal((await deleteItems(root, "/", [meta.id]))[0]!.ok, true);
  } finally {
    hook.mock.restore();
  }
  assert.ok(swapped, "the swap happened");
  assert.equal(fs.readFileSync(path.join(outside, "secret.txt"), "utf8"), "TOP SECRET");
  assert.ok(!fs.existsSync(path.join(root, ".filedeck-trash", meta.id)));
});
