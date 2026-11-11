import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_UI, MAX_URL_LENGTH, decodeState, encodeState, type AppState } from "../src/urlState.ts";

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

test("closed preview and the empty-preview flag round-trip", () => {
  const state: AppState = {
    tree: { kind: "leaf", id: "p1", node: "n", path: "/w", closed: "/w/a.txt", pe: true, pv: { dock: "right", size: 40 } },
    active: "p1",
  };
  const restored = decodeState(encodeState(state));
  assert.equal(restored?.tree.kind === "leaf" && restored.tree.pe, true);
  assert.equal(restored?.tree.kind === "leaf" && restored.tree.closed, "/w/a.txt");
  const plain = decodeState(encodeState({ tree: { kind: "leaf", id: "p1", node: "n", path: "/w" }, active: "p1" }));
  assert.equal(plain?.tree.kind === "leaf" && plain.tree.pe, undefined);
});

test("a long selection or sync plan never makes the URL too long to reload", () => {
  const names = Array.from({ length: 100 }, (_, i) => `${"n".repeat(200)}-${i}`);
  const paths = Array.from({ length: 500 }, (_, i) => `/very/deep/${"d".repeat(150)}/file-${i}.bin`);
  const state: AppState = {
    tree: { kind: "split", id: "p3", dir: "horizontal", children: [{ kind: "leaf", id: "p1", node: "node-a", path: "/work", sels: names, sel: names[0] }, { kind: "leaf", id: "p2", node: "node-a", path: "/other" }] },
    active: "p1",
    folder: { left: { node: "node-a", path: "/a" }, right: { node: "node-a", path: "/b" }, preset: "", lp: "p1", rp: "p2", rel: "", hide: [], opts: { ...DEFAULT_UI } },
    sync: { action: "copy-lr", paths },
  };
  const url = encodeState(state);
  assert.ok(url.length <= MAX_URL_LENGTH, `url is ${url.length} long`);
  const back = decodeState(url);
  assert.equal(back?.tree.kind, "split");
  if (back?.tree.kind === "split") assert.equal((back.tree.children[0] as { sel?: string }).sel, names[0]);
  assert.equal(back?.sync, undefined);
});

test("a short sync plan and selection stay in the URL", () => {
  const state: AppState = {
    tree: { kind: "split", id: "p3", dir: "horizontal", children: [{ kind: "leaf", id: "p1", node: "node-a", path: "/work", sels: ["a", "b"], sel: "a" }, { kind: "leaf", id: "p2", node: "node-a", path: "/other" }] },
    active: "p1",
    folder: { left: { node: "node-a", path: "/a" }, right: { node: "node-a", path: "/b" }, preset: "", lp: "p1", rp: "p2", rel: "", hide: [], opts: { ...DEFAULT_UI } },
    sync: { action: "copy-lr", paths: ["x"] },
  };
  const back = decodeState(encodeState(state));
  assert.deepEqual(back?.sync, state.sync);
  assert.equal(back?.tree.kind, "split");
  if (back?.tree.kind === "split") assert.deepEqual((back.tree.children[0] as { sels?: string[] }).sels, ["a", "b"]);
});
