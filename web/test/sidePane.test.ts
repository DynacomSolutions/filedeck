import { test } from "node:test";
import assert from "node:assert/strict";
import { isPreviewableEntry, sidePaneToggles, sidePaneView } from "../src/sidePane.ts";

const base = { editing: false, gitDiff: false, propsOpen: false, previewable: false, emptyOpen: false };

test("closed preview with a file selected shows nothing and the toggle is not pressed", () => {
  const v = sidePaneView(base);
  assert.equal(v, "none");
  assert.deepEqual(sidePaneToggles(v), { preview: false, props: false });
});

test("a previewable file shows the preview, pressed", () => {
  const v = sidePaneView({ ...base, previewable: true });
  assert.equal(v, "preview");
  assert.deepEqual(sidePaneToggles(v), { preview: true, props: false });
});

test("preview opened with nothing previewable shows the empty state, pressed", () => {
  const v = sidePaneView({ ...base, emptyOpen: true });
  assert.equal(v, "empty");
  assert.equal(sidePaneToggles(v).preview, true);
});

test("a previewable file wins over the empty flag", () => {
  assert.equal(sidePaneView({ ...base, previewable: true, emptyOpen: true }), "preview");
});

test("properties, editor and diff take precedence", () => {
  assert.equal(sidePaneView({ ...base, propsOpen: true, previewable: true }), "props");
  assert.deepEqual(sidePaneToggles("props"), { preview: false, props: true });
  assert.equal(sidePaneView({ ...base, editing: true, propsOpen: true }), "edit");
  assert.equal(sidePaneView({ ...base, gitDiff: true, previewable: true }), "diff");
  assert.deepEqual(sidePaneToggles("edit"), { preview: false, props: false });
});

test("previewable entries", () => {
  assert.equal(isPreviewableEntry({ type: "file" }), true);
  assert.equal(isPreviewableEntry({ type: "dir" }), false);
  assert.equal(isPreviewableEntry({ type: "file", linkDir: true }), false);
  assert.equal(isPreviewableEntry({ type: "file", broken: true }), false);
  assert.equal(isPreviewableEntry(undefined), false);
});
