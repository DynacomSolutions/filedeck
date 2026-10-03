import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeState, encodeState, type Tree } from "../../web/src/urlState.ts";

const tree: Tree = { kind: "leaf", id: "p1", node: "n", path: "/a" };

test("the settings view round-trips through ?s= and is absent by default", () => {
  const on = decodeState(encodeState({ tree, active: "p1", settings: true }));
  assert.equal(on?.settings, true);
  const off = decodeState(encodeState({ tree, active: "p1" }));
  assert.equal(off?.settings, undefined);
});

test("the side panel tab round-trips and old three-part links keep working", () => {
  const withTab: Tree = { kind: "leaf", id: "p1", node: "n", path: "/a", pv: { dock: "bottom", size: 33, tab: "props" } };
  const back = decodeState(encodeState({ tree: withTab, active: "p1" }));
  assert.deepEqual(back && back.tree.kind === "leaf" ? back.tree.pv : null, { dock: "bottom", size: 33, tab: "props" });
  const plain: Tree = { kind: "leaf", id: "p1", node: "n", path: "/a", pv: { dock: "left", size: 25 } };
  const p = decodeState(encodeState({ tree: plain, active: "p1" }));
  assert.deepEqual(p && p.tree.kind === "leaf" ? p.tree.pv : null, { dock: "left", size: 25 });
});
