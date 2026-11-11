import assert from "node:assert/strict";
import test from "node:test";
import { trashKey, type TrashNav } from "../src/trashNav.ts";

const ids = ["a", "b", "c", "d"];
const none: TrashNav = { focus: null, anchor: null, sel: new Set() };
const plain = { shift: false, mod: false };

test("a single trashed item can be selected with the keyboard", () => {
  const one = ["only"];
  assert.deepEqual([...trashKey(one, none, "ArrowDown", plain)!.sel], ["only"]);
  const sp = trashKey(one, { focus: "only", anchor: null, sel: new Set() }, " ", plain)!;
  assert.deepEqual([...sp.sel], ["only"]);
  assert.deepEqual([...trashKey(one, sp, " ", plain)!.sel], []);
});

test("arrows move focus and selection, Shift extends from the anchor", () => {
  let s = trashKey(ids, none, "ArrowDown", plain)!;
  assert.equal(s.focus, "a");
  s = trashKey(ids, s, "ArrowDown", plain)!;
  assert.deepEqual([...s.sel], ["b"]);
  s = trashKey(ids, s, "ArrowDown", { shift: true, mod: false })!;
  s = trashKey(ids, s, "ArrowDown", { shift: true, mod: false })!;
  assert.deepEqual([...s.sel], ["b", "c", "d"]);
  s = trashKey(ids, s, "ArrowUp", { shift: true, mod: false })!;
  assert.deepEqual([...s.sel], ["b", "c"]);
});

test("Ctrl+Arrow moves focus only, Ctrl+A selects all, other keys are not used", () => {
  const s0: TrashNav = { focus: "a", anchor: "a", sel: new Set(["a"]) };
  const s = trashKey(ids, s0, "ArrowDown", { shift: false, mod: true })!;
  assert.equal(s.focus, "b");
  assert.deepEqual([...s.sel], ["a"]);
  assert.equal(trashKey(ids, s0, "a", { shift: false, mod: true })!.sel.size, 4);
  assert.equal(trashKey(ids, s0, "a", plain), null);
  assert.equal(trashKey(ids, s0, "Enter", plain), null);
  assert.equal(trashKey([], none, "ArrowDown", plain), null);
});
