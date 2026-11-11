// Keyboard model of the trash list: arrows move the focused row (selection follows, Shift extends the range
// from the anchor, Ctrl moves focus only), Space toggles the focused row, Ctrl+A selects everything.
import { rangeBetween } from "./compareModel";

export interface TrashNav {
  focus: string | null;
  anchor: string | null;
  sel: ReadonlySet<string>;
}

/** The next state for a key press, or null when the key is not a list key. */
export function trashKey(ids: readonly string[], s: TrashNav, key: string, o: { shift: boolean; mod: boolean }): TrashNav | null {
  if (!ids.length) return null;
  const at = s.focus === null ? -1 : ids.indexOf(s.focus);
  const to = (i: number): TrashNav => {
    const id = ids[Math.max(0, Math.min(ids.length - 1, i))] as string;
    if (o.mod && !o.shift) return { ...s, focus: id };
    if (o.shift) {
      const anchor = s.anchor !== null && ids.includes(s.anchor) ? s.anchor : (s.focus ?? id);
      return { focus: id, anchor, sel: new Set(rangeBetween(ids, anchor, id) ?? [id]) };
    }
    return { focus: id, anchor: id, sel: new Set([id]) };
  };
  switch (key) {
    case "ArrowDown":
      return to(at + 1);
    case "ArrowUp":
      return to(at < 0 ? 0 : at - 1);
    case "PageDown":
      return to(at + 10);
    case "PageUp":
      return to(at < 0 ? 0 : at - 10);
    case "Home":
      return to(0);
    case "End":
      return to(ids.length - 1);
    case " ": {
      const id = s.focus ?? ids[0]!;
      const sel = new Set(s.sel);
      sel.has(id) ? sel.delete(id) : sel.add(id);
      return { focus: id, anchor: id, sel };
    }
    case "a":
    case "A":
      return o.mod ? { ...s, focus: s.focus ?? ids[0]!, sel: new Set(ids) } : null;
    default:
      return null;
  }
}
