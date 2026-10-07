/** Which of the sidebar's mutually exclusive states a list is in (no React). */

export type ListState = "loading" | "error" | "empty" | "ready";

/**
 * `loading` only while nothing is known yet: cached data always wins so a refresh never blanks the list, and "empty"
 * is reported only after a request has succeeded with zero items.
 */
export function listState(s: { data: readonly unknown[] | undefined; error: unknown; isLoading: boolean }): ListState {
  if (s.data) return s.data.length ? "ready" : "empty";
  if (s.error) return "error";
  return "loading";
}
