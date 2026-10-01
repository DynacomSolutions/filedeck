import { test } from "node:test";
import assert from "node:assert/strict";
import { dockPanel, keyDock, pickZone } from "../../web/src/dock.ts";
import { leaves, type Leaf, type Tree } from "../../web/src/urlState.ts";

const L = (id: string, path = "/" + id): Leaf => ({ kind: "leaf", id, node: "n", path });
const split = (id: string, dir: "horizontal" | "vertical", ...children: Tree[]): Tree => ({ kind: "split", id, dir, children });
let n = 100;
const mk = () => `p${n++}`;
const shape = (t: Tree): string => (t.kind === "leaf" ? t.id : `${t.dir[0]}(${t.children.map(shape).join(",")})`);

test("pickZone: edges split, middle merges", () => {
  assert.equal(pickZone(0.5, 0.5), "center");
  assert.equal(pickZone(0.1, 0.5), "left");
  assert.equal(pickZone(0.9, 0.5), "right");
  assert.equal(pickZone(0.5, 0.05), "top");
  assert.equal(pickZone(0.5, 0.95), "bottom");
});

test("dock to each edge", () => {
  const t = split("p9", "horizontal", L("p1"), L("p2"));
  assert.equal(shape(dockPanel(t, "p1", "p2", "bottom", mk)!), "v(p2,p1)");
  assert.equal(shape(dockPanel(t, "p2", "p1", "top", mk)!), "v(p2,p1)");
  assert.equal(shape(dockPanel(split("p9", "vertical", L("p1"), L("p2")), "p1", "p2", "right", mk)!), "h(p2,p1)");
  const three = split("p9", "horizontal", L("p1"), L("p2"), L("p3"));
  assert.equal(shape(dockPanel(three, "p3", "p1", "left", mk)!), "h(p3,p1,p2)", "same direction flattens");
  assert.equal(shape(dockPanel(three, "p3", "p1", "bottom", mk)!), "h(v(p1,p3),p2)");
});

test("dock to centre merges into tabs and removes the source", () => {
  const t = split("p9", "horizontal", L("p1"), L("p2"));
  const m = dockPanel(t, "p1", "p2", "center", mk)!;
  assert.equal(m.kind, "leaf");
  const l = m as Leaf;
  assert.equal(l.id, "p2");
  assert.deepEqual(l.tabs, [{ node: "n", path: "/p2" }, { node: "n", path: "/p1" }]);
  assert.equal(l.ti, 1);
  assert.equal(l.path, "/p1");
  assert.equal(leaves(m).length, 1);
});

test("refuses self-drop, and merges past the tab limit", () => {
  const t = split("p9", "horizontal", L("p1"), L("p2"));
  assert.equal(dockPanel(t, "p1", "p1", "left", mk), null);
  const many = (k: number) => Array.from({ length: k }, (_, i) => ({ node: "n", path: "/t" + i }));
  const big = split("p9", "horizontal", { ...L("p1"), tabs: many(10) }, { ...L("p2"), tabs: many(10) });
  assert.equal(dockPanel(big, "p1", "p2", "center", mk), null);
});

test("stale split sizes are dropped when children change", () => {
  const t: Tree = { ...(split("p9", "horizontal", L("p1"), L("p2"), L("p3")) as Extract<Tree, { kind: "split" }>), sizes: [30, 30, 40] };
  const r = dockPanel(t, "p3", "p1", "bottom", mk)! as Extract<Tree, { kind: "split" }>;
  assert.equal(r.sizes, undefined);
});

test("keyboard dock targets the neighbour in layout order", () => {
  assert.deepEqual(keyDock(["p1", "p2", "p3"], "p2", "ArrowRight"), { target: "p3", zone: "right" });
  assert.deepEqual(keyDock(["p1", "p2", "p3"], "p2", "ArrowUp"), { target: "p1", zone: "top" });
  assert.equal(keyDock(["p1", "p2"], "p1", "ArrowLeft"), null);
});
