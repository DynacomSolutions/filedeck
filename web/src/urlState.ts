// No imports: this module is pure so the server tests can exercise it directly.
export interface FileRef {
  node: string;
  path: string;
}
export type Loc = FileRef;
export type DiffMode = "name" | "size" | "mtime" | "content" | "quick";

export type Dock = "left" | "right" | "top" | "bottom";
export type SortKey = "name" | "size" | "mtime";

export type SearchMode = "name" | "glob" | "regex";
export type SearchTypes = "all" | "file" | "dir";
/** Search form of a panel; its presence means the results view is open. */
export interface SearchForm {
  q: string;
  mode: SearchMode;
  /** ignore case in the name match */
  ic: boolean;
  content: string;
  /** the content text is a regular expression */
  cre: boolean;
  /** ignore case in the content match */
  cic: boolean;
  types: SearchTypes;
}
export const EMPTY_SEARCH: SearchForm = { q: "", mode: "name", ic: true, content: "", cre: false, cic: true, types: "all" };

/** One file-browser panel. Everything here is mirrored into the URL. */
export interface Leaf {
  kind: "leaf";
  id: string;
  node: string;
  path: string;
  /** the single selected entry (path), when exactly one is selected */
  sel?: string;
  /** every selected path when several are selected here (capped; a selection can also span several panels) */
  sels?: string[];
  sort?: { key: SortKey; asc: boolean };
  hidden?: boolean;
  /** preview sub-panel placement and size (percent of the panel) */
  pv?: { dock: Dock; size: number };
  /** path whose preview the user closed */
  closed?: string;
  /** file open in the panel's editor */
  edit?: FileRef;
  /** name filter (Ctrl+F) */
  q?: string;
  /** open search (under this panel's folder) */
  sr?: SearchForm;
  /** view mode: absent = list, "g" = thumbnail grid */
  w?: "g";
  /** tabs (every tab's folder, in order); absent = a single location. `node`/`path` above are always the active tab's. */
  tabs?: Loc[];
  /** index of the active tab in `tabs` */
  ti?: number;
}
export type Tree = Leaf | { kind: "split"; id: string; dir: "horizontal" | "vertical"; children: Tree[]; sizes?: number[] };

/** Folder-diff options as edited in the UI (tolerance in seconds). */
export interface UiOpts {
  mode: DiffMode;
  toleranceSec: number;
  ignoreCase: boolean;
  ignoreHidden: boolean;
  include: string;
  exclude: string;
  depth: number;
  maxEntries: number;
}
export const DEFAULT_UI: UiOpts = {
  mode: "quick",
  toleranceSec: 2,
  ignoreCase: false,
  ignoreHidden: false,
  include: "",
  exclude: "",
  depth: 32,
  maxEntries: 250000,
};
export const FOLDER_MODES: DiffMode[] = ["name", "size", "mtime", "quick", "content"];
/** An open folder diff: both folders, the options and the preset they came from. */
export interface FolderState {
  left: Loc;
  right: Loc;
  opts: UiOpts;
  preset: string;
  /** panels showing the left and right side while the compare is open in place */
  lp: string;
  rp: string;
  /** folder (relative to both roots) the two panels currently show; "" = the roots */
  rel: string;
  /** status filters switched off */
  hide: DiffStatus[];
}
export type DiffStatus = "identical" | "different" | "left-only" | "right-only" | "error";
export const DIFF_STATUSES: DiffStatus[] = ["identical", "different", "left-only", "right-only", "error"];
/** Most paths of a multi-selection kept per panel in the URL. */
export const MAX_SELS = 100;

/** Open trash browser: the node and the volume ("" = first volume with items). */
export interface TrashState {
  node: string;
  volume: string;
}

export interface AppState {
  tree: Tree;
  active: string;
  trash?: TrashState;
  diff?: { left: FileRef; right: FileRef };
  folder?: FolderState;
  /** panels picked as a whole (Shift/Ctrl+click on the panel header) */
  panelSel?: string[];
}

// Compact wire format (short keys keep shared links readable).
type WLeaf = { i: string; n: string; p: string; s?: string; m?: string[]; o?: string; h?: 1; v?: [string, number]; c?: string; e?: [string, string]; q?: string; z?: WSearch; w?: "g"; tb?: [string, string][]; ti?: number };
type WSearch = { q?: string; m?: string; s?: 1; c?: string; r?: 1; k?: 1; t?: string };
type WSplit = { i: string; d: "h" | "v"; k: WTree[]; z?: number[] };
type WTree = WLeaf | WSplit;
interface Wire {
  t: WTree;
  a: string;
  f?: [[string, string], [string, string]];
  /** trash browser: node, volume */
  r?: [string, string];
  /** panels selected as a whole */
  ps?: string[];
  /** folder compare: l/r roots, a/b panel ids, u current relative folder, f hidden statuses, then only the options that differ from the defaults */
  g?: { l: [string, string]; r: [string, string]; a: string; b: string; u?: string; f?: string; m?: string; t?: number; c?: 1; h?: 1; i?: string; x?: string; d?: number; n?: number; p?: string };
}

const toWire = (t: Tree): WTree => {
  if (t.kind === "split") return { i: t.id, d: t.dir === "horizontal" ? "h" : "v", k: t.children.map(toWire), ...(t.sizes ? { z: t.sizes.map((x) => Math.round(x * 10) / 10) } : {}) };
  const w: WLeaf = { i: t.id, n: t.node, p: t.path };
  if (t.sel) w.s = t.sel;
  else if (t.sels && t.sels.length > 1) w.m = t.sels.slice(0, MAX_SELS);
  if (t.sort && (t.sort.key !== "name" || !t.sort.asc)) w.o = `${t.sort.key}:${t.sort.asc ? "a" : "d"}`;
  if (t.hidden) w.h = 1;
  if (t.pv) w.v = [t.pv.dock, Math.round(t.pv.size * 10) / 10];
  if (t.closed) w.c = t.closed;
  if (t.edit) w.e = [t.edit.node, t.edit.path];
  if (t.q) w.q = t.q;
  if (t.w === "g") w.w = "g";
  if (t.tabs && t.tabs.length > 1) {
    w.tb = t.tabs.map((x) => [x.node, x.path]);
    if (t.ti) w.ti = t.ti;
  }
  if (t.sr) {
    const z: WSearch = {};
    if (t.sr.q) z.q = t.sr.q;
    if (t.sr.mode !== "name") z.m = t.sr.mode;
    if (!t.sr.ic) z.s = 1;
    if (t.sr.content) z.c = t.sr.content;
    if (t.sr.cre) z.r = 1;
    if (!t.sr.cic) z.k = 1;
    if (t.sr.types !== "all") z.t = t.sr.types;
    w.z = z;
  }
  return w;
};

export function encodeState(s: AppState): string {
  const w: Wire = { t: toWire(s.tree), a: s.active };
  if (s.trash) w.r = [s.trash.node, s.trash.volume];
  if (s.panelSel?.length) w.ps = s.panelSel;
  if (s.diff) w.f = [[s.diff.left.node, s.diff.left.path], [s.diff.right.node, s.diff.right.path]];
  if (s.folder) {
    const { left, right, opts: o, preset, lp, rp, rel, hide } = s.folder;
    const g: NonNullable<Wire["g"]> = { l: [left.node, left.path], r: [right.node, right.path], a: lp, b: rp };
    if (rel) g.u = rel;
    if (hide.length) g.f = hide.join(",");
    if (o.mode !== DEFAULT_UI.mode) g.m = o.mode;
    if (o.toleranceSec !== DEFAULT_UI.toleranceSec) g.t = o.toleranceSec;
    if (o.ignoreCase) g.c = 1;
    if (o.ignoreHidden) g.h = 1;
    if (o.include) g.i = o.include;
    if (o.exclude) g.x = o.exclude;
    if (o.depth !== DEFAULT_UI.depth) g.d = o.depth;
    if (o.maxEntries !== DEFAULT_UI.maxEntries) g.n = o.maxEntries;
    if (preset) g.p = preset;
    w.g = g;
  }
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
  else if (Array.isArray(o.m) && o.m.length > 1 && o.m.length <= MAX_SELS && o.m.every(str)) leaf.sels = o.m as string[];
  if (str(o.o)) {
    const [key, dir] = o.o.split(":");
    if (key === "name" || key === "size" || key === "mtime") leaf.sort = { key, asc: dir !== "d" };
  }
  if (o.h === 1) leaf.hidden = true;
  if (Array.isArray(o.v) && DOCKS.includes(o.v[0] as string) && typeof o.v[1] === "number" && o.v[1] >= 10 && o.v[1] <= 90) leaf.pv = { dock: o.v[0] as Dock, size: o.v[1] };
  if (str(o.c)) leaf.closed = o.c;
  if (Array.isArray(o.e) && str(o.e[0]) && str(o.e[1])) leaf.edit = { node: o.e[0], path: o.e[1] };
  if (str(o.q) && o.q) leaf.q = o.q;
  if (o.w === "g") leaf.w = "g";
  if (Array.isArray(o.tb) && o.tb.length > 1 && o.tb.length <= MAX_TABS && o.tb.every((x) => Array.isArray(x) && str(x[0]) && str(x[1]) && x[1].startsWith("/"))) {
    leaf.tabs = (o.tb as [string, string][]).map(([node, path]) => ({ node, path }));
    leaf.ti = typeof o.ti === "number" && Number.isInteger(o.ti) && o.ti >= 0 && o.ti < leaf.tabs.length ? o.ti : 0;
    leaf.tabs[leaf.ti] = { node: leaf.node, path: leaf.path };
  }
  if (o.z && typeof o.z === "object") {
    const z = o.z as WSearch;
    leaf.sr = {
      q: str(z.q) ? z.q.slice(0, 200) : "",
      mode: z.m === "glob" || z.m === "regex" ? z.m : "name",
      ic: z.s !== 1,
      content: str(z.c) ? z.c.slice(0, 200) : "",
      cre: z.r === 1,
      cic: z.k !== 1,
      types: z.t === "file" || z.t === "dir" ? z.t : "all",
    };
  }
  return leaf;
};

export const MAX_TABS = 16;

/** Keeps `tabs[ti]` equal to the panel's own node/path (navigation edits the active tab in place). Same object when nothing changes. */
export function syncTabs(l: Leaf): Leaf {
  if (!l.tabs) return l;
  const ti = Math.min(Math.max(l.ti ?? 0, 0), l.tabs.length - 1);
  const cur = l.tabs[ti]!;
  if (cur.node === l.node && cur.path === l.path && ti === (l.ti ?? 0)) return l;
  const tabs = l.tabs.slice();
  tabs[ti] = { node: l.node, path: l.path };
  return { ...l, tabs, ti };
}
export function syncTree(t: Tree): Tree {
  if (t.kind === "leaf") return syncTabs(t);
  const kids = t.children.map(syncTree);
  return kids.every((k, i) => k === t.children[i]) ? t : { ...t, children: kids };
}

export function leaves(t: Tree): Leaf[] {
  return t.kind === "leaf" ? [t] : t.children.flatMap(leaves);
}

const pair = (x: unknown): x is [string, string] => Array.isArray(x) && str(x[0]) && str(x[1]) && x[1].startsWith("/");
function folderFromWire(g: unknown, ids: string[]): FolderState | null {
  const o = g as NonNullable<Wire["g"]> | undefined;
  if (!o || typeof o !== "object" || !pair(o.l) || !pair(o.r)) return null;
  if (!str(o.a) || !str(o.b) || o.a === o.b || !ids.includes(o.a) || !ids.includes(o.b)) return null;
  const num = (v: unknown, d: number, lo: number, hi: number) => (typeof v === "number" && Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : d);
  return {
    left: { node: o.l[0], path: o.l[1] },
    right: { node: o.r[0], path: o.r[1] },
    preset: str(o.p) ? o.p : "",
    lp: o.a,
    rp: o.b,
    rel: str(o.u) ? o.u.replace(/^\/+|\/+$/g, "") : "",
    hide: str(o.f) ? (o.f.split(",").filter((x) => DIFF_STATUSES.includes(x as DiffStatus)) as DiffStatus[]) : [],
    opts: {
      mode: FOLDER_MODES.includes(o.m as DiffMode) ? (o.m as DiffMode) : DEFAULT_UI.mode,
      toleranceSec: num(o.t, DEFAULT_UI.toleranceSec, 0, 86400),
      ignoreCase: o.c === 1,
      ignoreHidden: o.h === 1,
      include: str(o.i) ? o.i : "",
      exclude: str(o.x) ? o.x : "",
      depth: num(o.d, DEFAULT_UI.depth, 1, 64),
      maxEntries: num(o.n, DEFAULT_UI.maxEntries, 1, 500000),
    },
  };
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
    const r = w.r;
    const trash = Array.isArray(r) && str(r[0]) && typeof r[1] === "string" ? { node: r[0], volume: r[1] } : undefined;
    const folder = folderFromWire(w.g, ids);
    const panelSel = Array.isArray(w.ps) ? w.ps.filter((x) => str(x) && ids.includes(x)) : [];
    return { tree, active, ...(trash ? { trash } : {}), ...(diff ? { diff } : {}), ...(folder ? { folder } : {}), ...(panelSel.length ? { panelSel } : {}) };
  } catch {
    return null;
  }
}

/** Highest numeric panel id in a tree, so freshly created panels never collide. */
export const maxId = (t: Tree): number => (t.kind === "leaf" ? Number(t.id.slice(1)) : Math.max(Number(t.id.slice(1)), ...t.children.map(maxId)));
