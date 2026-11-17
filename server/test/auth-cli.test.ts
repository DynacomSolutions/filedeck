import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

const run = (input: string) =>
  spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", "hash-password"], { input, encoding: "utf8" });

test("hash-password prints a hash for a piped line", () => {
  const r = run("pw\n");
  assert.equal(r.status, 0);
  assert.match(r.stdout, /^scrypt\$15\$8\$1\$\S+\n$/);
});

test("hash-password refuses an empty password", () => {
  const r = run("");
  assert.equal(r.status, 2);
  assert.match(r.stderr, /empty/);
  assert.equal(r.stdout, "");
});
