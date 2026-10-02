import type { Where } from "./address";

const KEY = "filedeck.recents";
const MAX = 30;

export function getRecents(): Where[] {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "[]") as unknown;
    return Array.isArray(v) ? v.filter((x): x is Where => !!x && typeof (x as Where).node === "string" && typeof (x as Where).path === "string") : [];
  } catch {
    return [];
  }
}

/** Remember a visited folder (most recent first, no duplicates). */
export function pushRecent(w: Where) {
  try {
    const next = [w, ...getRecents().filter((x) => x.node !== w.node || x.path !== w.path)].slice(0, MAX);
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* private mode: recents just stay empty */
  }
}
