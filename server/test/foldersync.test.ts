import { test } from "node:test";
import assert from "node:assert/strict";
import { planSync, type PlanRow } from "../../web/src/folderSync.ts";

const F = (s = 1, m = 0) => ({ t: "file" as const, s, m });
const D = { t: "dir" as const, s: 0, m: 0 };
const rows: PlanRow[] = [
  { p: "a.txt", status: "different", l: F(5), r: F(7) },
  { p: "dir", status: "different", l: D, r: D },
  { p: "dir/new.txt", status: "left-only", l: F(3) },
  { p: "dir/same.txt", status: "identical", l: F(), r: F() },
  { p: "dir/old.txt", status: "right-only", r: F(9) },
  { p: "lonely", status: "left-only", l: D },
  { p: "lonely/x.txt", status: "left-only", l: F(4) },
  { p: "lnk", status: "left-only", l: { t: "symlink", s: 1, m: 0 } },
  { p: "mixed", status: "different", l: F(2), r: D },
];
const sel = (...p: string[]) => new Set(p);
const ops = (s: ReturnType<typeof planSync>) => s.steps.map((x) => (x.op === "copy" ? `copy ${x.srcRel}->${x.destDirRel || "/"}${x.replaces ? " (replace)" : ""}` : x.op === "skip" ? `skip ${x.rel}` : `${x.op} ${x.side} ${x.rel}`));

test("copy left to right: replace, create folders, skip links, ignore identical and wrong-side rows", () => {
  const p = planSync(rows, sel("a.txt", "dir", "dir/new.txt", "dir/same.txt", "dir/old.txt", "lonely", "lonely/x.txt", "lnk"), "copy-lr", { wholeDirs: true });
  assert.deepEqual(ops(p), [
    "copy a.txt->/ (replace)",
    "copy dir/new.txt->dir",
    "skip dir/old.txt",
    "mkdir right lonely",
    "copy lonely/x.txt->lonely",
    "skip lnk",
  ]);
  assert.equal(p.copies, 3);
  assert.equal(p.bytes, 5 + 3 + 4);
  assert.equal(p.skipped, 2);
});

test("copying a file into a folder that is missing on the target creates the parents first", () => {
  const p = planSync(rows, sel("lonely/x.txt"), "copy-lr", { wholeDirs: true });
  assert.deepEqual(ops(p), ["mkdir right lonely", "copy lonely/x.txt->lonely"]);
});

test("copy right to left, type mismatch trashes what is in the way", () => {
  const p = planSync(rows, sel("a.txt", "mixed"), "copy-rl", { wholeDirs: true });
  assert.deepEqual(ops(p), ["copy a.txt->/ (replace)", "trash left mixed", "mkdir left mixed"]);
  const q = planSync(rows, sel("mixed"), "copy-lr", { wholeDirs: true });
  assert.deepEqual(ops(q), ["trash right mixed", "copy mixed->/"]);
});

test("case-only spelling differences replace by trashing the old spelling", () => {
  const r: PlanRow[] = [{ p: "Case.TXT", rp: "case.txt", status: "different", l: F(1), r: F(2) }];
  assert.deepEqual(ops(planSync(r, sel("Case.TXT"), "copy-lr", { wholeDirs: true })), ["trash right case.txt", "copy Case.TXT->/"]);
  assert.deepEqual(ops(planSync(r, sel("Case.TXT"), "copy-rl", { wholeDirs: true })), ["trash left Case.TXT", "copy case.txt->/"]);
});

test("delete trashes a folder once, only when everything in it is selected", () => {
  const all = planSync(rows, sel("lonely", "lonely/x.txt"), "delete-left", { wholeDirs: true });
  assert.deepEqual(ops(all), ["trash left lonely"]);
  const partial = planSync(rows, sel("lonely"), "delete-left", { wholeDirs: true });
  assert.deepEqual(ops(partial), []); // child not selected: the folder stays
  const files = planSync(rows, sel("dir/old.txt", "a.txt"), "delete-right", { wholeDirs: true });
  assert.deepEqual(ops(files), ["trash right a.txt", "trash right dir/old.txt"]);
  assert.equal(files.copies, 0);
});

test("delete with filters active never trashes folders wholesale", () => {
  const p = planSync(rows, sel("lonely", "lonely/x.txt"), "delete-left", { wholeDirs: false });
  assert.deepEqual(ops(p), ["trash left lonely/x.txt"]);
  assert.equal(p.notes.length, 1);
});

import { DEFAULT_UI, decodeState, encodeState, type AppState, type Tree } from "../../web/src/urlState.ts";

test("folder diff state round-trips through the app URL and ignores junk", () => {
  const tree: Tree = { kind: "split", id: "p3", dir: "horizontal", children: [{ kind: "leaf", id: "p1", node: "node-a", path: "/a" }, { kind: "leaf", id: "p2", node: "node-c", path: "/b" }] };
  const opts = { ...DEFAULT_UI, mode: "content" as const, toleranceSec: 5, ignoreCase: true, exclude: "*.log, node_modules/", depth: 3 };
  const st: AppState = { tree, active: "p1", folder: { left: { node: "node-a", path: "/a" }, right: { node: "node-c", path: "/b" }, opts, preset: "dev", lp: "p1", rp: "p2", rel: "", hide: [] } };
  const back = decodeState(encodeState(st));
  assert.deepEqual(back?.folder, st.folder);
  // defaults are not written out
  assert.ok(!encodeState({ tree, active: "p1", folder: { ...st.folder!, opts: DEFAULT_UI, preset: "" } }).includes("%22m%22"));
  // malformed folder state is dropped, the rest of the state survives
  const bad = "?s=" + encodeURIComponent(JSON.stringify({ t: { i: "p1", n: "node-a", p: "/" }, a: "p1", g: { l: ["x", "nope"], r: ["y", "/b"], a: "p1", b: "p2" } }));
  assert.ok(decodeState(bad) && !decodeState(bad)?.folder);
  const clamped = decodeState("?s=" + encodeURIComponent(JSON.stringify({ t: { i: "p3", d: "h", k: [{ i: "p1", n: "node-a", p: "/" }, { i: "p2", n: "node-a", p: "/" }] }, a: "p1", g: { l: ["a", "/a"], r: ["b", "/b"], a: "p1", b: "p2", m: "bogus", d: 9999, n: -4 } })));
  assert.equal(clamped?.folder?.opts.mode, "quick");
  assert.equal(clamped?.folder?.opts.depth, 64);
  assert.equal(clamped?.folder?.opts.maxEntries, 1);
});
