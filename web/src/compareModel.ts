// Pure model of an in-place folder compare: rows of one diff result, aligned by relative path.
// No imports (the server tests load it directly): these mirror DiffRow/DiffStatus in api.ts.
type DiffStatus = "identical" | "different" | "left-only" | "right-only" | "error";
/** "pending": the row is not final yet (its folder or hash is still being compared). */
type RowStatus = DiffStatus | "pending";
interface Side {
  t: "file" | "dir" | "symlink" | "other";
  s: number;
  m: number;
}
export interface DiffRow {
  p: string;
  rp?: string;
  status: RowStatus;
  /** folders: statuses found below (bits: identical 1, different 2, left-only 4, right-only 8, error 16) */
  mask?: number;
  /** folders: listed on both sides yet */
  listed?: boolean;
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
  /** placeholder row while a folder is still being listed */
  skel?: boolean;
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
      v = n.row.status === "pending" || !hide.has(n.row.status) || n.children.some(keep);
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

/* ---------- progressive compare: rows arrive folder by folder from the hub ---------- */

export const STATUS_BIT: Record<DiffStatus, number> = { identical: 1, different: 2, "left-only": 4, "right-only": 8, error: 16 };
export interface FolderData {
  listed: boolean;
  rows: DiffRow[];
}
const byName = (a: CNode, b: CNode) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name, undefined, { numeric: true });
/** One folder's rows as sorted nodes (folders first, natural name order). */
export function folderNodes(f: FolderData): CNode[] {
  return f.rows.map((row) => ({ row, name: nameOf(row.p), isDir: isDirRow(row), children: [] })).sort(byName);
}
/** A row stays when it is still pending, its status is shown, or (folders) anything shown was found below it. */
export function keepRow(row: DiffRow, hide: ReadonlySet<DiffStatus>): boolean {
  if (row.status === "pending" || !hide.has(row.status)) return true;
  if (!isDirRow(row) || !row.mask) return false;
  let shown = 0;
  for (const [s, b] of Object.entries(STATUS_BIT)) if (!hide.has(s as DiffStatus)) shown |= b;
  return (row.mask & shown) !== 0;
}
const skel = (at: string, i: number): CNode => ({ row: { p: `\u0000${at}\u0000${i}`, status: "pending" }, name: "", isDir: false, children: [], skel: true });
/**
 * Visible rows of a progressive compare: the folder's loaded rows plus, under every expanded folder, its own.
 * Folders not loaded or not listed yet show placeholder rows (several for the current folder, one when expanded).
 */
export function flattenFolders(folders: ReadonlyMap<string, FolderData>, rel: string, hide: ReadonlySet<DiffStatus>, expanded: ReadonlySet<string>): { n: CNode; depth: number }[] {
  const out: { n: CNode; depth: number }[] = [];
  const walk = (at: string, depth: number) => {
    const f = folders.get(at);
    const nodes = f ? folderNodes(f).filter((n) => keepRow(n.row, hide)) : [];
    for (const n of nodes) {
      out.push({ n, depth });
      if (n.isDir && expanded.has(n.row.p)) walk(n.row.p, depth + 1);
    }
    if (!f || !f.listed) for (let i = 0; i < (at === rel && !nodes.length ? 3 : 1); i++) out.push({ n: skel(at, i), depth });
  };
  walk(rel, 0);
  return out;
}
