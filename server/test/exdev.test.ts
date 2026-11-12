import { test as baseTest, mock } from "node:test";
import assert from "node:assert/strict";
import nodeFs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as ops from "../src/fsops.ts";
import { withoutReadOnly } from "../src/pinwalk.ts";

// These tests call the operations directly, outside a request: they run in an explicit scope with no read-only prefixes.
const test = (name: string, fn: (t: never) => unknown) => baseTest(name, (t) => withoutReadOnly(() => fn(t as never)) as never);

function setup() {
  const root = nodeFs.realpathSync(nodeFs.mkdtempSync(path.join(os.tmpdir(), "filedeck-exdev-")));
  nodeFs.mkdirSync(path.join(root, "src/tree/sub"), { recursive: true });
  nodeFs.writeFileSync(path.join(root, "src/tree/a.txt"), "a");
  nodeFs.writeFileSync(path.join(root, "src/tree/sub/b.txt"), "b");
  nodeFs.mkdirSync(path.join(root, "dst"));
  return root;
}

// Make the first rename (source -> destination) fail with EXDEV so the
// copy+delete fallback runs; later renames use the real implementation.
function forceExdev() {
  const real = fsp.rename.bind(fsp);
  let first = true;
  const realLink = fsp.link.bind(fsp);
  mock.method(fsp, "link", async (a: string, b: string) => {
    if (first) {
      first = false;
      throw Object.assign(new Error("EXDEV"), { code: "EXDEV" }); // a file is placed with link(2), which fails across devices as rename(2) does
    }
    return realLink(a, b);
  });
  return mock.method(fsp, "rename", async (from: string, to: string) => {
    if (first) {
      first = false;
      throw Object.assign(new Error("EXDEV"), { code: "EXDEV" });
    }
    return real(from, to);
  });
}

test("EXDEV move fallback copies then removes the source", async () => {
  const root = setup();
  const m = forceExdev();
  try {
    await ops.rename(root, "/src/tree", "/dst/tree");
    assert.equal(nodeFs.readFileSync(path.join(root, "dst/tree/sub/b.txt"), "utf8"), "b");
    assert.equal(nodeFs.existsSync(path.join(root, "src/tree")), false);
    assert.deepEqual(nodeFs.readdirSync(path.join(root, "dst")), ["tree"]);
  } finally {
    mock.restoreAll();
    nodeFs.rmSync(root, { recursive: true, force: true });
  }
});

test("EXDEV move fallback cleans up a partial copy and keeps the source", async () => {
  const root = setup();
  const m = forceExdev();
  // the second file of the tree runs out of space after the first was copied
  const realCopy = fsp.copyFile.bind(fsp);
  let n = 0;
  const c = mock.method(fsp, "copyFile", async (from: string, to: string, mode?: number) => {
    if (++n === 2) throw Object.assign(new Error("ENOSPC"), { code: "ENOSPC" });
    return realCopy(from, to, mode);
  });
  try {
    await assert.rejects(ops.rename(root, "/src/tree", "/dst/tree"), /ENOSPC/);
    assert.deepEqual(nodeFs.readdirSync(path.join(root, "dst")), []);
    assert.equal(nodeFs.readFileSync(path.join(root, "src/tree/sub/b.txt"), "utf8"), "b");
  } finally {
    c.mock.restore();
    mock.restoreAll();
    nodeFs.rmSync(root, { recursive: true, force: true });
  }
});
