// Where a machine opens. A virtual account may use only the folders granted to it there (`roots`, from the hub, in the order the
// administrator gave them), so it opens at the first one; everyone else opens at /.
import type { NodeInfo } from "./api";

/** The folder a machine opens at: its first granted folder, else `/`. */
export function homeOf(n: Pick<NodeInfo, "roots"> | undefined): string {
  return n?.roots?.[0] ?? "/";
}

/** The folder to open when a machine is opened at `path`: `/` becomes the machine's home; any other path is kept. */
export function openPath(n: Pick<NodeInfo, "roots"> | undefined, path: string): string {
  return path === "/" ? homeOf(n) : path;
}

/**
 * The folder a sidebar row opens: a machine's own row opens the machine (`openPath`); every other row, a granted folder's too (a grant
 * of `/` among others opens `/`), opens its exact path.
 */
export function rowOpens(kind: string, n: Pick<NodeInfo, "roots"> | undefined, path: string): string {
  return kind === "node" ? openPath(n, path) : path;
}

/**
 * Whether "up" may leave `path`: not at `/`, and not at one of a machine's granted folders (above it the account has no access).
 */
export function canGoUp(n: Pick<NodeInfo, "roots"> | undefined, path: string): boolean {
  return path !== "/" && !n?.roots?.includes(path);
}

/** The address bar's first crumb for a base path: a granted folder shows its path, any other base the root sign `/`. */
export function firstCrumb(n: Pick<NodeInfo, "roots"> | undefined, basePath: string): { label: string; granted: boolean } {
  return n?.roots?.includes(basePath) ? { label: basePath, granted: true } : { label: "/", granted: false };
}

/**
 * The home folder to offer when listing `path` failed: only for a machine with granted folders, only for a refusal (403), and not
 * when the folder is the home itself. Otherwise null, and the plain error stands.
 */
export function noAccessHome(n: Pick<NodeInfo, "roots"> | undefined, path: string, err: unknown): string | null {
  if (!n?.roots?.length || (err as { status?: unknown } | null)?.status !== 403) return null;
  const home = homeOf(n);
  return path === home ? null : home;
}
