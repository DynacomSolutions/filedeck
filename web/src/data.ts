import { useCallback } from "react";
import useSWR, { type Cache, type SWRConfiguration } from "swr";
import { api, type Entry, type Mount, type NodeInfo } from "./api";
import { isPersistKey, parsePersisted, serialisePersisted, SWR_STORAGE_KEY } from "./swrCache";

export const NODES_KEY = "nodes";
const NODES_REFRESH_MS = 15000;

/** One in-flight node-list request shared by every caller (SWR, the address bar), so they never fetch it twice at once. */
let inflight: Promise<NodeInfo[]> | null = null;
export const fetchNodes = (): Promise<NodeInfo[]> => (inflight ??= api.nodes().then((r) => r.nodes).finally(() => (inflight = null)));

/** In-memory cache seeded from localStorage; the node list is written back (debounced, size-bounded) as it changes. */
const store = new Map<string, unknown>();
export const swrCache: Cache = {
  get: (k) => store.get(k) as never,
  set: (k, v) => {
    store.set(k, v);
    if (isPersistKey(k)) schedulePersist();
  },
  delete: (k) => void store.delete(k),
  keys: () => store.keys(),
};
let timer: ReturnType<typeof setTimeout> | undefined;
function schedulePersist() {
  clearTimeout(timer);
  timer = setTimeout(() => {
    try {
      const s = serialisePersisted(store as Iterable<[string, unknown]>);
      if (s) localStorage.setItem(SWR_STORAGE_KEY, s);
      else localStorage.removeItem(SWR_STORAGE_KEY);
    } catch {
      /* storage full or unavailable: the cache lasts for this page view */
    }
  }, 300);
}
try {
  for (const [k, v] of parsePersisted(localStorage.getItem(SWR_STORAGE_KEY))) store.set(k, v);
} catch {
  /* storage unavailable */
}

export const swrConfig: SWRConfiguration = {
  provider: () => swrCache as Map<string, never>,
  revalidateOnFocus: true,
  revalidateOnReconnect: true,
  dedupingInterval: 2000,
  shouldRetryOnError: true,
  errorRetryCount: 3,
};

/** The node list (cluster nodes then network sources): cached, shared and revalidated in the background. */
export function useNodes() {
  const r = useSWR<NodeInfo[]>(NODES_KEY, fetchNodes, { refreshInterval: NODES_REFRESH_MS });
  const retry = useCallback(() => void r.mutate(), [r.mutate]);
  return { nodes: r.data, error: r.error as Error | undefined, isLoading: r.isLoading, reload: retry };
}

/** Sidebar folder listing (sub-folders only). Not persisted; revalidates on focus. */
export const dirsOf = (entries: Entry[]) => entries.filter((e) => e.type === "dir" || (e.type === "symlink" && e.linkDir)).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }));
export const listKey = (node: string, path: string) => ["dirs", node, path] as const;
export const mountsKey = (node: string) => ["mounts", node] as const;
export const listFetcher = ([, node, path]: readonly [string, string, string]) => api.list(node, path, false).then((x) => ({ dirs: dirsOf(x.entries), truncated: x.truncated }));
export const mountsFetcher = ([, node]: readonly [string, string]) => api.mounts(node).then((x) => x.mounts as Mount[]);
