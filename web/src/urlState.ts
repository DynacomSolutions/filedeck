import type { FileRef } from "./EditorViews";

export type Dock = "left" | "right" | "top" | "bottom";
export type SortKey = "name" | "size" | "mtime";

/** One file-browser panel. Everything here is mirrored into the URL. */
export interface Leaf {
  kind: "leaf";
  id: string;
  node: string;
  path: string;
  /** the single selected entry (path), when exactly one is selected */
  sel?: string;
  sort?: { key: SortKey; asc: boolean };
  hidden?: boolean;
  /** preview sub-panel placement and size (percent of the panel) */
  pv?: { dock: Dock; size: number };
  /** path whose preview the user closed */
  closed?: string;
  /** file open in the panel's editor */
  edit?: FileRef;
}
export type Tree = Leaf | { kind: "split"; id: string; dir: "horizontal" | "vertical"; children: Tree[]; sizes?: number[] };

export interface AppState {
  tree: Tree;
  active: string;
  diff?: { left: FileRef; right: FileRef };
}

// Compact wire format (short keys keep shared links readable).
type WLeaf = { i: string; n: string; p: string; s?: string; o?: string; h?: 1; v?: [string, number]; c?: string; e?: [string, string] };
type WSplit = { i: string; d: "h" | "v"; k: WTree[]; z?: number[] };
type WTree = WLeaf | WSplit;
interface Wire {
  t: WTree;
  a: string;
  f?: [[string, string], [string, string]];
}

const toWire = (t: Tree): WTree => {
  if (t.kind === "split") return { i: t.id, d: t.dir === "horizontal" ? "h" : "v", k: t.children.map(toWire), ...(t.sizes ? { z: t.sizes.map((x) => Math.round(x * 10) / 10) } : {}) };
  const w: WLeaf = { i: t.id, n: t.node, p: t.path };
  if (t.sel) w.s = t.sel;
  if (t.sort && (t.sort.key !== "name" || !t.sort.asc)) w.o = `${t.sort.key}:${t.sort.asc ? "a" : "d"}`;
  if (t.hidden) w.h = 1;
  if (t.pv) w.v = [t.pv.dock, Math.round(t.pv.size * 10) / 10];
  if (t.closed) w.c = t.closed;
  if (t.edit) w.e = [t.edit.node, t.edit.path];
  return w;
};

export function encodeState(s: AppState): string {
  const w: Wire = { t: toWire(s.tree), a: s.active };
  if (s.diff) w.f = [[s.diff.left.node, s.diff.left.path], [s.diff.right.node, s.diff.right.path]];
  return "?s=" + encodeURIComponent(JSON.stringify(w));
}

const str = (x: unknown): x is string => typeof x === "string";
const DOCKS = ["left", "right", "top", "bottom"];

const fromWire = (w: unknown, depth = 0): Tree | null => {
  if (!w || typeof w !== "object" || depth > 8) return null;
  const o = w as Record<string, unknown>;
  if (!str(o.i) || !/^p\d+$/.test(o.i)) return null;
  if (Array.isArray(o.k)) {
    const children = o.k.map((c) => fromWire(c, depth + 1));
    if (children.length < 2 || children.some((c) => c === null)) return null;
    const sizes = Array.isArray(o.z) && o.z.length === children.length && o.z.every((x) => typeof x === "number" && x >= 0 && x <= 100) ? (o.z as number[]) : undefined;
    return { kind: "split", id: o.i, dir: o.d === "v" ? "vertical" : "horizontal", children: children as Tree[], ...(sizes ? { sizes } : {}) };
  }
  if (!str(o.n) || !str(o.p)) return null;
  const leaf: Leaf = { kind: "leaf", id: o.i, node: o.n, path: o.p };
  if (str(o.s)) leaf.sel = o.s;
  if (str(o.o)) {
    const [key, dir] = o.o.split(":");
    if (key === "name" || key === "size" || key === "mtime") leaf.sort = { key, asc: dir !== "d" };
  }
  if (o.h === 1) leaf.hidden = true;
  if (Array.isArray(o.v) && DOCKS.includes(o.v[0] as string) && typeof o.v[1] === "number" && o.v[1] >= 10 && o.v[1] <= 90) leaf.pv = { dock: o.v[0] as Dock, size: o.v[1] };
  if (str(o.c)) leaf.closed = o.c;
  if (Array.isArray(o.e) && str(o.e[0]) && str(o.e[1])) leaf.edit = { node: o.e[0], path: o.e[1] };
  return leaf;
};

export function leaves(t: Tree): Leaf[] {
  return t.kind === "leaf" ? [t] : t.children.flatMap(leaves);
}

/** Parse `?s=...`; null when absent or malformed (the app then starts fresh). */
export function decodeState(search: string): AppState | null {
  try {
    const raw = new URLSearchParams(search).get("s");
    if (!raw) return null;
    const w = JSON.parse(raw) as Wire;
    const tree = fromWire(w.t);
    if (!tree) return null;
    const ids = leaves(tree).map((l) => l.id);
    if (new Set(ids).size !== ids.length) return null;
    const active = str(w.a) && ids.includes(w.a) ? w.a : ids[0]!;
    const f = w.f;
    const diff =
      Array.isArray(f) && f.length === 2 && f.every((x) => Array.isArray(x) && str(x[0]) && str(x[1]))
        ? { left: { node: f[0][0], path: f[0][1] }, right: { node: f[1][0], path: f[1][1] } }
        : undefined;
    return { tree, active, ...(diff ? { diff } : {}) };
  } catch {
    return null;
  }
}

/** Highest numeric panel id in a tree, so freshly created panels never collide. */
export const maxId = (t: Tree): number => (t.kind === "leaf" ? Number(t.id.slice(1)) : Math.max(Number(t.id.slice(1)), ...t.children.map(maxId)));
