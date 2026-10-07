// Pure model of the selection that spans panels (no imports, so the web tests can run it directly).
//
// A "selected panel" is a panel that takes part in a multi-panel action (compare, copy to the other one...).
// It works like ordinary multi-select:
//   - plain click on an item        -> single selection in that panel, every other panel is deselected
//   - Shift+click                   -> a range inside the focused panel; the panel set is left alone
//   - Ctrl/Cmd+click on an item     -> the item is toggled and its panel joins the set (together with every
//                                      panel that already holds selected items); toggling the last item off
//                                      removes the panel again
//   - keyboard (Alt+P, panel menu)  -> toggles the focused panel without needing an item

export type ClickKind = "plain" | "range" | "toggle";

/** Panels selected after a click on an item. `holding` = panels that currently hold selected items. */
export function panelsAfterClick(current: readonly string[], holding: readonly string[], clicked: string, kind: ClickKind, stillSelectedHere = true): string[] {
  if (kind === "plain") return [];
  if (kind === "range") return [...current];
  if (!stillSelectedHere) return current.filter((p) => p !== clicked);
  return unique([...current, ...holding, clicked]);
}

/** Keyboard / menu alternative: add the panel to the selection, or remove it when it is already there. */
export function togglePanelSelection(current: readonly string[], panel: string): string[] {
  return current.includes(panel) ? current.filter((p) => p !== panel) : [...current, panel];
}

/** Panels that no longer exist leave the selection. */
export function pruneMissing(current: readonly string[], existing: Iterable<string>): string[] {
  const ids = new Set(existing);
  return current.filter((p) => ids.has(p));
}

/** More than one selected panel enables the multi-panel actions in the global toolbar. */
export const isMultiPanel = (selected: readonly string[]): boolean => selected.length > 1;

/** Every unordered pair of selected panels, in layout order (a short list: compare needs exactly two). */
export function comparePairs(selected: readonly string[], layoutOrder: readonly string[]): [string, string][] {
  const ordered = layoutOrder.filter((id) => selected.includes(id));
  const out: [string, string][] = [];
  for (let i = 0; i < ordered.length; i++) for (let j = i + 1; j < ordered.length; j++) out.push([ordered[i]!, ordered[j]!]);
  return out;
}

const unique = (xs: string[]): string[] => [...new Set(xs)];
