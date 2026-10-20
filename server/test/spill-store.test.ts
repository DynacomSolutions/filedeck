import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { IndexCache, spillPath } from "../src/index-cache.ts";
import { CompareSession } from "../src/cmp-engine.ts";
import { DEFAULT_OPTIONS, localSource } from "../src/folderdiff.ts";
import { localReader } from "../src/diff-routes.ts";

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "filedeck-spill-")));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test("fallback stores spill to a temp file that is removed on close", () => {
  const f = spillPath("test");
  assert.ok(f.startsWith(os.tmpdir()));
  const ix = new IndexCache(f, localReader());
  assert.ok(fs.existsSync(f));
  ix.close();
  assert.ok(!fs.existsSync(f));

  const g = spillPath("test");
  assert.notEqual(f, g);
  const s = new CompareSession(localSource(tmp, "/"), localSource(tmp, "/"), { ...DEFAULT_OPTIONS }, g);
  assert.ok(fs.existsSync(g));
  s.close();
  assert.ok(!fs.existsSync(g));
});
