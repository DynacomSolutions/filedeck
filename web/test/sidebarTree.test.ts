import assert from "node:assert/strict";
import test from "node:test";
import { flatten, isOpen, navigate, parseExpanded, rovingId, setOpen, type TreeNodeBase } from "../src/sidebarTree.ts";

const tree: TreeNodeBase[] = [
  { id: "a", expandable: true, children: [{ id: "a1", expandable: true, children: [{ id: "a1x", expandable: false }] }, { id: "a2", expandable: false }] },
  { id: "b", expandable: true, children: [{ id: "b1", expandable: false }] },
];
const rows = (open: string[]) => flatten(tree, (n) => open.includes(n.id));

test("expand state: defaults, overrides and trimming", () => {
  assert.equal(isOpen({}, "sec", true), true);
  assert.equal(isOpen({ sec: false }, "sec", true), false);
  assert.deepEqual(setOpen({}, "x", true, false), { x: true });
  assert.deepEqual(setOpen({ x: true }, "x", false, false), {});
  assert.deepEqual(setOpen({}, "sec", true, true), {});
  let s = {};
  for (let i = 0; i < 500; i++) s = setOpen(s, "k" + i, true, false);
  assert.equal(Object.keys(s).length, 400);
  assert.ok("k499" in s && !("k0" in s));
});

test("parseExpanded tolerates junk", () => {
  assert.deepEqual(parseExpanded("nope"), {});
  assert.deepEqual(parseExpanded("[1]"), {});
  assert.deepEqual(parseExpanded('{"a":true,"b":1,"c":false}'), { a: true, c: false });
  assert.deepEqual(parseExpanded(null), {});
});

test("flatten shows children only under expanded rows", () => {
  assert.deepEqual(rows([]).map((r) => r.id), ["a", "b"]);
  const r = rows(["a", "a1"]);
  assert.deepEqual(r.map((x) => [x.id, x.level, x.parent]), [["a", 1, null], ["a1", 2, "a"], ["a1x", 3, "a1"], ["a2", 2, "a"], ["b", 1, null]]);
});

test("Up/Down/Home/End clamp at the ends", () => {
  const r = rows(["a"]);
  assert.deepEqual(navigate(r, "a", "ArrowDown"), { type: "focus", id: "a1" });
  assert.deepEqual(navigate(r, "b", "ArrowDown"), { type: "focus", id: "b" });
  assert.deepEqual(navigate(r, "a", "ArrowUp"), { type: "focus", id: "a" });
  assert.deepEqual(navigate(r, "a2", "ArrowUp"), { type: "focus", id: "a1" });
  assert.deepEqual(navigate(r, "a1", "End"), { type: "focus", id: "b" });
  assert.deepEqual(navigate(r, "b", "Home"), { type: "focus", id: "a" });
});

test("Right expands, then enters; Left collapses, then goes to the parent", () => {
  const closed = rows([]);
  assert.deepEqual(navigate(closed, "a", "ArrowRight"), { type: "expand", id: "a" });
  const open = rows(["a"]);
  assert.deepEqual(navigate(open, "a", "ArrowRight"), { type: "focus", id: "a1" });
  assert.equal(navigate(open, "a2", "ArrowRight"), null);
  assert.deepEqual(navigate(open, "a", "ArrowLeft"), { type: "collapse", id: "a" });
  assert.deepEqual(navigate(open, "a1", "ArrowLeft"), { type: "focus", id: "a" });
  assert.equal(navigate(open, "a", "ArrowLeft") && navigate(closed, "a", "ArrowLeft"), null);
  // an expandable row with no loaded children yet: Right on it does nothing further
  const empty = flatten([{ id: "z", expandable: true, children: [] }], () => true);
  assert.equal(navigate(empty, "z", "ArrowRight"), null);
});

test("Enter opens, Space toggles folders and opens leaves, other keys ignored", () => {
  const r = rows(["a"]);
  assert.deepEqual(navigate(r, "a2", "Enter"), { type: "open", id: "a2" });
  assert.deepEqual(navigate(r, "a", " "), { type: "toggle", id: "a" });
  assert.deepEqual(navigate(r, "a2", " "), { type: "open", id: "a2" });
  assert.equal(navigate(r, "a", "x"), null);
  assert.equal(navigate([], null, "ArrowDown"), null);
  assert.deepEqual(navigate(r, null, "ArrowDown"), { type: "focus", id: "a" });
});

test("rovingId falls back to the first visible row", () => {
  const r = rows([]);
  assert.equal(rovingId(r, "b"), "b");
  assert.equal(rovingId(r, "gone"), "a");
  assert.equal(rovingId([], "a"), null);
});
