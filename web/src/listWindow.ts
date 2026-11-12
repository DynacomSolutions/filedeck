// Which rows of a long folder listing are in the DOM (no imports: the web tests run it directly).
//
// A folder of tens of thousands of entries used to be rendered in growing steps and never trimmed, so scrolling to the end put every
// row in the DOM and each scroll step or click cost half a second or more. Only the rows near the viewport are rendered now; spacers
// above and below stand for the rest, so the scroll bar and the keyboard, selection and drag and drop work on the whole list.

/** Items rendered beyond each edge of the viewport, in rows of the list (rows of tiles in the grid view). */
export const OVERSCAN_ROWS = 20;
export const OVERSCAN_TILE_ROWS = 3;
/** The window moves in steps of this many rows, so a scroll re-renders every few rows rather than at every pixel. */
export const CHUNK_ROWS = 10;
export const CHUNK_TILE_ROWS = 1;

export interface Win {
  /** index of the first item rendered */
  first: number;
  /** one past the last item rendered */
  last: number;
}

export interface Geometry {
  /** distance from the top of the scrolled content to the first item */
  offset: number;
  /** distance from one row to the next (row height plus any gap) */
  pitch: number;
  /** items per row: 1 for the list, the number of tiles across in the grid */
  perRow: number;
}

export interface WindowOptions {
  overscan: number;
  chunk: number;
}

/** The items to render for a scroll position. Always a whole number of rows, and never empty while there are items. */
export function windowFor(total: number, scrollTop: number, viewH: number, g: Geometry, o: WindowOptions): Win {
  if (total <= 0) return { first: 0, last: 0 };
  const pitch = Math.max(1, g.pitch);
  const perRow = Math.max(1, g.perRow);
  const rows = Math.ceil(total / perRow);
  const firstVisible = Math.floor((scrollTop - g.offset) / pitch);
  const lastVisible = Math.ceil((scrollTop + viewH - g.offset) / pitch);
  const a = Math.max(0, Math.floor(Math.max(0, firstVisible - o.overscan) / o.chunk) * o.chunk);
  const b = Math.min(rows, Math.max(a + o.chunk, Math.ceil((lastVisible + o.overscan) / o.chunk) * o.chunk));
  return { first: Math.min(a, rows - 1) * perRow, last: Math.min(total, b * perRow) };
}

/**
 * The scroll position that shows item `index` (null when it is already in view). `edge` is the height of anything sticky over the top
 * of the scrolled area (the table header). `block: "center"` puts the item in the middle, "nearest" scrolls the least.
 */
export function scrollTopFor(index: number, scrollTop: number, viewH: number, g: Geometry, edge: number, block: "nearest" | "center", rowH = g.pitch): number | null {
  const row = Math.floor(index / Math.max(1, g.perRow));
  const top = g.offset + row * g.pitch;
  const bottom = top + rowH;
  if (block === "center") return Math.max(0, Math.round(top - (viewH + edge - rowH) / 2));
  if (top < scrollTop + edge) return Math.max(0, top - edge);
  if (bottom > scrollTop + viewH) return bottom - viewH;
  return null;
}

/** Height of the spacer standing in for `rows` rows that are not rendered; `gap` is the grid's row gap (0 for the list). */
export const spacerHeight = (rows: number, pitch: number, gap = 0): number => (rows > 0 ? Math.max(0, rows * pitch - gap) : 0);
