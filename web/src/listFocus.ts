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

/**
 * Focus a panel's list once the panel exists. A split or a dock rebuilds panels, and the new panel measures itself and may
 * rebuild its layout once more a frame later, so the element can appear late and disappear again: keep putting focus back
 * on the list (only while the page body holds it, never taking it from another control) until it has stayed for a few frames.
 * Gives up after `tries` frames; returns a cancel function.
 */
export function focusPanelList(panelId: string, tries = 30): () => void {
  const opener = document.activeElement;
  let frame = 0;
  let steady = 0;
  const go = (left: number) => {
    const list = document.querySelector<HTMLElement>(`[data-fp="${CSS.escape(panelId)}"] .fp-scroll`);
    const held = document.activeElement;
    // free to take: nothing holds focus, or what held it when we started (or something since removed) still does
    const free = !held || held === document.body || held === opener || !held.isConnected;
    if (list && free) {
      list.focus({ preventScroll: true });
      steady = 0;
    } else if (list && held && list.contains(held)) {
      if (++steady >= 6) return;
    } else if (!free) return; // focus went to some other control: leave it there
    if (left > 0) frame = requestAnimationFrame(() => go(left - 1));
  };
  frame = requestAnimationFrame(() => go(tries));
  return () => cancelAnimationFrame(frame);
}

/** The live-region text for the list: what is there once it has settled (empty while loading or streaming, so nothing chatters). */
export function listAnnouncement(o: { loading: boolean; streaming: boolean; total: number; shown: number; filtered: boolean; error: boolean }): string {
  if (o.loading || o.streaming || o.error) return "";
  if (o.total === 0) return "Empty folder";
  if (o.filtered) return o.shown === 0 ? "No entries match the filter" : `${o.shown.toLocaleString()} of ${o.total.toLocaleString()} entries match the filter`;
  return `${o.total.toLocaleString()} ${o.total === 1 ? "entry" : "entries"}`;
}
