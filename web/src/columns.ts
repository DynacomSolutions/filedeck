/** Column model for the details list: ids, width limits, visibility and persistence. Pure, so it is unit-tested. */
export type ColId = "name" | "type" | "size" | "mtime" | "mode";

export interface ColDef {
  id: ColId;
  label: string;
  min: number;
  max: number;
  def: number;
  /** sorting key understood by the panel, when the column can be sorted */
  sort?: "name" | "size" | "mtime";
  /** shown by default */
  on: boolean;
  align?: "end";
}

export const COLUMNS: readonly ColDef[] = [
  { id: "name", label: "Name", min: 160, max: 2000, def: 280, sort: "name", on: true },
  { id: "type", label: "Type", min: 70, max: 400, def: 110, on: false },
  { id: "size", label: "Size", min: 70, max: 400, def: 100, sort: "size", on: true, align: "end" },
  { id: "mtime", label: "Modified", min: 110, max: 400, def: 160, sort: "mtime", on: true },
  { id: "mode", label: "Permissions", min: 100, max: 400, def: 120, on: false },
];

export const COLUMN_KEY = "filedeck.columns";
export const KEY_STEP = 16;

export interface ColumnState {
  widths: Partial<Record<ColId, number>>;
  /** optional columns the user turned on or off, relative to the defaults */
  shown: Partial<Record<ColId, boolean>>;
}

export const EMPTY_COLUMNS: ColumnState = { widths: {}, shown: {} };

const byId = (id: ColId) => COLUMNS.find((c) => c.id === id)!;
const isId = (s: string): s is ColId => COLUMNS.some((c) => c.id === s);

export function clampWidth(id: ColId, w: number): number {
  const c = byId(id);
  if (!Number.isFinite(w)) return c.def;
  return Math.min(c.max, Math.max(c.min, Math.round(w)));
}

/** Tolerant parse: anything corrupt or unknown falls back to the defaults. Older saves (Name without a width) load as is: Name then takes its default width. */
export function parseColumns(raw: string | null | undefined): ColumnState {
  if (!raw) return EMPTY_COLUMNS;
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return EMPTY_COLUMNS;
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) return EMPTY_COLUMNS;
  const o = v as { widths?: unknown; shown?: unknown };
  const widths: ColumnState["widths"] = {};
  const shown: ColumnState["shown"] = {};
  if (o.widths && typeof o.widths === "object" && !Array.isArray(o.widths)) {
    for (const [k, w] of Object.entries(o.widths)) if (isId(k) && typeof w === "number" && Number.isFinite(w)) widths[k] = clampWidth(k, w);
  }
  if (o.shown && typeof o.shown === "object" && !Array.isArray(o.shown)) {
    for (const [k, b] of Object.entries(o.shown)) if (isId(k) && k !== "name" && typeof b === "boolean") shown[k] = b;
  }
  return { widths, shown };
}

export const serialiseColumns = (s: ColumnState) => JSON.stringify(s);

export const isShown = (s: ColumnState, id: ColId) => id === "name" || (s.shown[id] ?? byId(id).on);

/** Name can never be hidden: toggling it returns the state unchanged. */
export function toggleColumn(s: ColumnState, id: ColId): ColumnState {
  if (id === "name") return s;
  return { ...s, shown: { ...s.shown, [id]: !isShown(s, id) } };
}

export function setWidth(s: ColumnState, id: ColId, w: number): ColumnState {
  return { ...s, widths: { ...s.widths, [id]: clampWidth(id, w) } };
}

/** Forget the stored width so the column returns to its default. */
export function resetWidth(s: ColumnState, id: ColId): ColumnState {
  const { [id]: _drop, ...widths } = s.widths;
  return { ...s, widths };
}

export const widthOf = (s: ColumnState, id: ColId) => s.widths[id] ?? byId(id).def;

export const visibleColumns = (s: ColumnState): ColDef[] => COLUMNS.filter((c) => isShown(s, c.id));

export const resetColumns = (): ColumnState => EMPTY_COLUMNS;

export const isDefault = (s: ColumnState) => Object.keys(s.widths).length === 0 && Object.keys(s.shown).length === 0;

/** Sum of the visible column widths: the table is exactly this wide (or the panel width when that is larger, the rest staying empty). */
export const totalWidth = (s: ColumnState) => visibleColumns(s).reduce((n, c) => n + widthOf(s, c.id), 0);
