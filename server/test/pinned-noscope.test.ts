import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as ops from "../src/fsops.ts";

// Not wrapped in a read-only scope on purpose: a caller that forgets the scope must be refused, not allowed.
let root: string;
before(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "filedeck-noscope-")));
  fs.mkdirSync(path.join(root, "d"));
});
after(() => fs.rmSync(root, { recursive: true, force: true }));

test("the pinned operations refuse to run outside a read-only scope", async () => {
  await assert.rejects(ops.mkdir(root, "/d/new"), /not run in a read-only scope/);
  assert.deepEqual(fs.readdirSync(path.join(root, "d")), []);
});
