import { test } from "node:test";
import assert from "node:assert/strict";
import { buildIndex, joinRoot, listFolder, relUnder, rightRel, sharedRel, withDescendants } from "../../web/src/compareModel.ts";
import { decodeState, encodeState, DEFAULT_UI, type Tree } from "../../web/src/urlState.ts";

const F = (s = 1, m = 0) => ({ t: "file" as const, s, m });
const D = { t: "dir" as const, s: 0, m: 0 };
const rows = [
  { p: "a.txt", status: "different" as const, l: F(5), r: F(7), newer: "right" as const },
  { p: "dir", status: "different" as const, l: D, r: D },
  { p: "dir/new.txt", status: "left-only" as const, l: F(3) },
  { p: "dir/same.txt", status: "identical" as const, l: F(), r: F() },
  { p: "docs", status: "identical" as const, l: D, r: D, rp: "Docs" },
  { p: "docs/x.md", status: "identical" as const, l: F(), r: F(), rp: "Docs/x.md" },
  { p: "only-r.txt", status: "right-only" as const, r: F(9) },
];

test("folders list first, then names; one folder at a time", () => {
  const idx = buildIndex(rows);
  assert.deepEqual(listFolder(idx, "", new Set()).map((n) => n.row.p), ["dir", "docs", "a.txt", "only-r.txt"]);
  assert.deepEqual(listFolder(idx, "dir", new Set()).map((n) => n.row.p), ["dir/new.txt", "dir/same.txt"]);
});

test("status filters keep a folder when something below it still shows", () => {
  const idx = buildIndex(rows);
  const hide = new Set(["identical", "different"] as const);
  assert.deepEqual(listFolder(idx, "", hide).map((n) => n.row.p), ["dir", "only-r.txt"]);
  assert.deepEqual(listFolder(idx, "dir", hide).map((n) => n.row.p), ["dir/new.txt"]);
  assert.deepEqual(listFolder(idx, "docs", hide), []);
});

test("selecting a folder takes everything inside", () => {
  const idx = buildIndex(rows);
  assert.deepEqual(withDescendants(idx.byPath.get("dir")!).sort(), ["dir", "dir/new.txt", "dir/same.txt"]);
});

test("panel paths map to and from the relative folder", () => {
  assert.equal(relUnder("/data", "/data"), "");
  assert.equal(relUnder("/data", "/data/a/b"), "a/b");
  assert.equal(relUnder("/data", "/database"), null);
  assert.equal(relUnder("/", "/x/y"), "x/y");
  assert.equal(joinRoot("/", "x/y"), "/x/y");
  assert.equal(joinRoot("/data/", "x"), "/data/x");
  assert.equal(joinRoot("/data", ""), "/data");
  const idx = buildIndex(rows);
  assert.equal(rightRel(idx, "docs"), "Docs");
  assert.equal(sharedRel(idx, "Docs"), "docs");
  assert.equal(rightRel(idx, "dir"), "dir");
});

test("compare state, multi selection and picked panels survive the URL", () => {
  const tree: Tree = {
    kind: "split",
    id: "p3",
    dir: "horizontal",
    children: [
      { kind: "leaf", id: "p1", node: "n1", path: "/a/dir", sels: ["/a/dir/x", "/a/dir/y"] },
      { kind: "leaf", id: "p2", node: "n2", path: "/b/dir" },
    ],
  };
  const url = encodeState({
    tree,
    active: "p1",
    panelSel: ["p1", "p2"],
    folder: { left: { node: "n1", path: "/a" }, right: { node: "n2", path: "/b" }, opts: { ...DEFAULT_UI, mode: "content" }, preset: "", lp: "p1", rp: "p2", rel: "dir", hide: ["identical"] },
  });
  const s = decodeState(url)!;
  assert.deepEqual(s.panelSel, ["p1", "p2"]);
  assert.equal(s.folder?.rel, "dir");
  assert.deepEqual(s.folder?.hide, ["identical"]);
  assert.equal(s.folder?.opts.mode, "content");
  assert.equal(s.folder?.lp, "p1");
  assert.deepEqual((s.tree as { children: { sels?: string[] }[] }).children[0]!.sels, ["/a/dir/x", "/a/dir/y"]);
  // a compare naming a panel that is not in the layout is dropped
  const bad = "?s=" + encodeURIComponent(decodeURIComponent(url.slice(3)).replace('"b":"p2"', '"b":"p9"'));
  assert.equal(decodeState(bad)?.folder, undefined);
});
