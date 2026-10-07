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
