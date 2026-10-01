import { useSyncExternalStore } from "react";

/** A favourite folder. Kept in this browser's localStorage, shared by every panel and tab of the app. */
export interface Bookmark {
  node: string;
  path: string;
}
const KEY = "filedeck.bookmarks";
const MAX = 200;

const valid = (x: unknown): x is Bookmark => !!x && typeof x === "object" && typeof (x as Bookmark).node === "string" && typeof (x as Bookmark).path === "string" && (x as Bookmark).path.startsWith("/");

function load(): Bookmark[] {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "[]") as unknown;
    return Array.isArray(v) ? v.filter(valid).slice(0, MAX).map((b) => ({ node: b.node, path: b.path })) : [];
  } catch {
    return [];
  }
}

let current: Bookmark[] = load();
const subs = new Set<() => void>();
const emit = () => subs.forEach((f) => f());

function save(next: Bookmark[]) {
  current = next;
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* private mode or full: the list still works for this page view */
  }
  emit();
}

export const sameBookmark = (a: Bookmark, b: Bookmark) => a.node === b.node && a.path === b.path;
export const isBookmarked = (list: Bookmark[], b: Bookmark) => list.some((x) => sameBookmark(x, b));
export const addBookmark = (b: Bookmark) => isBookmarked(current, b) || save([...current, { node: b.node, path: b.path }].slice(-MAX));
export const removeBookmark = (b: Bookmark) => save(current.filter((x) => !sameBookmark(x, b)));
export const toggleBookmark = (b: Bookmark) => (isBookmarked(current, b) ? removeBookmark(b) : addBookmark(b));

if (typeof window !== "undefined") {
  // Another browser tab changed the list.
  window.addEventListener("storage", (e) => {
    if (e.key === KEY || e.key === null) {
      current = load();
      emit();
    }
  });
}

export function useBookmarks(): Bookmark[] {
  return useSyncExternalStore(
    (f) => (subs.add(f), () => subs.delete(f)),
    () => current,
  );
}

export const bookmarkLabel = (b: Bookmark) => {
  const last = b.path.split("/").filter(Boolean).pop();
  return last ? `${last}` : `${b.node}:/`;
};
