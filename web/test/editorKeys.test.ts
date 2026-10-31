import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { isSelectAllKey, selectAllGoesToEditor, selectAllInEditor } from "../src/editorKeys.ts";

const key = (k: string, m: Partial<{ ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean }> = {}) => ({ key: k, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...m });
const target = (hit: boolean) => ({ closest: () => (hit ? {} : null) }) as unknown as Element;

test("Ctrl+A and Cmd+A (either case) are select-all, other chords are not", () => {
  assert.ok(isSelectAllKey(key("a", { ctrlKey: true })));
  assert.ok(isSelectAllKey(key("A", { metaKey: true })));
  assert.ok(!isSelectAllKey(key("a")));
  assert.ok(!isSelectAllKey(key("a", { ctrlKey: true, shiftKey: true })));
  assert.ok(!isSelectAllKey(key("a", { ctrlKey: true, altKey: true })));
  assert.ok(!isSelectAllKey(key("s", { ctrlKey: true })));
});

test("select-all on editor chrome goes to the editor; inputs and Monaco keep their own", () => {
  assert.ok(selectAllGoesToEditor(key("a", { ctrlKey: true }), target(false)));
  assert.ok(selectAllGoesToEditor(key("a", { ctrlKey: true }), null));
  assert.ok(!selectAllGoesToEditor(key("a", { ctrlKey: true }), target(true)));
  assert.ok(!selectAllGoesToEditor(key("b", { ctrlKey: true }), target(false)));
});

test("the select-all action focuses the editor then runs Monaco's selectAll", () => {
  const calls: string[] = [];
  const ed = { focus: () => calls.push("focus"), trigger: (_s: string, id: string) => calls.push(id) };
  assert.equal(selectAllInEditor(ed), true);
  assert.deepEqual(calls, ["focus", "editor.action.selectAll"]);
  assert.equal(selectAllInEditor(null), false);
});

test("the editor toolbar exposes a Select all button wired to the shared action", () => {
  const src = readFileSync(new URL("../src/EditorViews.tsx", import.meta.url), "utf8");
  assert.match(src, /aria-label="Select all"[^>]*onClick=\{\(\) => selectAllInEditor\(editorRef\.current\)\}/);
  assert.match(src, /onKeyDown=\{\(e\) => \{[\s\S]*?selectAllGoesToEditor\(e, e\.target as Element\)/);
});

test("the file list keeps ignoring keys from the editor and from text inputs", () => {
  const src = readFileSync(new URL("../src/FilePanel.tsx", import.meta.url), "utf8");
  assert.match(src, /t\.closest\('input,textarea,select,\[contenteditable=true\],\.monaco-editor,dialog,\[role="dialog"\]'\)\) return;/);
});
