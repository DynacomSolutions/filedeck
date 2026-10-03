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
