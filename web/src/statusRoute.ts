import { storageView, type StorageView } from "./storageSunburst";

export const STATUS_SECTIONS = ["jobs", "nodes", "events", "storage", "disks"] as const;
export const PRESSURE_WINDOWS = [1, 5, 15] as const;
export const PRESSURE_GROUPS = ["cgroup", "process", "path"] as const;
export const PRESSURE_TOPS = [10, 20, 50, 100] as const;
export const PRESSURE_DEFAULTS = { window: 5, group: "cgroup", top: 20 } as const;
export const CHANGE_KINDS = ["create", "delete", "modify", "close_write", "attrib", "move"] as const;
export const JOB_FILTERS = ["active", "recent", "failed"] as const;

export interface StatusRoute {
  node: string | null;
  section: typeof STATUS_SECTIONS[number];
  storage?: Omit<StorageView, "node">;
  job?: string;
  jobs?: typeof JOB_FILTERS[number];
  prefix?: string;
  glob?: string;
  kind?: typeof CHANGE_KINDS[number];
  type?: "file" | "dir";
  /** disk pressure: the disk in the path (`/status/<node>/disks/<disk>`) */
  disk?: string;
  /** disk pressure view options (query string): minutes of history, consumer kind and the number of consumers */
  window?: typeof PRESSURE_WINDOWS[number];
  group?: typeof PRESSURE_GROUPS[number];
  top?: typeof PRESSURE_TOPS[number];
}

export function statusRoute(pathname: string, search: string): StatusRoute | null {
  const match = /^\/status(?:\/([^/]+)(\/disks(?:\/([^/]+))?)?)?\/?$/.exec(pathname);
  if (!match) return null;
  let node: string | null = null;
  let disk: string | undefined;
  try {
    if (match[1]) node = decodeURIComponent(match[1]);
    if (match[3]) disk = decodeURIComponent(match[3]);
  } catch {
    return null;
  }
  const q = new URLSearchParams(search);
  const part = <T extends string>(name: string, allowed: readonly T[]) => allowed.find((value) => value === q.get(name));
  const value = (name: string, limit: number) => q.get(name)?.slice(0, limit) || undefined;
  const section = match[2] ? "disks" : part("section", STATUS_SECTIONS) ?? "jobs";
  const { node: storageNode, mode, selected } = storageView(q);
  const count = <T extends number>(name: string, allowed: readonly T[]) => allowed.find((value) => String(value) === q.get(name));
  return {
    node: section === "storage" ? storageNode ?? node : node,
    section,
    ...(section === "storage" || q.has("storageMode") || q.has("slice") ? { storage: { mode, selected } } : {}),
    job: value("job", 512),
    jobs: part("jobs", JOB_FILTERS),
    prefix: value("prefix", 4096),
    glob: value("glob", 4096),
    kind: part("kind", CHANGE_KINDS),
    type: part("type", ["file", "dir"] as const),
    ...(section === "disks" && node ? { disk } : {}),
    ...(section === "disks" ? { window: count("window", PRESSURE_WINDOWS), group: part("group", PRESSURE_GROUPS), top: count("top", PRESSURE_TOPS) } : {}),
  };
}

const statusKeys = ["job", "jobs", "prefix", "glob", "kind", "type"] as const;
const storageKeys = ["section", "node", "storageMode", "slice", "window", "group", "top"];

export function statusUrl(route: StatusRoute, search = ""): string {
  const q = new URLSearchParams(route.section === "storage" ? search : "");
  for (const key of [...storageKeys, ...statusKeys]) q.delete(key);
  if (route.section !== "jobs" && !(route.section === "disks" && route.node)) q.set("section", route.section);
  if (route.section === "storage" && route.node) q.set("node", route.node);
  if (route.storage?.mode && route.storage.mode !== "size") q.set("storageMode", route.storage.mode);
  if (route.storage?.selected) q.set("slice", route.storage.selected);
  for (const key of route.section === "disks" ? [] : statusKeys) {
    const value = route[key];
    if (value) q.set(key, value);
  }
  if (route.section === "disks" && route.node && route.disk) {
    for (const [key, fallback] of Object.entries(PRESSURE_DEFAULTS)) {
      const value = route[key as keyof typeof PRESSURE_DEFAULTS];
      if (value !== undefined && value !== fallback) q.set(key, String(value));
    }
  }
  const pathNode = route.section === "storage" ? null : route.node;
  const disks = route.section === "disks" && route.node ? "/disks" + (route.disk ? "/" + encodeURIComponent(route.disk) : "") : "";
  return "/status" + (pathNode ? "/" + encodeURIComponent(pathNode) : "") + disks + (q.size ? "?" + q : "");
}

export function statusHistoryAction(from: StatusRoute, to: StatusRoute): "push" | "replace" {
  if (to.section === "storage") return "replace";
  // A disk is content: it sits in the path and pushes. Window, group and top are view options and replace.
  if (from.section === "disks" && to.section === "disks" && from.disk !== to.disk) return "push";
  return from.node === to.node ? "replace" : "push";
}

export function legacyStorageUrl(pathname: string, search: string, hash: string): string | null {
  if (pathname !== "/storage" && pathname !== "/storage/") return null;
  const query = new URLSearchParams(search);
  query.set("section", "storage");
  return "/status?" + query + hash;
}

export function changesUrl(node: string, route: StatusRoute, since?: string): string {
  const q = new URLSearchParams({ node });
  for (const key of ["prefix", "glob", "kind", "type"] as const) {
    if (route[key]) q.set(key, route[key]);
  }
  if (since) q.set("since", since);
  return "/api/v1/changes?" + q;
}
