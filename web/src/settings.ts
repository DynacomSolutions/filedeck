import { useSyncExternalStore } from "react";
import type { Leaf, SortKey } from "./urlState.js";

/** How the "go up one level" row at the top of a folder listing looks. */
export type UpRow = "dots" | "up" | "hidden";
export type ViewMode = "list" | "grid";
export interface SortPreference {
  key: SortKey;
  asc: boolean;
}
export interface Settings {
  upRow: UpRow;
  showHidden: boolean;
  sort: SortPreference;
  view: ViewMode;
}
export const DEFAULT_SETTINGS: Settings = { upRow: "dots", showHidden: false, sort: { key: "name", asc: true }, view: "list" };
export const UP_ROWS: { value: UpRow; label: string; help: string }[] = [
  { value: "dots", label: "Dots", help: "A row named .. at the top of every folder that has a parent" },
  { value: "up", label: "Up", help: "The same row, labelled Up" },
  { value: "hidden", label: "Hidden", help: "No parent row (Backspace and the Up button still go up)" },
];

const KEY = "filedeck.settings";

export function normalizeSettings(value: unknown): Settings {
  const v = value && typeof value === "object" && !Array.isArray(value) ? value as Partial<Settings> : {};
  const sort = v.sort && typeof v.sort === "object" ? v.sort : undefined;
  return {
    upRow: v.upRow === "up" || v.upRow === "hidden" || v.upRow === "dots" ? v.upRow : DEFAULT_SETTINGS.upRow,
    showHidden: typeof v.showHidden === "boolean" ? v.showHidden : DEFAULT_SETTINGS.showHidden,
    sort: sort && (sort.key === "name" || sort.key === "size" || sort.key === "mtime") && typeof sort.asc === "boolean"
      ? { key: sort.key, asc: sort.asc }
      : DEFAULT_SETTINGS.sort,
    view: v.view === "grid" || v.view === "list" ? v.view : DEFAULT_SETTINGS.view,
  };
}

export function settingsFromStorage(value: string | null): Settings {
  try {
    return normalizeSettings(JSON.parse(value ?? "{}"));
  } catch {
    return { ...DEFAULT_SETTINGS, sort: { ...DEFAULT_SETTINGS.sort } };
  }
}

export function resolvePanelPreferences(settings: Settings, panel: Pick<Leaf, "hidden" | "sort" | "w">) {
  return {
    hidden: panel.hidden ?? settings.showHidden,
    sort: panel.sort ?? settings.sort,
    view: panel.w === "g" ? "grid" as const : panel.w === "l" ? "list" as const : settings.view,
  };
}

function load(): Settings {
  try {
    return settingsFromStorage(typeof localStorage === "undefined" ? null : localStorage.getItem(KEY));
  } catch {
    return { ...DEFAULT_SETTINGS, sort: { ...DEFAULT_SETTINGS.sort } };
  }
}

let current: Settings = load();
const subs = new Set<() => void>();
const emit = () => subs.forEach((f) => f());

export function setSettings(patch: Partial<Settings>) {
  current = normalizeSettings({ ...current, ...patch });
  try {
    localStorage.setItem(KEY, JSON.stringify(current));
  } catch {
    /* storage unavailable: the choice still applies for this page view */
  }
  emit();
}

if (typeof window !== "undefined") {
  // Another browser tab changed the settings.
  window.addEventListener("storage", (e) => {
    if (e.key === KEY || e.key === null) {
      current = load();
      emit();
    }
  });
}

const subscribe = (f: () => void) => {
  subs.add(f);
  return () => void subs.delete(f);
};
/** The current settings; re-renders on change (this tab or another). */
export const useSettings = (): Settings => useSyncExternalStore(subscribe, () => current);
