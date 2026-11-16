import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resetNoReplace } from "../src/noreplace.ts";

/**
 * Builds the no-replace rename helper (server/native/filedeck-rename.c) with `cc` into a temporary folder and returns its path,
 * or null with the reason when there is no compiler. `FILEDECK_REQUIRE_SANDBOX=1` (the image build and CI, which have gcc) makes
 * a missing compiler an error, so the tests that need the helper run there and never skip.
 */
export function buildRenameHelper(): { bin: string | null; dir: string; why: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "filedeck-rename-"));
  const bin = path.join(dir, "filedeck-rename");
  const src = path.resolve(import.meta.dirname, "../native/filedeck-rename.c");
  const tries = ["cc", "gcc"].map((c) => spawnSync(c, ["-O2", "-Wall", "-o", bin, src], { encoding: "utf8" }));
  const cc = tries.find((t) => t.status === 0);
  if (cc) return { bin, dir, why: "" };
  const why = `rename helper: skipped (no C compiler: ${tries[0]!.error?.message ?? tries[0]!.stderr.trim().split("\n")[0]})`;
  if (process.env.FILEDECK_REQUIRE_SANDBOX) throw new Error(`the rename helper is required but was not built: ${why}`);
  return { bin: null, dir, why };
}

/** Use `helper` as the rename helper from now on (a path that does not exist means "no helper"). */
export function useRenameHelper(helper: string): void {
  process.env.FILEDECK_RENAME_HELPER = helper;
  resetNoReplace();
}

/**
 * No rename helper: a folder is placed with Node's own rename. For the tests that stand in for another device, or for something
 * that appears at the destination, by making Node's `rename` or `link` fail: with the helper a folder is not placed by those calls.
 */
export function noRenameHelper(): void {
  useRenameHelper(path.join(os.tmpdir(), "filedeck-no-rename-helper", "missing"));
}
