import assert from "node:assert/strict";
import test from "node:test";
import { decodeState, encodeState, type AppState } from "../src/urlState.ts";

test("Git HEAD diff is restored with the panel URL state", () => {
  const state: AppState = {
    tree: {
      kind: "leaf",
      id: "p1",
      node: "node-a",
      path: "/work",
      gitDiff: { node: "node-a", path: "/work/src/main.ts", rev: "HEAD" },
    },
    active: "p1",
  };

  const restored = decodeState(encodeState(state));
  assert.deepEqual(restored?.tree, state.tree);
});

test("Git HEAD diff URL state rejects relative file paths", () => {
  const invalid = `?s=${encodeURIComponent(JSON.stringify({ t: { i: "p1", n: "node-a", p: "/work", gd: ["node-a", "src/main.ts"] }, a: "p1" }))}`;
  const restored = decodeState(invalid);

  assert.equal(restored?.tree.kind, "leaf");
  if (restored?.tree.kind === "leaf") assert.equal(restored.tree.gitDiff, undefined);
});

test("legacy worktrees side-panel URLs restore Properties on the Git tab", () => {
  const legacy = `?s=${encodeURIComponent(JSON.stringify({ t: { i: "p1", n: "node-a", p: "/work", v: ["right", 40, "w"] }, a: "p1" }))}`;
  const restored = decodeState(legacy);

  assert.equal(restored?.tree.kind, "leaf");
  if (restored?.tree.kind === "leaf") {
    assert.deepEqual(restored.tree.pv, { dock: "right", size: 40, tab: "props" });
    assert.equal(restored.tree.pt, "git");
  }
});
