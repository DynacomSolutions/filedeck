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

test("legacy tabbed panels collapse to their active tab", () => {
  const legacy = `?s=${encodeURIComponent(JSON.stringify({
    t: { i: "p1", n: "node-b", p: "/second", s: "/second/a.txt", tb: [["node-a", "/first"], ["node-b", "/second", { s: "/x" }], ["node-a", "/third"]], ti: 1 },
    a: "p1",
  }))}`;
  const restored = decodeState(legacy);
  assert.equal(restored?.tree.kind, "leaf");
  if (restored?.tree.kind === "leaf") {
    assert.equal(restored.tree.node, "node-b");
    assert.equal(restored.tree.path, "/second");
    assert.equal(restored.tree.sel, "/second/a.txt");
    assert.equal("tabs" in restored.tree, false);
    assert.equal("ti" in restored.tree, false);
  }
  assert.doesNotMatch(encodeState(restored!), /tb|"ti"/);
});

test("legacy pull request diff routes are ignored", () => {
  const legacy = `?s=${encodeURIComponent(JSON.stringify({ t: { i: "p1", n: "node-a", p: "/work" }, a: "p1", pd: { n: "node-a", p: "/work", r: 12 } }))}`;
  const restored = decodeState(legacy);
  assert.ok(restored);
  assert.equal("prDiff" in restored, false);
});

test("panel selection round-trips", () => {
  const state: AppState = { tree: { kind: "split", id: "p3", dir: "horizontal", children: [{ kind: "leaf", id: "p1", node: "a", path: "/" }, { kind: "leaf", id: "p2", node: "a", path: "/" }] }, active: "p1", panelSel: ["p1", "p2"] };
  assert.deepEqual(decodeState(encodeState(state))?.panelSel, ["p1", "p2"]);
});
