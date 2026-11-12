import { test as baseTest, mock, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import * as ops from "../src/fsops.ts";
import { uploadChunk } from "../src/chunked.ts";
import { deleteItems, restoreItems } from "../src/trash.ts";
import { STAGING_PREFIX, withReadOnly } from "../src/pinwalk.ts";
import { applyPerms, planPerms } from "../src/props.ts";
import { loadConfig } from "../src/config.ts";
import { withoutReadOnly } from "../src/pinwalk.ts";

// These tests call the operations directly, outside a request: they run in an explicit scope with no read-only prefixes.
const test = (name: string, fn: (t: never) => unknown) => baseTest(name, (t) => withoutReadOnly(() => fn(t as never)) as never);

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
  const realLink = fsp.link.bind(fsp);
  mock.method(fsp, "link", async (a: string, b: string) => {
    if (first) {
      first = false;
      throw Object.assign(new Error("EXDEV"), { code: "EXDEV" }); // a file is placed with link(2), which fails across devices as rename(2) does
    }
    return realLink(a, b);
  });
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
  assert.equal(fs.statSync(path.join(root, "dst/dirg")).mode & 0o7777, 0o2755, "a folder keeps set-group-id, so a shared folder keeps its group inheritance");
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
  {
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
    await withReadOnly(root, ["/ro"], () => assert.rejects(ops.upload(root, "/d", "x.txt", Readable.from([Buffer.from("x")]), false, 100), /read-only/));
    assert.deepEqual(fs.readdirSync(path.join(root, "ro")), []);
    mock.restoreAll();
    // a recursive change on a parent does not walk into a prefix
    fs.mkdirSync(path.join(root, "parent/ro"), { recursive: true });
    fs.writeFileSync(path.join(root, "parent/ro/f.txt"), "f");
    fs.chmodSync(path.join(root, "parent/ro/f.txt"), 0o644);
    const cfg = loadConfig({ FILEDECK_ROOT: root, FILEDECK_NODE: "t", FILEDECK_READONLY: "/parent/ro" } as never);
    const plan = await planPerms(cfg, { path: "/parent", mode: 0o750, recursive: true });
    await assert.rejects(applyPerms(cfg, plan), /read-only/);
    assert.equal(fs.statSync(path.join(root, "parent/ro/f.txt")).mode & 0o777, 0o644);
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

test("a folder renamed onto the staging name is refused and nothing in it is touched", async () => {
  fresh("adopt");
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "src/a.txt"), "a");
  fs.mkdirSync(path.join(root, "dst/victim"), { recursive: true });
  fs.chmodSync(path.join(root, "dst/victim"), 0o700);
  fs.writeFileSync(path.join(root, "dst/victim/precious.txt"), "P");
  const real = fsp.mkdir.bind(fsp);
  let done = false;
  mock.method(fsp, "mkdir", async (p: string, ...r: unknown[]) => {
    const v = await real(p, ...(r as []));
    if (!done && path.basename(p).startsWith(STAGING_PREFIX)) {
      done = true;
      fs.renameSync(path.join(root, "dst/victim"), p); // onto the fresh, empty staging folder
    }
    return v;
  });
  await assert.rejects(ops.copy(root, "/src/a.txt", "/dst"), /private work folder/);
  const all = fs.readdirSync(path.join(root, "dst"), { recursive: true }).map(String);
  assert.ok(all.some((n) => n.endsWith("precious.txt")), `precious.txt must survive: ${all.join(",")}`);
});

test("a recursive change refuses a read-only prefix inside the target before it changes anything", async () => {
  fresh("ro-first");
  fs.mkdirSync(path.join(root, "top/ro/deep"), { recursive: true });
  fs.writeFileSync(path.join(root, "top/ro/deep/f"), "x");
  fs.writeFileSync(path.join(root, "top/a.txt"), "a");
  fs.chmodSync(path.join(root, "top/ro"), 0o755);
  const cfg = loadConfig({ FILEDECK_ROOT: root, FILEDECK_NODE: "t", FILEDECK_READONLY: "/top/ro" } as never);
  {
    const plan = await planPerms(cfg, { path: "/top", mode: 0o700, recursive: true });
    await assert.rejects(applyPerms(cfg, plan), /read-only/);
    for (const p of ["top", "top/a.txt", "top/ro", "top/ro/deep", "top/ro/deep/f"]) assert.notEqual(fs.statSync(path.join(root, p)).mode & 0o777, 0o700, `${p} must be untouched`);
    // a folder that is swapped into a prefix mid-walk is refused before it is changed
    fs.mkdirSync(path.join(root, "rw/x/a"), { recursive: true });
    fs.mkdirSync(path.join(root, "srv/backup"), { recursive: true });
    fs.writeFileSync(path.join(root, "srv/backup/a.txt"), "p");
    fs.chmodSync(path.join(root, "srv/backup/a.txt"), 0o644);
    fs.chmodSync(path.join(root, "srv/backup"), 0o755);
    const cfg2 = loadConfig({ FILEDECK_ROOT: root, FILEDECK_NODE: "t", FILEDECK_READONLY: "/srv/backup" } as never);
    const plan2 = await planPerms(cfg2, { path: "/rw/x", mode: 0o700, recursive: true });
    const progress: { current?: string } = {};
    let cur = "";
    Object.defineProperty(progress, "current", {
      set(v: string) {
        cur = v;
        if (v.endsWith("/rw/x/a")) {
          fs.renameSync(path.join(root, "rw/x/a"), path.join(root, "rw/a-old"));
          fs.symlinkSync("../../srv/backup", path.join(root, "rw/x/a"));
        }
      },
      get: () => cur,
    });
    await applyPerms(cfg2, plan2, { signal: new AbortController().signal, progress } as never);
    assert.equal(fs.statSync(path.join(root, "srv/backup/a.txt")).mode & 0o777, 0o644);
    assert.equal(fs.statSync(path.join(root, "srv/backup")).mode & 0o777, 0o755);
  }
});

test("a mode change leaves a file with another name alone and reports it as skipped", async () => {
  fresh("hl");
  fs.mkdirSync(path.join(root, "etc"));
  fs.mkdirSync(path.join(root, "home/u"), { recursive: true });
  fs.writeFileSync(path.join(root, "etc/shadow"), "s");
  fs.chmodSync(path.join(root, "etc/shadow"), 0o600);
  fs.linkSync(path.join(root, "etc/shadow"), path.join(root, "home/u/s"));
  fs.writeFileSync(path.join(root, "home/u/own"), "o");
  const cfg = loadConfig({ FILEDECK_ROOT: root, FILEDECK_NODE: "t" } as never);
  const res = await applyPerms(cfg, await planPerms(cfg, { path: "/home/u", mode: 0o755, recursive: true }));
  assert.equal(fs.statSync(path.join(root, "etc/shadow")).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.join(root, "home/u/own")).mode & 0o777, 0o755);
  assert.ok(res.skipped >= 1);
});

test("a copy leaves out the trash store and working folders, and their names cannot be used", async () => {
  fresh("reserved");
  fs.mkdirSync(path.join(root, "src/tree/.filedeck-trash/x"), { recursive: true });
  fs.mkdirSync(path.join(root, "src/tree/.filedeck-work"), { recursive: true });
  fs.mkdirSync(path.join(root, `src/tree/${STAGING_PREFIX}abc-123`), { recursive: true });
  fs.writeFileSync(path.join(root, "src/tree/keep.txt"), "k");
  fs.mkdirSync(path.join(root, "dst"));
  await ops.copy(root, "/src/tree", "/dst");
  assert.deepEqual(fs.readdirSync(path.join(root, "dst/tree")), ["keep.txt"]);
  await assert.rejects(ops.mkdir(root, "/dst/.filedeck-work"), /reserved/);
  await assert.rejects(ops.mkdir(root, `/dst/${STAGING_PREFIX}zz`), /reserved/);
  await assert.rejects(ops.upload(root, "/dst", `${STAGING_PREFIX}up`, Readable.from([Buffer.from("x")]), false, 100), /reserved/);
  fs.mkdirSync(path.join(root, `dst/${STAGING_PREFIX}listed`));
  assert.ok(!(await ops.list(root, "/dst", true)).entries.some((e) => e.name.startsWith(STAGING_PREFIX)));
});

test("a stale staging folder is swept when the folder is next used; a foreign or busy one is not", async () => {
  fresh("sweep");
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "src/a.txt"), "a");
  fs.mkdirSync(path.join(root, "dst"));
  const old = Date.now() - 3 * 86400_000;
  const mk = (name: string, inner: string[]) => {
    const d = path.join(root, "dst", name);
    fs.mkdirSync(d, { mode: 0o700 });
    for (const n of inner) fs.writeFileSync(path.join(d, n), "x");
    for (const x of [...inner.map((n) => path.join(d, n)), d]) fs.utimesSync(x, new Date(old), new Date(old));
  };
  mk(`${STAGING_PREFIX}deadbeef-stale`, ["staged"]); // idle for days, only the staged entry: swept
  mk(`${STAGING_PREFIX}deadbeef-other`, ["precious"]); // holds something else: never emptied
  fs.mkdirSync(path.join(root, `dst/${STAGING_PREFIX}fresh-one`), { mode: 0o700 }); // another run's, recent: left
  await ops.copy(root, "/src/a.txt", "/dst");
  const left = fs.readdirSync(path.join(root, "dst")).sort();
  assert.ok(!left.includes(`${STAGING_PREFIX}deadbeef-stale`));
  assert.ok(left.includes(`${STAGING_PREFIX}deadbeef-other`));
  assert.ok(left.includes(`${STAGING_PREFIX}fresh-one`));
  assert.ok(fs.existsSync(path.join(root, `dst/${STAGING_PREFIX}deadbeef-other/precious`)));
});

test("running out of descriptors is the same clear error in a copy, a recursive change and a delete", async () => {
  fresh("emfile");
  fs.mkdirSync(path.join(root, "t/a/b"), { recursive: true });
  fs.writeFileSync(path.join(root, "t/a/b/f"), "x");
  fs.mkdirSync(path.join(root, "dst"));
  const cfg = loadConfig({ FILEDECK_ROOT: root, FILEDECK_NODE: "t" } as never);
  const real = fsp.open.bind(fsp);
  mock.method(fsp, "open", async (p: string, flags: number, ...r: never[]) => {
    if (path.basename(p) === "b") throw Object.assign(new Error("EMFILE"), { code: "EMFILE" });
    return real(p, flags, ...r);
  });
  await assert.rejects(ops.copy(root, "/t", "/dst"), /nested too deeply/);
  const plan = await planPerms(cfg, { path: "/t", mode: 0o750, recursive: true });
  await assert.rejects(applyPerms(cfg, plan), /nested too deeply/);
  await assert.rejects(ops.permanentDelete(root, "/t"), /nested too deeply/);
});

test("copy with overwrite, move onto and upload with overwrite never replace or empty a read-only folder or file", async () => {
  fresh("overwrite");
  fs.mkdirSync(path.join(root, "data/ro"), { recursive: true });
  fs.writeFileSync(path.join(root, "data/ro/keep.txt"), "K");
  fs.writeFileSync(path.join(root, "data/ro.txt"), "R");
  fs.mkdirSync(path.join(root, "src/ro"), { recursive: true });
  fs.writeFileSync(path.join(root, "src/ro/new.txt"), "N");
  fs.writeFileSync(path.join(root, "src/ro.txt"), "N");
  const refused = /read-only/;
  // the destination folder, as it is after it was swapped for a link into /data
  await withReadOnly(root, ["/data/ro", "/data/ro.txt"], async () => {
    await assert.rejects(ops.copy(root, "/src/ro", "/data", { overwrite: true }), refused);
    await assert.rejects(ops.copy(root, "/src/ro.txt", "/data", { overwrite: true }), refused);
    await assert.rejects(ops.rename(root, "/src/ro", "/data/ro", true), refused);
    await assert.rejects(ops.upload(root, "/data", "ro.txt", Readable.from([Buffer.from("x")]), true, 100), refused);
    await assert.rejects(uploadChunk(root, "/data", "ro.txt", "d".repeat(32), 0, Readable.from([Buffer.from("x")]), { total: 1, overwrite: true, maxBytes: 100 }), refused);
    await assert.rejects(ops.permanentDelete(root, "/data"), refused);
  });
  assert.equal(fs.readFileSync(path.join(root, "data/ro/keep.txt"), "utf8"), "K");
  assert.equal(fs.readFileSync(path.join(root, "data/ro.txt"), "utf8"), "R");
});

test("a cross-device move keeps the source when the tree holds a trash store with content", async () => {
  fresh("nested-trash");
  fs.mkdirSync(path.join(root, "src/tree/sub/.filedeck-trash/item"), { recursive: true });
  fs.writeFileSync(path.join(root, "src/tree/sub/.filedeck-trash/item/data"), "kept");
  fs.writeFileSync(path.join(root, "src/tree/a.txt"), "a");
  fs.mkdirSync(path.join(root, "dst"));
  forceExdevOnce();
  await assert.rejects(ops.rename(root, "/src/tree", "/dst/tree"), /trash store or working folder/);
  assert.equal(fs.readFileSync(path.join(root, "src/tree/sub/.filedeck-trash/item/data"), "utf8"), "kept");
  assert.deepEqual(fs.readdirSync(path.join(root, "dst")), [], "nothing is left at the destination, staging included");
});

test("a running copy keeps its staging folder's times fresh", async () => {
  fresh("touch");
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "src/a.txt"), "payload");
  fs.mkdirSync(path.join(root, "dst"));
  const old = new Date(Date.now() - 3 * 86400_000);
  mock.timers.enable({ apis: ["setInterval"] });
  const realCopy = fsp.copyFile.bind(fsp);
  let seen: number | undefined;
  mock.method(fsp, "copyFile", async (from: string, to: string, mode?: number) => {
    const stage = fs.readdirSync(path.join(root, "dst")).find((n) => n.startsWith(STAGING_PREFIX))!;
    fs.utimesSync(path.join(root, "dst", stage), old, old); // as if the copy had been running for days
    mock.timers.tick(6 * 60_000); // the refresh runs
    // the refresh's utimes runs on the thread pool: wait until it has landed (a loaded host takes longer than a couple of event-loop turns)
    for (let i = 0; i < 3000 && Date.now() - fs.statSync(path.join(root, "dst", stage)).mtimeMs >= 60_000; i++) await new Promise((r) => setTimeout(r, 10));
    seen = fs.statSync(path.join(root, "dst", stage)).mtimeMs;
    return realCopy(from, to, mode);
  });
  try {
    await ops.copy(root, "/src/a.txt", "/dst");
  } finally {
    mock.timers.reset();
  }
  assert.ok(seen !== undefined && Date.now() - seen < 60_000, "the staging folder was touched while the copy ran");
});

/* ---- the last steps of a move or copy ---- */

const EXDEV = () => Object.assign(new Error("EXDEV"), { code: "EXDEV" });
const stageIn = (dir: string) => fs.readdirSync(dir).find((n) => n.startsWith(STAGING_PREFIX));

test("a cross-device move whose source cannot be removed any more says the copy is complete, and keeps the copy", async () => {
  fresh("move-partial");
  fs.mkdirSync(path.join(root, "src/tree/sub"), { recursive: true });
  fs.writeFileSync(path.join(root, "src/tree/a.txt"), "a");
  fs.writeFileSync(path.join(root, "src/tree/sub/b.txt"), "b");
  fs.mkdirSync(path.join(root, "dst"));
  forceExdevOnce();
  const prefixes: string[] = [];
  const realUnlink = fsp.unlink.bind(fsp);
  mock.method(fsp, "unlink", async (p: string) => {
    // the first file of the source goes; then the sub-folder turns out to lie in a read-only prefix (it was swapped in meanwhile)
    if (path.basename(p) === "a.txt" && p.startsWith("/proc/self/fd/")) prefixes.push("/src/tree/sub");
    return realUnlink(p);
  });
  await withReadOnly(root, prefixes, async () => {
    const err = await ops.rename(root, "/src/tree", "/dst/tree").then(() => null, (e) => e);
    assert.ok(err instanceof ops.FsError, String(err));
    assert.match(err.message, /copy at the destination is complete/);
    assert.match(err.message, /only be removed in part/);
    assert.deepEqual(err.extra, { copyComplete: true, sourceRemoved: "partly" });
  });
  assert.equal(fs.readFileSync(path.join(root, "dst/tree/a.txt"), "utf8"), "a", "the finished copy is never removed");
  assert.equal(fs.readFileSync(path.join(root, "dst/tree/sub/b.txt"), "utf8"), "b");
  assert.equal(fs.existsSync(path.join(root, "src/tree/a.txt")), false, "control: the removal had started");
  assert.equal(fs.readFileSync(path.join(root, "src/tree/sub/b.txt"), "utf8"), "b");
});

test("a cross-device move that is refused before the first entry of the source is removed removes nothing and says so", async () => {
  fresh("move-refused");
  fs.mkdirSync(path.join(root, "src/tree/sub"), { recursive: true });
  fs.writeFileSync(path.join(root, "src/tree/a.txt"), "a");
  fs.writeFileSync(path.join(root, "src/tree/sub/b.txt"), "b");
  fs.mkdirSync(path.join(root, "dst"));
  const prefixes: string[] = [];
  const realRename = fsp.rename.bind(fsp);
  let n = 0;
  mock.method(fsp, "rename", async (a: string, b: string) => {
    if (++n === 1) throw EXDEV();
    await realRename(a, b); // the copy is put in place; now the source turns out to hold a read-only folder
    prefixes.push("/src/tree/sub");
  });
  await withReadOnly(root, prefixes, async () => {
    const err = await ops.rename(root, "/src/tree", "/dst/tree").then(() => null, (e) => e);
    assert.ok(err instanceof ops.FsError, String(err));
    assert.match(err.message, /copy at the destination is complete/);
    assert.match(err.message, /source was not removed/);
    assert.deepEqual(err.extra, { copyComplete: true, sourceRemoved: "no" });
  });
  assert.equal(fs.readFileSync(path.join(root, "dst/tree/sub/b.txt"), "utf8"), "b");
  assert.equal(fs.readFileSync(path.join(root, "src/tree/a.txt"), "utf8"), "a");
  assert.equal(fs.readFileSync(path.join(root, "src/tree/sub/b.txt"), "utf8"), "b");
});

test("a move without overwrite fails when something appears at the destination after the check, for a file and for a folder, on one device and across", async () => {
  const exists409 = async (p: Promise<unknown>) => {
    const e = await p.then(() => null, (x) => x);
    assert.ok(e, "the move must fail");
    assert.deepEqual(ops.mapError(e), { status: 409, message: "already exists" });
  };
  const planted = (name: string) => fs.readFileSync(path.join(root, name), "utf8");
  // a file, same device: link(2) refuses a name that is taken
  fresh("noreplace-file");
  fs.mkdirSync(path.join(root, "dst"), { recursive: true });
  fs.writeFileSync(path.join(root, "f.txt"), "mine");
  const realLink = fsp.link.bind(fsp);
  mock.method(fsp, "link", async (a: string, b: string) => {
    fs.writeFileSync(b, "theirs"); // created after the caller's check
    return realLink(a, b);
  });
  await exists409(ops.rename(root, "/f.txt", "/dst/f.txt"));
  assert.equal(planted("dst/f.txt"), "theirs");
  assert.equal(planted("f.txt"), "mine");
  mock.restoreAll();
  // a file, across devices: the final step of the fallback
  fs.rmSync(path.join(root, "dst/f.txt"));
  let calls = 0;
  mock.method(fsp, "link", async (a: string, b: string) => {
    if (++calls === 1) throw EXDEV();
    fs.writeFileSync(b, "theirs");
    return realLink(a, b);
  });
  await exists409(ops.rename(root, "/f.txt", "/dst/f.txt"));
  assert.equal(planted("dst/f.txt"), "theirs");
  assert.equal(planted("f.txt"), "mine", "the source stays");
  assert.deepEqual(fs.readdirSync(path.join(root, "dst")), ["f.txt"], "no staging folder is left");
  mock.restoreAll();
  // a folder: a file created at the name is not replaced (rename(2) refuses), same device and across
  for (const across of [false, true]) {
    fresh(`noreplace-dir-${across}`);
    fs.mkdirSync(path.join(root, "src/tree"), { recursive: true });
    fs.writeFileSync(path.join(root, "src/tree/a.txt"), "a");
    fs.mkdirSync(path.join(root, "dst"));
    const realRename = fsp.rename.bind(fsp);
    let n = 0;
    mock.method(fsp, "rename", async (a: string, b: string) => {
      if (across && ++n === 1) throw EXDEV();
      if (path.basename(b) === "tree") fs.writeFileSync(path.join(root, "dst/tree"), "theirs");
      return realRename(a, b);
    });
    await exists409(ops.rename(root, "/src/tree", "/dst/tree"));
    assert.equal(planted("dst/tree"), "theirs");
    assert.equal(fs.readFileSync(path.join(root, "src/tree/a.txt"), "utf8"), "a");
    mock.restoreAll();
  }
});

test("a folder renamed onto a staging name is removed by the sweep once it holds only the staged entry; any other stays", async () => {
  fresh("planted");
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "src/a.txt"), "a");
  fs.mkdirSync(path.join(root, "dst/victim"), { recursive: true });
  fs.chmodSync(path.join(root, "dst/victim"), 0o700);
  fs.writeFileSync(path.join(root, "dst/victim/staged"), "x");
  const real = fsp.mkdir.bind(fsp);
  let done = false;
  mock.method(fsp, "mkdir", async (p: string, ...r: unknown[]) => {
    const v = await real(p, ...(r as []));
    if (!done && path.basename(p).startsWith(STAGING_PREFIX)) {
      done = true;
      fs.renameSync(path.join(root, "dst/victim"), p); // onto the fresh, empty staging folder
    }
    return v;
  });
  await assert.rejects(ops.copy(root, "/src/a.txt", "/dst"), /private work folder/);
  mock.restoreAll();
  const planted = stageIn(path.join(root, "dst"))!;
  assert.ok(planted, "control: the folder stays under its reserved name after the refusal");
  // the next sweep of that folder (a new place for it: a sweep runs at most once an hour per folder)
  fs.renameSync(path.join(root, "dst"), path.join(root, "dst2"));
  fs.mkdirSync(path.join(root, "dst2", `${STAGING_PREFIX}other-run`), { mode: 0o755 }); // not private: never judged
  fs.writeFileSync(path.join(root, "dst2", `${STAGING_PREFIX}other-run`, "staged"), "y");
  const old = new Date(Date.now() - 3 * 86400_000);
  fs.utimesSync(path.join(root, "dst2", `${STAGING_PREFIX}other-run`), old, old);
  await ops.copy(root, "/src/a.txt", "/dst2");
  const left = fs.readdirSync(path.join(root, "dst2"));
  assert.ok(!left.includes(planted), "the planted folder with only the staged entry was removed");
  assert.ok(left.includes(`${STAGING_PREFIX}other-run`), "a folder that is not private is left alone");
});

test("a copy or a move whose working folder was removed or replaced meanwhile fails as interrupted, and a move keeps its source", async () => {
  const interruptedCopy = /stopped for too long/;
  for (const how of ["removed", "replaced"] as const) {
    for (const kindOf of ["copy", "move"] as const) {
      fresh(`interrupted-${how}-${kindOf}`);
      fs.mkdirSync(path.join(root, "src/tree"), { recursive: true });
      fs.writeFileSync(path.join(root, "src/tree/a.txt"), "payload");
      fs.mkdirSync(path.join(root, "dst"));
      fs.writeFileSync(path.join(root, "dst/keep.txt"), "keep");
      const realCopy = fsp.copyFile.bind(fsp);
      let hit = false;
      mock.method(fsp, "copyFile", async (from: string, to: string, mode?: number) => {
        if (!hit) {
          hit = true;
          const stage = path.join(root, "dst", stageIn(path.join(root, "dst"))!);
          if (how === "removed") fs.rmSync(stage, { recursive: true }); // as another process's sweep does to a folder that was not refreshed
          else {
            fs.renameSync(stage, `${stage}-away`);
            fs.mkdirSync(stage, { mode: 0o700 });
          }
        }
        return realCopy(from, to, mode);
      });
      if (kindOf === "move") forceExdevOnce();
      const run = kindOf === "copy" ? ops.copy(root, "/src/tree", "/dst") : ops.rename(root, "/src/tree", "/dst/tree");
      const err = await run.then(() => null, (e) => e);
      assert.ok(err, `${how} ${kindOf}: it must not report success`);
      assert.match(ops.mapError(err).message, interruptedCopy, `${how} ${kindOf}: ${err?.message}`);
      assert.equal(fs.readFileSync(path.join(root, "src/tree/a.txt"), "utf8"), "payload", `${how} ${kindOf}: the source is kept`);
      assert.equal(fs.existsSync(path.join(root, "dst/tree")), false, `${how} ${kindOf}: nothing was put in place`);
      assert.equal(fs.readFileSync(path.join(root, "dst/keep.txt"), "utf8"), "keep");
      mock.restoreAll();
    }
  }
});

test("a copy or a move with overwrite whose working folder is gone does not remove what it was to replace", async () => {
  for (const kindOf of ["copy", "move"] as const) {
    fresh(`interrupted-overwrite-${kindOf}`);
    fs.mkdirSync(path.join(root, "src/tree"), { recursive: true });
    fs.writeFileSync(path.join(root, "src/tree/a.txt"), "new");
    fs.mkdirSync(path.join(root, "dst/tree"), { recursive: true });
    fs.writeFileSync(path.join(root, "dst/tree/old.txt"), "old");
    const realCopy = fsp.copyFile.bind(fsp);
    mock.method(fsp, "copyFile", async (from: string, to: string, mode?: number) => {
      const r = await realCopy(from, to, mode);
      fs.rmSync(path.join(root, "dst", stageIn(path.join(root, "dst"))!), { recursive: true });
      return r;
    });
    if (kindOf === "move") forceExdevOnce();
    const run = kindOf === "copy" ? ops.copy(root, "/src/tree", "/dst", { overwrite: true }) : ops.rename(root, "/src/tree", "/dst/tree", true);
    await assert.rejects(run, /stopped for too long/);
    assert.equal(fs.readFileSync(path.join(root, "dst/tree/old.txt"), "utf8"), "old", `${kindOf}: the folder to be replaced is untouched`);
    assert.equal(fs.readFileSync(path.join(root, "src/tree/a.txt"), "utf8"), "new");
    mock.restoreAll();
  }
});
