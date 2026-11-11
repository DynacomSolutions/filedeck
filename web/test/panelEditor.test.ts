import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { selectAllPaths } from "../src/panelSelection.ts";

const panel = readFileSync(new URL("../src/FilePanel.tsx", import.meta.url), "utf8");
const editors = readFileSync(new URL("../src/EditorViews.tsx", import.meta.url), "utf8");

test("select all takes the rows that are shown, not the files the filter hides", () => {
  assert.deepEqual(selectAllPaths([{ path: "/a" }, { path: "/b" }]), ["/a", "/b"]);
  assert.doesNotMatch(panel, /entries\.map\(\(x\) => x\.path\)/);
  assert.equal((panel.match(/selectAllPaths\(visible\)/g) ?? []).length, 3);
});

test("the panel listens through the shared change feed, not its own EventSource", () => {
  assert.doesNotMatch(panel, /new EventSource/);
  assert.match(panel, /changeHub\(\)\.subscribe\(node, path,/);
});

test("both editors keep unsaved text across a remount and leave the widget's value alone on save", () => {
  assert.equal((editors.match(/syncDraft\(/g) ?? []).length, 2);
  assert.equal((editors.match(/getDraft\(/g) ?? []).length, 2);
  assert.match(editors, /value=\{editorValue\}/);
  assert.match(editors, /modified=\{modValue\}/);
  assert.doesNotMatch(editors, /value=\{loaded\.content\}/);
  assert.doesNotMatch(editors, /modified=\{r\.content\}/);
  assert.match(editors, /joinBom\(bomRef\.current, /);
});

test("the filter bar shows whenever a filter is in force, and a new folder opens unfiltered", () => {
  assert.match(panel, /const filterShown = filterOpen \|\| !!filter;/);
  assert.match(panel, /\{filterShown && !cside && \(/);
  assert.match(panel, /if \(filter && \(n !== node \|\| p !== path\)\) \{\s*onPatch\(\{ q: undefined \}\);/);
});

test("renaming in the list refuses a name with a slash or a dot segment", () => {
  assert.match(panel, /plainNameError\(v\)/);
});
