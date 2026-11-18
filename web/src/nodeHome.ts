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
