import assert from "node:assert/strict";
import test from "node:test";
import { rangeBetween, singleFlight } from "../src/compareModel.ts";
import { parsePresets, sanitizeOpts } from "../src/comparePresets.ts";
import { pickedForPlan, planSync, type PlanRow } from "../src/folderSync.ts";
import { DEFAULT_UI } from "../src/urlState.ts";

const file = (s = 1) => ({ t: "file" as const, s, m: 1 });
const dir = { t: "dir" as const, s: 0, m: 1 };

test("Shift range keeps growing from the anchor", () => {
  const order = ["a", "b", "c", "d", "e"];
  // anchor stays on "b" while the cursor moves down, then back up past it
  assert.deepEqual(rangeBetween(order, "b", "c"), ["b", "c"]);
  assert.deepEqual(rangeBetween(order, "b", "e"), ["b", "c", "d", "e"]);
  assert.deepEqual(rangeBetween(order, "b", "a"), ["a", "b"]);
  assert.equal(rangeBetween(order, null, "c"), null);
  assert.equal(rangeBetween(order, "zz", "c"), null);
});

test("a second call while the first is pending is ignored", async () => {
  const flight = singleFlight();
  let runs = 0;
  let release!: () => void;
  const first = flight(() => new Promise<void>((r) => ((runs++, (release = r)))));
  assert.equal(flight(async () => void runs++), undefined);
  release();
  await first;
  await flight(async () => void runs++);
  assert.equal(runs, 2);
});

/** left: dir "d" (left-only? no: different) with an identical file and a differing file */
const rows: PlanRow[] = [
  { p: "d", status: "different", l: dir, r: dir },
  { p: "d/same.txt", status: "identical", l: file(), r: file() },
  { p: "d/diff.txt", status: "different", l: file(2), r: file(3) },
  { p: "only", status: "left-only", l: dir },
  { p: "only/x.txt", status: "left-only", l: file() },
];

test("Select differing then delete left keeps identical files inside a differing folder", () => {
  const chosen = ["d", "d/diff.txt", "only", "only/x.txt"];
  const exact = planSync(rows, pickedForPlan(rows, chosen, true), "delete-left", { wholeDirs: true });
  const trashed = exact.steps.filter((s) => s.op === "trash").map((s) => (s as { rel: string }).rel);
  assert.deepEqual(trashed.sort(), ["d/diff.txt", "only"]);
});

test("a hand-picked folder still takes everything below it", () => {
  const plan = planSync(rows, pickedForPlan(rows, ["d"], false), "delete-left", { wholeDirs: true });
  assert.deepEqual(plan.steps.filter((s) => s.op === "trash").map((s) => (s as { rel: string }).rel), ["d"]);
});

test("presets from storage are validated, whatever was stored", () => {
  assert.deepEqual(parsePresets(null), {});
  assert.deepEqual(parsePresets("not json"), {});
  assert.deepEqual(parsePresets("[1]"), {});
  const p = parsePresets(JSON.stringify({ ok: { mode: "size", include: 5, depth: 9999, toleranceSec: "x" }, bad: 7, nul: null }));
  assert.deepEqual(Object.keys(p), ["ok"]);
  assert.equal(p.ok!.mode, "size");
  assert.equal(p.ok!.include, "");
  assert.equal(p.ok!.depth, 256);
  assert.equal(p.ok!.toleranceSec, DEFAULT_UI.toleranceSec);
  assert.deepEqual(sanitizeOpts("junk"), DEFAULT_UI);
  assert.equal(sanitizeOpts({ mode: "weird" }).mode, DEFAULT_UI.mode);
  assert.deepEqual(Object.keys(parsePresets('{"__proto__":{"mode":"size"}}')), []);
});
