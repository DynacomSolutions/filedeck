import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeState, encodeState, type FolderState, type Tree } from "../../web/src/urlState.ts";

const tree: Tree = { kind: "leaf", id: "p1", node: "n", path: "/a" };

test("the settings view round-trips through ?s= and is absent by default", () => {
  const on = decodeState(encodeState({ tree, active: "p1", settings: true }));
  assert.equal(on?.settings, true);
  const off = decodeState(encodeState({ tree, active: "p1" }));
  assert.equal(off?.settings, undefined);
});

test("view overlays round-trip through copied URLs, including sync plans", () => {
  const left: Tree = { kind: "leaf", id: "p1", node: "left", path: "/source", sel: "/source/readme.md", sels: ["/source/readme.md", "/source/data.bin"] };
  const tree: Tree = { kind: "split", id: "p2", dir: "horizontal", children: [left, { kind: "leaf", id: "p3", node: "right", path: "/target" }] };
  const folder: FolderState = { left: { node: "left", path: "/source" }, right: { node: "right", path: "/target" }, opts: { mode: "name", toleranceSec: 0, ignoreCase: false, ignoreHidden: false, include: "", exclude: "", depth: 256 }, preset: "", lp: "p1", rp: "p3", rel: "", hide: [] };
  const state = decodeState(encodeState({ tree, active: "p1", panelSel: ["p1"], help: true, folder, sync: { action: "copy-lr", paths: ["docs/readme.md", "data.bin"] } }));
  assert.equal(state?.help, true);
  assert.deepEqual(state?.panelSel, ["p1"]);
  assert.deepEqual(state?.tree.kind === "split" ? state.tree.children[0] : null, left);
  assert.deepEqual(state?.sync, { action: "copy-lr", paths: ["docs/readme.md", "data.bin"] });
  assert.deepEqual(state?.folder, folder);
  const noCompare = decodeState(encodeState({ tree, active: "p1", sync: { action: "copy-lr", paths: ["readme.md"] } }));
  assert.equal(noCompare?.sync, undefined);
});

test("the side panel tab round-trips and old three-part links keep working", () => {
  const withTab: Tree = { kind: "leaf", id: "p1", node: "n", path: "/a", pv: { dock: "bottom", size: 33, tab: "props" } };
  const back = decodeState(encodeState({ tree: withTab, active: "p1" }));
  assert.deepEqual(back && back.tree.kind === "leaf" ? back.tree.pv : null, { dock: "bottom", size: 33, tab: "props" });
  const plain: Tree = { kind: "leaf", id: "p1", node: "n", path: "/a", pv: { dock: "left", size: 25 } };
  const p = decodeState(encodeState({ tree: plain, active: "p1" }));
  assert.deepEqual(p && p.tree.kind === "leaf" ? p.tree.pv : null, { dock: "left", size: 25 });
});
