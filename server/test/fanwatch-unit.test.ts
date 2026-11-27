import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

/**
 * The helper's event code with hand-made kernel events (fanwatch-unit.c): no kernel, no capability. It is built with AddressSanitizer when the compiler has
 * it, so a read past the end of a record fails the test. Needs a C compiler.
 */
const here = import.meta.dirname;
const work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "filedeck-fanunit-")));
after(() => fs.rmSync(work, { recursive: true, force: true }));
const bin = path.join(work, "unit");
const srcDir = process.env.FILEDECK_FANWATCH_SRC_OVERRIDE; // (a check of an older helper: the file to include)
const args = ["-O1", "-g", "-Wall", "-o", bin, path.join(here, "fanwatch-unit.c"), ...(srcDir ? [`-DFANWATCH_SRC="${srcDir}"`] : [`-DFANWATCH_SRC="${path.resolve(here, "../native/filedeck-fanwatch.c")}"`])];
let cc = spawnSync("cc", ["-fsanitize=address", ...args], { encoding: "utf8" });
const asan = cc.status === 0;
if (!asan) cc = spawnSync("cc", args, { encoding: "utf8" });
const skip = cc.status !== 0 ? "helper cannot run here: no C compiler" : false;

function run(scenario: string, dir = "/work") {
  const r = spawnSync(bin, [scenario, dir], { encoding: "utf8", env: { ...process.env, LD_PRELOAD: "", ASAN_OPTIONS: "detect_leaks=0" } });
  assert.equal(r.status, 0, `${scenario}: ${r.stderr}`);
  return r.stdout.split("\n").filter(Boolean);
}

test("helper events: a merged create/delete/modify event is reported in the order that the entry's end state allows", { skip }, () => {
  const d = fs.mkdtempSync(path.join(work, "d-"));
  // the entry is gone: it was created, changed, closed and deleted
  assert.deepEqual(run("merged", d), [`C f ${d}/f`, `A f ${d}/f`, `M f ${d}/f`, `W f ${d}/f`, `D f ${d}/f`]);
  // the entry exists: it was deleted, then created and changed
  fs.writeFileSync(path.join(d, "f"), "x");
  assert.deepEqual(run("merged", d), [`D f ${d}/f`, `C f ${d}/f`, `A f ${d}/f`, `M f ${d}/f`, `W f ${d}/f`]);
  // no create in the event: the delete is last
  assert.deepEqual(run("modify-delete", d), [`M f ${d}/f`, `W f ${d}/f`, `D f ${d}/f`]);
});

test("helper events: an overflow drops the path cache (the next event looks its folder up again)", { skip }, () => {
  const out = run("overflow");
  assert.ok(out.includes("!overflow"));
  const stats = out.find((l) => l.startsWith("#stats"))!;
  assert.match(stats, /hits=1 misses=1 /, stats);
});

test("helper events: a held modify report is made under the old name before the rename line", { skip }, () => {
  assert.deepEqual(run("rename-held", "/work"), ["M f /work/a", "M f /work/a", "R f /work/b\t/work/a"]);
});

test("helper events: a record that is shorter than its handle, or a name without an end, is ignored and never read past", { skip }, () => {
  assert.deepEqual(run("short-handle"), ["C f /work/ok"]);
  assert.deepEqual(run("name-no-nul"), ["C f /work/ok"]);
});
