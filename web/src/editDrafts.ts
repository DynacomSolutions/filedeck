// Unsaved editor text that survives the editor being unmounted and mounted again.
//
// The in-panel editor is remounted when its panel crosses the narrow breakpoint, when the window crosses the phone
// breakpoint, when another file is opened in the panel, when a compare starts, or when browser history restores an
// earlier layout. Every one of those used to drop the typed text without a prompt. The editor keeps its text here,
// keyed by node and path, and takes it back when the same file is opened again. No imports, so the tests run it directly.

export interface Draft {
  /** the text in the editor */
  text: string;
  /** the etag of the version on disk the text was typed against */
  etag: string;
}

const drafts = new Map<string, Draft>();
let guard: ((e: BeforeUnloadEvent) => void) | null = null;

export const draftKey = (node: string, path: string): string => `${node}\0${path}`;

/** The leave-the-page prompt applies while any unsaved text is held here, even when no editor is on screen. */
function syncGuard() {
  if (typeof window === "undefined") return;
  if (drafts.size && !guard) {
    guard = (e) => e.preventDefault();
    window.addEventListener("beforeunload", guard);
  } else if (!drafts.size && guard) {
    window.removeEventListener("beforeunload", guard);
    guard = null;
  }
}

export function getDraft(node: string, path: string): Draft | undefined {
  return drafts.get(draftKey(node, path));
}

export function setDraft(node: string, path: string, d: Draft): void {
  drafts.set(draftKey(node, path), d);
  syncGuard();
}

export function clearDraft(node: string, path: string): void {
  drafts.delete(draftKey(node, path));
  syncGuard();
}

export const draftCount = (): number => drafts.size;

/** Keep the draft in step with the editor: held while the text differs from what was saved, dropped when it matches. */
export function syncDraft(node: string, path: string, text: string, savedText: string, etag: string): void {
  if (text !== savedText) setDraft(node, path, { text, etag });
  else clearDraft(node, path);
}

const BOM = "﻿";

/**
 * Monaco takes a leading byte-order mark off the text and leaves it out of `getValue()`, so a file that started with one lost it on
 * the first save. The editor works on the text without it and puts it back when it writes.
 */
export function splitBom(content: string): { bom: boolean; text: string } {
  return content.startsWith(BOM) ? { bom: true, text: content.slice(1) } : { bom: false, text: content };
}

export const joinBom = (bom: boolean, text: string): string => (bom ? BOM + text : text);

/** A name typed for a new or renamed entry must be one plain path segment. Returns the reason it is not, or "". */
export function plainNameError(name: string): string {
  if (!name || name === "." || name === ".." || name.includes("/") || name.includes("\0")) return "Enter a plain name without slashes";
  return "";
}
