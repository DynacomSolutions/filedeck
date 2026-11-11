import { test, mock, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import * as ops from "../src/fsops.ts";
import { uploadChunk } from "../src/chunked.ts";
import { restoreItems } from "../src/trash.ts";
import { applyPerms, planPerms } from "../src/props.ts";
import { loadConfig } from "../src/config.ts";

// Each test swaps a folder for a link to a folder outside the root at the moment between "the folder was looked at"
// and "the folder is used", and then checks that nothing outside was read, written or changed.
let base: string, root: string, outside: string;
before(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "filedeck-pin-")));
});
after(() => fs.rmSync(base, { recursive: true, force: true }));

function fresh(name: string) {
  root = path.join(base, name, "root");
  outside = path.join(base, name, "outside");
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(outside, "secret.txt"), "TOP SECRET");
  fs.chmodSync(path.join(outside, "secret.txt"), 0o644);
}

/** Once, the first time `fn` is called on a path whose last component is `leaf`, replace the folder `dir` by a link to `outside`. */
function swapWhen<K extends "lstat" | "mkdir">(fn: K, leaf: string, dir: () => string) {
  const real = (fsp[fn] as (...a: unknown[]) => Promise<unknown>).bind(fsp);
  let done = false;
  return mock.method(fsp, fn, async (p: string, ...rest: unknown[]) => {
    const got = await real(p, ...rest).then(
      (v) => ({ v }),
      (e) => ({ e }),
    ); // the lookup may fail (nothing there yet); the swap happens right after it either way
    if (!done && typeof p === "string" && path.basename(p) === leaf) {
      done = true;
      const d = dir();
      fs.renameSync(d, d + ".orig");
      fs.symlinkSync(outside, d);
    }
    if ("e" in got) throw got.e;
    return got.v;
  });
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
  const hook = swapWhen("lstat", "sub", () => path.join(root, "top/sub"));
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
  const hook = swapWhen("lstat", "sub", () => path.join(root, "tree/sub"));
  try {
    await assert.rejects(ops.permanentDelete(root, "/tree"));
  } finally {
    hook.mock.restore();
  }
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
