import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

test("a change to the shared storage types selects server and web CI", (t) => {
  let workflow: string;
  try {
    workflow = readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return t.skip(".github/workflows/ci.yml is absent from this source tree");
    }
    throw error;
  }
  const body = workflow.match(/- id: detect\n +shell: bash\n +run: \|\n((?: {10}[^\n]*\n|\n)+)/)?.[1];
  assert.ok(body, "CI change detector must be a Bash step");
  const script = body.replace(/^ {10}/gm, "").replace(/\$\{\{[^}]+\}\}/g, "fixture");
  const dir = mkdtempSync(join(tmpdir(), "filedeck-ci-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const output = join(dir, "output");
  execFileSync("bash", ["-c",
    'git() { printf "%s\\n" server/src/group-types.ts; }\n' + script], {
    encoding: "utf8",
    env: { ...process.env, GITHUB_EVENT_NAME: "pull_request", GITHUB_OUTPUT: output },
  });
  assert.equal(readFileSync(output, "utf8"), "server=true\nweb=true\nchart=false\nimage=true\n");
});
