import assert from "node:assert/strict";
import test from "node:test";
import { comparePairs, isMultiPanel, panelsAfterClick, pruneMissing, togglePanelSelection } from "../src/panelSelection.ts";

test("a plain click resets to a single selection in that panel", () => {
  assert.deepEqual(panelsAfterClick(["p1", "p2"], ["p1", "p2"], "p2", "plain"), []);
});

test("Ctrl/Cmd+click in another panel selects that panel and every panel already holding items", () => {
  assert.deepEqual(panelsAfterClick([], ["p1"], "p2", "toggle"), ["p1", "p2"]);
  assert.deepEqual(panelsAfterClick(["p1", "p2"], ["p1", "p2"], "p3", "toggle"), ["p1", "p2", "p3"]);
});

test("Ctrl/Cmd+click inside an already selected panel does not duplicate it", () => {
  assert.deepEqual(panelsAfterClick(["p1", "p2"], ["p1", "p2"], "p2", "toggle"), ["p1", "p2"]);
});

test("toggling the last item off removes the panel from the selection", () => {
  assert.deepEqual(panelsAfterClick(["p1", "p2"], ["p1", "p2"], "p2", "toggle", false), ["p1"]);
});

test("Shift+click ranges within the panel and leaves the panel set alone", () => {
  assert.deepEqual(panelsAfterClick(["p1", "p2"], ["p1"], "p1", "range"), ["p1", "p2"]);
  assert.deepEqual(panelsAfterClick([], [], "p1", "range"), []);
});

test("the keyboard alternative toggles the focused panel", () => {
  assert.deepEqual(togglePanelSelection(["p1"], "p2"), ["p1", "p2"]);
  assert.deepEqual(togglePanelSelection(["p1", "p2"], "p1"), ["p2"]);
});

test("closed panels leave the selection", () => {
  assert.deepEqual(pruneMissing(["p1", "p2", "p3"], ["p1", "p3"]), ["p1", "p3"]);
});

test("multi-panel actions need more than one selected panel", () => {
  assert.equal(isMultiPanel([]), false);
  assert.equal(isMultiPanel(["p1"]), false);
  assert.equal(isMultiPanel(["p1", "p2"]), true);
});

test("compare pairs follow layout order", () => {
  assert.deepEqual(comparePairs(["p3", "p1"], ["p1", "p2", "p3"]), [["p1", "p3"]]);
  assert.deepEqual(comparePairs(["p1", "p2", "p3"], ["p3", "p2", "p1"]), [["p3", "p2"], ["p3", "p1"], ["p2", "p1"]]);
  assert.deepEqual(comparePairs(["p1"], ["p1", "p2"]), []);
});
