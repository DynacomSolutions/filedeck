/** Key handling for the text editor chrome (toolbar and banners around Monaco). */

export interface KeyLike {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

export const isSelectAllKey = (e: KeyLike): boolean =>
  (e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "a";

const OWN_SELECTION = "input,textarea,select,[contenteditable=true],[contenteditable=''],.monaco-editor";

/**
 * Ctrl/Cmd+A pressed while the focus sits on editor chrome (a toolbar button, the dialog itself)
 * selects the editor text. Text inputs and Monaco keep their own select-all.
 */
export function selectAllGoesToEditor(e: KeyLike, target: Element | null): boolean {
  if (!isSelectAllKey(e)) return false;
  return !(target && target.closest(OWN_SELECTION));
}

/** The slice of the Monaco editor API the select-all action needs. */
export interface SelectAllEditor {
  focus(): void;
  trigger(source: string, handlerId: string, payload: unknown): void;
}

/** Focus the editor and select all of its text (the toolbar action and the keyboard route share this). */
export function selectAllInEditor(ed: SelectAllEditor | null): boolean {
  if (!ed) return false;
  ed.focus();
  ed.trigger("filedeck", "editor.action.selectAll", null);
  return true;
}
