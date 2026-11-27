import { storageView, type StorageView } from "./storageSunburst";

export const STATUS_SECTIONS = ["jobs", "nodes", "events", "storage"] as const;
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
}

export function statusRoute(pathname: string, search: string): StatusRoute | null {
  const match = /^\/status(?:\/([^/]+))?\/?$/.exec(pathname);
  if (!match) return null;
  let node: string | null = null;
  try {
    if (match[1]) node = decodeURIComponent(match[1]);
  } catch {
    return null;
  }
  const q = new URLSearchParams(search);
  const part = <T extends string>(name: string, allowed: readonly T[]) => allowed.find((value) => value === q.get(name));
  const value = (name: string, limit: number) => q.get(name)?.slice(0, limit) || undefined;
  const section = part("section", STATUS_SECTIONS) ?? "jobs";
  const { node: storageNode, mode, selected } = storageView(q);
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
  };
}

const statusKeys = ["job", "jobs", "prefix", "glob", "kind", "type"] as const;
const storageKeys = ["section", "node", "storageMode", "slice"];

export function statusUrl(route: StatusRoute, search = ""): string {
  const q = new URLSearchParams(route.section === "storage" ? search : "");
  for (const key of [...storageKeys, ...statusKeys]) q.delete(key);
  if (route.section !== "jobs") q.set("section", route.section);
  if (route.section === "storage" && route.node) q.set("node", route.node);
  if (route.storage?.mode && route.storage.mode !== "size") q.set("storageMode", route.storage.mode);
  if (route.storage?.selected) q.set("slice", route.storage.selected);
  for (const key of statusKeys) {
    const value = route[key];
    if (value) q.set(key, value);
  }
  const pathNode = route.section === "storage" ? null : route.node;
  return "/status" + (pathNode ? "/" + encodeURIComponent(pathNode) : "") + (q.size ? "?" + q : "");
}

export function statusHistoryAction(from: StatusRoute, to: StatusRoute): "push" | "replace" {
  return to.section === "storage" || from.node === to.node ? "replace" : "push";
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
