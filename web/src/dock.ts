// No imports beyond urlState: pure layout helpers (the drag-to-dock model), also exercised by the server tests.
import { MAX_TABS, syncTabs, type Leaf, type Tree } from "./urlState.ts";

export type DropZone = "top" | "bottom" | "left" | "right" | "center";
export const PANEL_MIME = "application/x-filedeck-panel";

/** Cursor position inside a panel (0..1 on each axis) to a drop zone: the outer 25% of each edge, the middle merges. */
export function pickZone(xFrac: number, yFrac: number): DropZone {
  const d = { top: yFrac, bottom: 1 - yFrac, left: xFrac, right: 1 - xFrac };
  const near = Math.min(d.top, d.bottom, d.left, d.right);
  if (near >= 0.25) return "center";
  return (["top", "bottom", "left", "right"] as const).find((k) => d[k] === near)!;
}

const dropSizes = (t: Tree): Tree => (t.kind === "split" && t.sizes && t.sizes.length !== t.children.length ? { ...t, sizes: undefined } : t);

const without = (t: Tree, id: string): Tree | null => {
  if (t.kind === "leaf") return t.id === id ? null : t;
  const kids = t.children.map((c) => without(c, id)).filter((c): c is Tree => c !== null);
  if (kids.length === 0) return null;
  if (kids.length === 1) return kids[0]!;
  return dropSizes({ ...t, children: kids });
};

/** A split holding the same orientation as its parent is flattened into it so repeated docking never nests needlessly. */
const place = (t: Tree, targetId: string, src: Leaf, zone: Exclude<DropZone, "center">, mkId: () => string): Tree => {
  const dir = zone === "left" || zone === "right" ? "horizontal" : "vertical";
  const before = zone === "left" || zone === "top";
  if (t.kind === "leaf") {
    if (t.id !== targetId) return t;
    return { kind: "split", id: mkId(), dir, children: before ? [src, t] : [t, src] };
  }
  const i = t.children.findIndex((c) => c.kind === "leaf" && c.id === targetId);
  if (i >= 0 && t.dir === dir) {
    const kids = t.children.slice();
    kids.splice(before ? i : i + 1, 0, src);
    return { ...t, children: kids, sizes: undefined };
  }
  return { ...t, children: t.children.map((c) => place(c, targetId, src, zone, mkId)) };
};

/** Move panel `srcId` next to (or, for `center`, into the tab strip of) panel `targetId`. Returns null when it is not possible. */
export function dockPanel(tree: Tree, srcId: string, targetId: string, zone: DropZone, mkId: () => string): Tree | null {
  if (srcId === targetId) return null;
  const find = (t: Tree, id: string): Leaf | null => (t.kind === "leaf" ? (t.id === id ? t : null) : t.children.reduce<Leaf | null>((a, c) => a ?? find(c, id), null));
  const src = find(tree, srcId);
  const dst = find(tree, targetId);
  if (!src || !dst) return null;
  const rest = without(tree, srcId);
  if (!rest) return null;
  if (zone === "center") {
    const sTabs = syncTabs(src).tabs ?? [{ node: src.node, path: src.path }];
    const dTabs = syncTabs(dst).tabs ?? [{ node: dst.node, path: dst.path }];
    if (dTabs.length + sTabs.length > MAX_TABS) return null;
    const tabs = [...dTabs, ...sTabs];
    const ti = dTabs.length + Math.min(src.ti ?? 0, sTabs.length - 1);
    const at = tabs[ti]!;
    const merge = (t: Tree): Tree => (t.kind === "leaf" ? (t.id === targetId ? { ...t, tabs, ti, node: at.node, path: at.path, sel: undefined, closed: undefined, sr: undefined, q: undefined } : t) : { ...t, children: t.children.map(merge) });
    return merge(rest);
  }
  return place(rest, targetId, src, zone, mkId);
}

/** Keyboard alternative: Alt+Shift+Arrow docks the panel on that side of the next/previous panel in layout order. */
export function keyDock(order: string[], srcId: string, key: string): { target: string; zone: DropZone } | null {
  const i = order.indexOf(srcId);
  const back = key === "ArrowLeft" || key === "ArrowUp";
  const t = order[i + (back ? -1 : 1)];
  if (i < 0 || !t) return null;
  const zone = ({ ArrowLeft: "left", ArrowRight: "right", ArrowUp: "top", ArrowDown: "bottom" } as Record<string, DropZone>)[key];
  return zone ? { target: t, zone } : null;
}
