// Pure model of an in-place folder compare: rows of one diff result, aligned by relative path.
// No imports (the server tests load it directly): these mirror DiffRow/DiffStatus in api.ts.
type DiffStatus = "identical" | "different" | "left-only" | "right-only" | "error";
interface Side {
  t: "file" | "dir" | "symlink" | "other";
  s: number;
  m: number;
}
export interface DiffRow {
  p: string;
  rp?: string;
  status: DiffStatus;
  l?: Side;
  r?: Side;
  newer?: "left" | "right";
  why?: string;
}

export interface CNode {
  row: DiffRow;
  name: string;
  isDir: boolean;
  children: CNode[];
}
export interface CIndex {
  roots: CNode[];
  byPath: Map<string, CNode>;
  /** right side's spelling (ignore-case matches) back to the shared path */
  byRight: Map<string, string>;
}
const nameOf = (p: string) => p.slice(p.lastIndexOf("/") + 1);
export const isDirRow = (r: DiffRow) => (r.l?.t ?? r.r?.t) === "dir";

/** Index the flat result rows into a tree (dirs first, then natural name order) keyed by relative path. */
export function buildIndex(rows: DiffRow[]): CIndex {
  const byPath = new Map<string, CNode>();
  for (const row of rows) byPath.set(row.p, { row, name: nameOf(row.p), isDir: isDirRow(row), children: [] });
  const byRight = new Map<string, string>();
  for (const row of rows) if (row.rp && row.rp !== row.p) byRight.set(row.rp, row.p);
  const roots: CNode[] = [];
  for (const n of byPath.values()) {
    const i = n.row.p.lastIndexOf("/");
    const parent = i > 0 ? byPath.get(n.row.p.slice(0, i)) : undefined;
    (parent ? parent.children : roots).push(n);
  }
  const sort = (list: CNode[]) => {
    list.sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name, undefined, { numeric: true }));
    for (const n of list) sort(n.children);
  };
  sort(roots);
  return { roots, byPath, byRight };
}

/** Rows shown for one folder (`rel` "" = the roots): an entry stays when its status is shown or anything below it is. */
export function listFolder(idx: CIndex, rel: string, hide: ReadonlySet<DiffStatus>): CNode[] {
  const list = rel ? (idx.byPath.get(rel)?.children ?? []) : idx.roots;
  const memo = new Map<CNode, boolean>();
  const keep = (n: CNode): boolean => {
    let v = memo.get(n);
    if (v === undefined) {
      v = !hide.has(n.row.status) || n.children.some(keep);
      memo.set(n, v);
    }
    return v;
  };
  return list.filter(keep);
}

/** The visible rows with their nesting depth: the folder's rows plus, under every expanded folder, its own rows. */
export function flatten(idx: CIndex, rel: string, hide: ReadonlySet<DiffStatus>, expanded: ReadonlySet<string>): { n: CNode; depth: number }[] {
  const out: { n: CNode; depth: number }[] = [];
  const walk = (at: string, depth: number) => {
    for (const n of listFolder(idx, at, hide)) {
      out.push({ n, depth });
      if (n.isDir && expanded.has(n.row.p)) walk(n.row.p, depth + 1);
    }
  };
  walk(rel, 0);
  return out;
}

/** Every path under (and including) a row, so selecting a folder selects what is inside it. */
export function withDescendants(n: CNode, out: string[] = []): string[] {
  out.push(n.row.p);
  for (const c of n.children) withDescendants(c, out);
  return out;
}

/** Relative folder of an absolute panel path under its compare root; null when the path is outside the root. */
export function relUnder(root: string, path: string): string | null {
  const r = root.replace(/\/+$/, "");
  if (path === root || path === r || (r === "" && path === "/")) return "";
  if (r === "") return path.replace(/^\/+/, "");
  return path.startsWith(r + "/") ? path.slice(r.length + 1) : null;
}
export const joinRoot = (root: string, rel: string) => (rel ? (root === "/" ? "" : root.replace(/\/+$/, "")) + "/" + rel : root);

/** The right panel's spelling of a shared relative folder (differs only when names match ignoring case). */
export const rightRel = (idx: CIndex | null, rel: string) => (rel && idx ? (idx.byPath.get(rel)?.row.rp ?? rel) : rel);
/** The shared relative folder for a right-panel relative folder. */
export const sharedRel = (idx: CIndex | null, rightSpelling: string) => idx?.byRight.get(rightSpelling) ?? rightSpelling;
