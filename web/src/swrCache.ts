/** Pure helpers for the persisted SWR cache (no React, no DOM). Only small, cheap-to-refetch lists are stored. */

export const SWR_STORAGE_KEY = "filedeck.swr.v1";
/** Keys worth keeping across page loads. File listings are deliberately excluded: they are large and go stale quickly. */
export const PERSIST_KEYS: readonly string[] = ["nodes"];
export const MAX_PERSIST_BYTES = 64 * 1024;

export type PersistedEntries = Array<[string, unknown]>;

export const isPersistKey = (key: unknown): key is string => typeof key === "string" && PERSIST_KEYS.includes(key);

/** Entries from storage; anything unreadable, oversized or not on the allow-list yields nothing. */
export function parsePersisted(raw: string | null): PersistedEntries {
  if (!raw || raw.length > MAX_PERSIST_BYTES) return [];
  try {
    const v = JSON.parse(raw) as unknown;
    if (!Array.isArray(v)) return [];
    const out: PersistedEntries = [];
    for (const e of v) if (Array.isArray(e) && e.length === 2 && isPersistKey(e[0]) && e[1] && typeof e[1] === "object") out.push([e[0], e[1]]);
    return out;
  } catch {
    return [];
  }
}

/** JSON for the persistable part of the cache, or null when there is nothing to store or it would exceed the size bound. Error and in-flight state are never stored. */
export function serialisePersisted(cache: Iterable<[string, unknown]>): string | null {
  const out: PersistedEntries = [];
  for (const [k, v] of cache) {
    if (!isPersistKey(k) || !v || typeof v !== "object") continue;
    const data = (v as { data?: unknown }).data;
    if (data === undefined) continue;
    out.push([k, { data }]);
  }
  if (!out.length) return null;
  try {
    const s = JSON.stringify(out);
    return s.length > MAX_PERSIST_BYTES ? null : s;
  } catch {
    return null;
  }
}
