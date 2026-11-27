export const STATUS_SECTIONS = ["jobs", "nodes", "events", "storage"] as const;
export const CHANGE_KINDS = ["create", "delete", "modify", "close_write", "attrib", "move"] as const;
export const JOB_FILTERS = ["active", "recent", "failed"] as const;

export interface StatusRoute {
  node: string | null;
  section: typeof STATUS_SECTIONS[number];
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
  return {
    node,
    section: part("section", STATUS_SECTIONS) ?? "jobs",
    job: value("job", 512),
    jobs: part("jobs", JOB_FILTERS),
    prefix: value("prefix", 4096),
    glob: value("glob", 4096),
    kind: part("kind", CHANGE_KINDS),
    type: part("type", ["file", "dir"] as const),
  };
}

export function statusUrl(route: StatusRoute): string {
  const q = new URLSearchParams();
  if (route.section !== "jobs") q.set("section", route.section);
  for (const key of ["job", "jobs", "prefix", "glob", "kind", "type"] as const) {
    const value = route[key];
    if (value) q.set(key, value);
  }
  return "/status" + (route.node ? "/" + encodeURIComponent(route.node) : "") + (q.size ? "?" + q : "");
}

export function statusHistoryAction(from: StatusRoute, to: StatusRoute): "push" | "replace" {
  return from.node === to.node ? "replace" : "push";
}

export function changesUrl(node: string, route: StatusRoute, since?: string): string {
  const q = new URLSearchParams({ node });
  for (const key of ["prefix", "glob", "kind", "type"] as const) {
    if (route[key]) q.set(key, route[key]);
  }
  if (since) q.set("since", since);
  return "/api/v1/changes?" + q;
}
