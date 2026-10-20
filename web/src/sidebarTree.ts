/** Pure state and keyboard logic for the sidebar tree (no React, no DOM). */

export const EXPANDED_KEY = "filedeck.sidebar.expanded";
const MAX_STORED = 400;

/** Explicit expanded/collapsed choices by row id. Absent = the row's default (top-level sections open, the rest closed). */
export type ExpandState = Record<string, boolean>;

export const isOpen = (state: ExpandState, id: string, defaultOpen: boolean): boolean => (id in state ? state[id]! : defaultOpen);

/** Record a choice. Choices equal to the default are dropped so the stored object stays small. */
export function setOpen(state: ExpandState, id: string, open: boolean, defaultOpen: boolean): ExpandState {
  const next: ExpandState = { ...state };
  delete next[id]; // re-insert last, so the oldest choices are the ones trimmed
  if (open !== defaultOpen) next[id] = open;
  const keys = Object.keys(next);
  if (keys.length > MAX_STORED) for (const k of keys.slice(0, keys.length - MAX_STORED)) delete next[k];
  return next;
}

/** Proper ancestors of an absolute path, root first: "/a/b/c" gives "/", "/a", "/a/b". */
export function ancestorPaths(path: string): string[] {
  const parts = path.split("/").filter(Boolean);
  if (!parts.length) return [];
  return ["/", ...parts.slice(0, -1).map((_, i) => "/" + parts.slice(0, i + 1).join("/"))];
}

/**
 * A row is open when the user opened it, or when it lies on the path to the current folder and the user has not
 * collapsed it since arriving there. The auto part is derived from the location, so it vanishes on navigation.
 */
export const shownOpen = (manual: boolean, auto: boolean, heldClosed: boolean): boolean => manual || (auto && !heldClosed);

/** Rows the user collapsed by hand while at `loc`; ignored (empty) once the location differs. */
export interface Held {
  loc: string;
  ids: string[];
}
export const heldIds = (h: Held, loc: string): string[] => (h.loc === loc ? h.ids : []);
export const hold = (h: Held, loc: string, id: string): Held => ({ loc, ids: [...heldIds(h, loc).filter((x) => x !== id), id] });

export function parseExpanded(raw: string | null): ExpandState {
  try {
    const v = JSON.parse(raw ?? "{}") as unknown;
    if (!v || typeof v !== "object" || Array.isArray(v)) return {};
    const out: ExpandState = {};
    for (const [k, x] of Object.entries(v)) if (typeof x === "boolean") out[k] = x;
    return out;
  } catch {
    return {};
  }
}

export interface TreeNodeBase {
  id: string;
  expandable: boolean;
  children?: TreeNodeBase[];
}

/** A run of single-open-child rows keeps its first HEAD rows and last TAIL rows; the middle becomes one row if it hides at least MIN_HIDDEN. */
export const ELIDE_HEAD = 1;
export const ELIDE_TAIL = 2;
export const ELIDE_MIN_HIDDEN = 2;

/**
 * Collapses long chains of open rows that each have exactly one open child (the path down to a deep current folder)
 * into head, one `make(head, hidden, tail)` row, then the tail. Heads in `revealed` stay whole. Returns copies; the input is untouched.
 */
export function elide<T extends TreeNodeBase>(roots: T[], open: (n: T) => boolean, revealed: ReadonlySet<string>, make: (head: T, hidden: T[], tail: T) => T): T[] {
  const openKids = (n: T): T[] => (n.expandable && open(n) ? ((n.children ?? []) as T[]).filter((c) => c.expandable && !!c.children?.length && open(c)) : []);
  const go = (n: T, whole: boolean): T => {
    const chain = [n];
    for (let k = openKids(n); k.length === 1; k = openKids(chain[chain.length - 1]!)) chain.push(k[0]!);
    const hidden = chain.slice(ELIDE_HEAD, chain.length - ELIDE_TAIL);
    if (!whole && !revealed.has(n.id) && hidden.length >= ELIDE_MIN_HIDDEN) {
      const tail = go(chain[chain.length - ELIDE_TAIL]!, true);
      return { ...n, children: [make(n, hidden, tail)] };
    }
    return n.children ? { ...n, children: (n.children as T[]).map((c) => go(c, c === chain[1] && (whole || revealed.has(n.id) || hidden.length < ELIDE_MIN_HIDDEN))) } : n;
  };
  return roots.map((r) => go(r, false));
}

/** One visible row, in display order. */
export interface FlatRow {
  id: string;
  parent: string | null;
  /** 1 for top-level rows (the aria-level convention) */
  level: number;
  expandable: boolean;
  expanded: boolean;
}

/** The rows currently on screen: children appear only beneath expanded rows. */
export function flatten(roots: TreeNodeBase[], expanded: (n: TreeNodeBase) => boolean): FlatRow[] {
  const out: FlatRow[] = [];
  const walk = (list: TreeNodeBase[], parent: string | null, level: number) => {
    for (const n of list) {
      const open = n.expandable && expanded(n);
      out.push({ id: n.id, parent, level, expandable: n.expandable, expanded: open });
      if (open && n.children) walk(n.children, n.id, level + 1);
    }
  };
  walk(roots, null, 1);
  return out;
}

export type NavAction = { type: "focus"; id: string } | { type: "expand"; id: string } | { type: "collapse"; id: string } | { type: "open"; id: string } | { type: "toggle"; id: string };

/**
 * WAI-ARIA tree keyboard model. Up/Down move, Home/End jump, Right expands a closed row or enters an open one,
 * Left collapses an open row or goes to the parent, Enter opens, Space toggles. Returns null for keys it ignores.
 */
export function navigate(rows: FlatRow[], current: string | null, key: string): NavAction | null {
  if (!rows.length) return null;
  const at = current === null ? -1 : rows.findIndex((r) => r.id === current);
  const row = at >= 0 ? rows[at]! : undefined;
  const focus = (i: number): NavAction => ({ type: "focus", id: rows[Math.max(0, Math.min(rows.length - 1, i))]!.id });
  switch (key) {
    case "ArrowDown":
      return focus(at + 1);
    case "ArrowUp":
      return focus(at < 0 ? 0 : at - 1);
    case "Home":
      return focus(0);
    case "End":
      return focus(rows.length - 1);
    case "ArrowRight":
      if (!row || !row.expandable) return null;
      if (!row.expanded) return { type: "expand", id: row.id };
      return rows[at + 1]?.parent === row.id ? { type: "focus", id: rows[at + 1]!.id } : null;
    case "ArrowLeft":
      if (!row) return null;
      if (row.expandable && row.expanded) return { type: "collapse", id: row.id };
      return row.parent !== null ? { type: "focus", id: row.parent } : null;
    case "Enter":
      return row ? { type: "open", id: row.id } : null;
    case " ":
      return row && row.expandable ? { type: "toggle", id: row.id } : row ? { type: "open", id: row.id } : null;
    default:
      return null;
  }
}

/** The id that should hold tabindex 0: the remembered one if still visible, else the first row. */
export const rovingId = (rows: FlatRow[], remembered: string | null): string | null => (remembered && rows.some((r) => r.id === remembered) ? remembered : (rows[0]?.id ?? null));

export interface Usage {
  used: number;
  total: number;
}

/** Whole-number share of `total` that is used, clamped to 0..100. */
export const usagePct = (u: Usage): number => (u.total > 0 ? Math.min(100, Math.max(0, Math.round((u.used / u.total) * 100))) : 0);

/**
 * A server's disk usage: the sum over its mounts, counting each device once (bind mounts repeat a device).
 * The percentage is then used/total of that server, the same basis as a single mount row. Null when nothing is known.
 */
export function serverUsage(mounts: readonly { device: string; total: number; used: number }[]): Usage | null {
  const seen = new Set<string>();
  const sum: Usage = { used: 0, total: 0 };
  for (const m of mounts) {
    if (!(m.total > 0) || seen.has(m.device)) continue;
    seen.add(m.device);
    sum.used += m.used;
    sum.total += m.total;
  }
  return sum.total > 0 ? sum : null;
}

/** A folder's size next to what it is measured against: its parent folder, or for a top folder under a mount the mount's used bytes. */
export interface FolderSize extends Usage {
  basis: "parent" | "mount";
}

/**
 * Sizes of the children in a depth-1 `du` answer for `parent`. `mountUsed` > 0 makes the mount's used bytes the whole
 * (top folders under a mount); otherwise the parent's own total is. Folders the store does not know are absent.
 */
export function folderSizes(entries: readonly { path: string; diskBytes: number }[], parent: string, mountUsed?: number): Record<string, FolderSize> {
  const own = entries.find((e) => e.path === parent)?.diskBytes;
  const whole = mountUsed && mountUsed > 0 ? mountUsed : own;
  const out: Record<string, FolderSize> = {};
  if (whole === undefined) return out;
  for (const e of entries) if (e.path !== parent) out[e.path] = { used: e.diskBytes, total: Math.max(whole, e.diskBytes), basis: mountUsed && mountUsed > 0 ? "mount" : "parent" };
  return out;
}
