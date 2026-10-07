/** What the side pane of a file panel shows. Pure, so the toolbar toggles and the pane agree on one answer. */
export type SidePaneView = "edit" | "diff" | "props" | "preview" | "empty" | "none";

export interface SidePaneInput {
  editing: boolean;
  gitDiff: boolean;
  /** the pane is on its Properties tab */
  propsOpen: boolean;
  /** a file is selected here and its preview has not been closed */
  previewable: boolean;
  /** the preview was opened with nothing previewable selected: show the empty state */
  emptyOpen: boolean;
}

export function sidePaneView(i: SidePaneInput): SidePaneView {
  if (i.editing) return "edit";
  if (i.gitDiff) return "diff";
  if (i.propsOpen) return "props";
  if (i.previewable) return "preview";
  return i.emptyOpen ? "empty" : "none";
}

/** Whether `entry` (the single active item) can be previewed: a plain file, not a folder, folder link or broken link. */
export function isPreviewableEntry(e: { type: string; linkDir?: boolean; broken?: boolean } | undefined | null): boolean {
  return !!e && e.type !== "dir" && !e.linkDir && !e.broken;
}

/** Toolbar pressed states derived from the view actually on screen. */
export function sidePaneToggles(view: SidePaneView): { preview: boolean; props: boolean } {
  return { preview: view === "preview" || view === "empty", props: view === "props" };
}
