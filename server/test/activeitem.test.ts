import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeState, encodeState, leaves, type Leaf } from "../../web/src/urlState.ts";

test("each panel and tab keeps its own active item, selection and closed preview in ?s=", () => {
  const a: Leaf = { kind: "leaf", id: "p1", node: "n", path: "/a", sel: "/a/x.txt", ns: true, sels: ["/a/y", "/a/z"] };
  const b: Leaf = {
    kind: "leaf",
    id: "p2",
    node: "n",
    path: "/b",
    sel: "/b/img.png",
    tabs: [
      { node: "n", path: "/b" },
      { node: "n", path: "/c", sel: "/c/doc.md", closed: "/c/doc.md" },
      { node: "n", path: "/d", sel: "/d/q", ns: true, sels: ["/d/q", "/d/r"] },
    ],
    ti: 0,
  };
  const url = encodeState({ tree: { kind: "split", id: "p3", dir: "horizontal", children: [a, b] }, active: "p2" });
  const back = leaves(decodeState(url)!.tree);
  assert.equal(back[0]!.sel, "/a/x.txt");
  assert.equal(back[0]!.ns, true);
  assert.deepEqual(back[0]!.sels, ["/a/y", "/a/z"]);
  assert.equal(back[1]!.sel, "/b/img.png");
  assert.equal(back[1]!.ns, undefined);
  assert.deepEqual(back[1]!.tabs![1], { node: "n", path: "/c", sel: "/c/doc.md", closed: "/c/doc.md" });
  assert.deepEqual(back[1]!.tabs![2], { node: "n", path: "/d", sel: "/d/q", ns: true, sels: ["/d/q", "/d/r"] });
});

test("an old link with only a single selection still restores it as active and selected", () => {
  const w = { t: { i: "p1", n: "n", p: "/a", s: "/a/f" }, a: "p1" };
  const l = leaves(decodeState("?s=" + encodeURIComponent(JSON.stringify(w)))!.tree)[0]!;
  assert.equal(l.sel, "/a/f");
  assert.equal(l.ns, undefined);
});
