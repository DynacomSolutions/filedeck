// Small pure helpers for the file list's keyboard focus and screen reader semantics (no imports: the web tests run it directly).

/** What a row or tile is, for its accessible name (the icon is hidden from assistive technology). */
export function entryKind(e: { type: string; linkDir?: boolean | undefined }): "Folder" | "Link" | "File" {
  if (e.type === "dir" || e.linkDir) return "Folder";
  if (e.type === "symlink") return "Link";
  return "File";
}

/** id of the row at `index` in a panel's list (the panel's own prefix keeps ids unique across panels) */
export const rowId = (prefix: string, index: number): string => `${prefix}-r${index}`;

/**
 * Pixels to scroll so the row is fully visible below a sticky header (`headerH`, 0 when there is none).
 * `scrollIntoView({ block: "nearest" })` alone leaves a row at the top edge hidden under the header.
 * Negative = scroll up, positive = scroll down, 0 = already visible.
 */
export function revealDelta(rowTop: number, rowBottom: number, viewTop: number, viewBottom: number, headerH: number): number {
  const top = viewTop + headerH;
  if (rowTop < top) return rowTop - top;
  if (rowBottom > viewBottom) return Math.min(rowBottom - viewBottom, rowTop - top);
  return 0;
}

/** Bring a row into view inside its scroll container, clear of the sticky header. */
export function revealRow(scroller: HTMLElement, row: HTMLElement): void {
  const head = scroller.querySelector<HTMLElement>("thead");
  const s = scroller.getBoundingClientRect();
  const r = row.getBoundingClientRect();
  const delta = revealDelta(r.top, r.bottom, s.top, s.bottom, head ? head.getBoundingClientRect().height : 0);
  if (delta) scroller.scrollTop += delta;
}

/** The live-region text for the list: what is there once it has settled (empty while loading or streaming, so nothing chatters). */
export function listAnnouncement(o: { loading: boolean; streaming: boolean; total: number; shown: number; filtered: boolean; error: boolean }): string {
  if (o.loading || o.streaming || o.error) return "";
  if (o.total === 0) return "Empty folder";
  if (o.filtered) return o.shown === 0 ? "No entries match the filter" : `${o.shown.toLocaleString()} of ${o.total.toLocaleString()} entries match the filter`;
  return `${o.total.toLocaleString()} ${o.total === 1 ? "entry" : "entries"}`;
}
