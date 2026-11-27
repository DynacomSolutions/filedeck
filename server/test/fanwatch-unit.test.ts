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

function run(scenario: string, dir = "/work", dir2?: string) {
  const r = spawnSync(bin, [scenario, dir, ...(dir2 ? [dir2] : [])], { encoding: "utf8", env: { ...process.env, LD_PRELOAD: "", ASAN_OPTIONS: "detect_leaks=0" } });
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

/** What the helper writes for a create of "f" in a folder of the filesystem (`rel`), as lines, without the counters line. */
const created = (scenario: string, rel: string) => run(scenario, rel).filter((l) => !l.startsWith("#stats"));
const unresolved = (scenario: string, ...rels: string[]) => Number(/unresolved=(\d+)/.exec(run(scenario, ...(rels as [string, string?])).find((l) => l.startsWith("#stats")) ?? "")?.[1] ?? 0);

test("helper mounts: an entry is reported under every mount that shows it, the whole filesystem first, then the binds by the length of their root", { skip }, () => {
  // the mount of the whole filesystem, and binds of /repositories/.archives, /repositories/.data/o and /repositories/.data/o2
  assert.deepEqual(created("binds", "/repositories/.data/o/x"), ["C f /srv/p/repositories/.data/o/x/f", "C f /h/.data/o/x/f"]);
  assert.deepEqual(created("binds", "/repositories/.archives/deep/er"), ["C f /srv/p/repositories/.archives/deep/er/f", "C f /h/.archives/deep/er/f"]);
  // the root of a bind itself is shown by it
  assert.deepEqual(created("binds", "/repositories/.data/o"), ["C f /srv/p/repositories/.data/o/f", "C f /h/.data/o/f"]);
  // an entry that only the whole filesystem shows
  assert.deepEqual(created("binds", "/repositories/.data"), ["C f /srv/p/repositories/.data/f"]);
  assert.deepEqual(created("binds", "/"), ["C f /srv/p/f"]);
});

test("helper mounts: a root matches whole path segments only (.../o does not show .../o2)", { skip }, () => {
  assert.deepEqual(created("binds", "/repositories/.data/o2/y"), ["C f /srv/p/repositories/.data/o2/y/f", "C f /h/.data/o2/y/f"]);
  assert.deepEqual(created("binds", "/repositories/.data/o2x/y"), ["C f /srv/p/repositories/.data/o2x/y/f"]);
  assert.deepEqual(created("binds", "/repositories/.archivesX"), ["C f /srv/p/repositories/.archivesX/f"]);
});

test("helper mounts: with no mount of the whole filesystem, binds and a bind of a folder of a bind each show what is below their root", { skip }, () => {
  assert.deepEqual(created("binds-nobase", "/repositories/.data/a/b/c"), ["C f /m/a/b/c/f", "C f /m/ab/c/f"]);
  assert.deepEqual(created("binds-nobase", "/repositories/.data/a/other"), ["C f /m/a/other/f"]);
  assert.deepEqual(created("binds-nobase", "/repositories/.data/a/b"), ["C f /m/a/b/f", "C f /m/ab/f"]);
});

test("helper mounts: an entry that no mount shows is not reported and is counted as unresolved", { skip }, () => {
  for (const rel of ["/repositories/other", "/repositories/.data/ab/c", "/repositories/.data", "/"]) assert.deepEqual(created("binds-nobase", rel), [], rel);
  assert.equal(unresolved("binds-nobase", "/repositories/other"), 1);
  assert.equal(unresolved("binds-nobase", "/repositories/.data/a/x"), 0);
});

test("helper mounts: a mount at / that shows a folder, next to a mount of the whole filesystem", { skip }, () => {
  assert.deepEqual(created("binds-top", "/x/a"), ["C f /all/x/a/f", "C f /a/f"]);
  assert.deepEqual(created("binds-top", "/x"), ["C f /all/x/f", "C f /f"]);
  assert.deepEqual(created("binds-top", "/xy"), ["C f /all/xy/f"]);
});

test("helper mounts: a move is R under a mount that shows both places, D under one that shows the old place only, C under one that shows the new place only", { skip }, () => {
  const move = (sc: string, a: string, b: string) => run(sc, a, b).filter((l) => !l.startsWith("#stats"));
  // between two folders that two different binds show
  assert.deepEqual(move("binds-move", "/repositories/.data/o/s", "/repositories/.data/o2"), [
    "R f /srv/p/repositories/.data/o2/g\t/srv/p/repositories/.data/o/s/f",
    "D f /h/.data/o/s/f",
    "C f /h/.data/o2/g",
  ]);
  // inside one bind: a move for the whole and for the bind, nothing for the others
  assert.deepEqual(move("binds-move", "/repositories/.data/o/s", "/repositories/.data/o/t"), ["R f /srv/p/repositories/.data/o/t/g\t/srv/p/repositories/.data/o/s/f", "R f /h/.data/o/t/g\t/h/.data/o/s/f"]);
  // out of a bind to a place only the whole shows
  assert.deepEqual(move("binds-move", "/repositories/.data/o/s", "/elsewhere"), ["R f /srv/p/elsewhere/g\t/srv/p/repositories/.data/o/s/f", "D f /h/.data/o/s/f"]);
  // binds only: out of a bind to a place no mount shows is a delete, into a bind from such a place a create
  assert.deepEqual(move("binds-move-only", "/repositories/.data/o/s", "/elsewhere"), ["D f /h/.data/o/s/f"]);
  assert.deepEqual(move("binds-move-only", "/elsewhere", "/repositories/.data/o/s"), ["C f /h/.data/o/s/g"]);
  // two places that no mount shows: no line, and one unresolved
  assert.deepEqual(move("binds-move-only", "/elsewhere", "/elsewhere2"), []);
  assert.equal(Number(/unresolved=(\d+)/.exec(run("binds-move-only", "/elsewhere", "/elsewhere2").find((l) => l.startsWith("#stats")) ?? "")?.[1]), 1);
});
