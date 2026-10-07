import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeState, encodeState, leaves, type Leaf } from "../../web/src/urlState.ts";

test("each panel keeps its own active item, selection and closed preview in ?s=", () => {
  const a: Leaf = { kind: "leaf", id: "p1", node: "n", path: "/a", sel: "/a/x.txt", ns: true, sels: ["/a/y", "/a/z"] };
  const b: Leaf = {
    kind: "leaf",
    id: "p2",
    node: "n",
    path: "/b",
    sel: "/b/img.png",
  };
  const url = encodeState({ tree: { kind: "split", id: "p3", dir: "horizontal", children: [a, b] }, active: "p2" });
  const back = leaves(decodeState(url)!.tree);
  assert.equal(back[0]!.sel, "/a/x.txt");
  assert.equal(back[0]!.ns, true);
  assert.deepEqual(back[0]!.sels, ["/a/y", "/a/z"]);
  assert.equal(back[1]!.sel, "/b/img.png");
  assert.equal(back[1]!.ns, undefined);
});

test("an old link with only a single selection still restores it as active and selected", () => {
  const w = { t: { i: "p1", n: "n", p: "/a", s: "/a/f" }, a: "p1" };
  const l = leaves(decodeState("?s=" + encodeURIComponent(JSON.stringify(w)))!.tree)[0]!;
  assert.equal(l.sel, "/a/f");
  assert.equal(l.ns, undefined);
});

test("each panel keeps its selected Properties section in ?s=", () => {
  const a: Leaf = { kind: "leaf", id: "p1", node: "n", path: "/work", pv: { dock: "right", size: 40, tab: "props" }, pt: "git" };
  const b: Leaf = { kind: "leaf", id: "p2", node: "n", path: "/other", pt: "permissions" };
  const url = encodeState({ tree: { kind: "split", id: "p3", dir: "horizontal", children: [a, b] }, active: "p1" });
  const back = leaves(decodeState(url)!.tree);
  assert.equal(back[0]!.pt, "git");
  assert.equal(back[1]!.pt, "permissions");
  assert.equal(encodeState({ tree: back[0]!, active: "p1" }).includes('"pt":"details"'), false);
});

test("unknown Properties section values are ignored", () => {
  const w = { t: { i: "p1", n: "n", p: "/work", pt: "archive" }, a: "p1" };
  const l = leaves(decodeState("?s=" + encodeURIComponent(JSON.stringify(w)))!.tree)[0]!;
  assert.equal(l.pt, undefined);
});
