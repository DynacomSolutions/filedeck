import { useSyncExternalStore } from "react";

/** How the "go up one level" row at the top of a folder listing looks. */
export type UpRow = "dots" | "up" | "hidden";
export interface Settings {
  upRow: UpRow;
}
export const DEFAULT_SETTINGS: Settings = { upRow: "dots" };
export const UP_ROWS: { value: UpRow; label: string; help: string }[] = [
  { value: "dots", label: "Dots", help: "A row named .. at the top of every folder that has a parent" },
  { value: "up", label: "Up", help: "The same row, labelled Up" },
  { value: "hidden", label: "Hidden", help: "No parent row (Backspace and the Up button still go up)" },
];

const KEY = "filedeck.settings";

function load(): Settings {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "{}") as Partial<Settings>;
    return { upRow: v.upRow === "up" || v.upRow === "hidden" || v.upRow === "dots" ? v.upRow : DEFAULT_SETTINGS.upRow };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

let current: Settings = load();
const subs = new Set<() => void>();
const emit = () => subs.forEach((f) => f());

export function setSettings(patch: Partial<Settings>) {
  current = { ...current, ...patch };
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
