import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const script = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../scripts/check-test-skips.mjs");
const gate = (...lines: string[]) => spawnSync(process.execPath, [script], { input: lines.join("\n") + "\n", encoding: "utf8" });

test("the skip gate accepts the listed skip texts as a whole", () => {
  const r = gate(
    "ok 1 - a # SKIP sandbox live: skipped (not running as root)",
    "ok 2 - b # SKIP git sandbox live: skipped (not running as root)",
    "ok 3 - smb live: skipped (FILEDECK_TEST_SMB not set) # SKIP",
    "ok 4 - c # SKIP sandbox live: skipped (x32 calls exist on x86-64 only)",
  );
  assert.equal(r.status, 0, r.stderr);
});

test("the skip gate refuses a text that only contains a listed text", () => {
  for (const text of [
    "not a sandbox live: skipped (not running as root)",
    "sandbox live: skipped (not running as root) and more",
    "sandbox live: skipped (Landlock is not usable here)",
  ]) {
    const r = gate(`ok 1 - a # SKIP ${text}`);
    assert.equal(r.status, 1, text);
  }
});
