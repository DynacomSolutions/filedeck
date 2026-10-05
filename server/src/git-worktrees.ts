/**
 * Read-only Git worktree listing (work-item). Given a folder, find the repository it belongs to (work tree, linked
 * worktree or bare mirror), run `git worktree list --porcelain` against its common directory and map every
 * worktree back to a virtual path on this node.
 *
 * Repositories live under the agent root and are often owned by other users, so git runs with
 * `safe.directory=*`, optional locks off and no hooks or fsmonitor. Repository discovery is done by hand
 * (reading `.git` files) because a linked worktree's `.git` file holds the HOST path of its private
 * directory, which does not exist under the root's mount point inside the container.
 */
import fs from "node:fs/promises";
import path from "node:path";
import type { Hono } from "hono";
import { FsError } from "./fsops.ts";
import { resolveRead } from "./paths.ts";
import { findRepo, runGit } from "./git.ts";
import type { Config } from "./config.ts";

const LIST_MAX_BYTES = 4 * 1024 * 1024;
const STATUS_BUDGET_MS = 4000;
const MAX_WORKTREES = 200;

export interface WorktreeInfo {
  /** virtual path on this node; null when the worktree is outside the agent root (shown, not navigable) */
  path: string | null;
  /** the path git reports (host path) */
  gitPath: string;
  name: string;
  main: boolean;
  bare: boolean;
  /** short branch name; null when detached or bare */
  branch: string | null;
  detached: boolean;
  /** abbreviated HEAD commit; "" when unborn or bare */
  head: string;
  locked: boolean;
  lockReason?: string;
  /** the worktree directory is gone (git worktree prune would remove its record) */
  prunable: boolean;
  /** uncommitted changes to tracked files; null when unknown (outside root, timed out, bare, missing) */
  dirty: boolean | null;
  /** the requested folder is inside this worktree */
  current: boolean;
}
export interface WorktreeList {
  /** virtual path of the repository's common git directory, when inside the root */
  repo: string | null;
  bare: boolean;
  worktrees: WorktreeInfo[];
  truncated: boolean;
}

interface Mapper {
  rootReal: string;
  /** git/host path -> real path under the root, or null when it is not reachable */
  real(p: string): Promise<string | null>;
  virtual(real: string): string;
}

const within = (root: string, p: string) => p === root || p.startsWith(root === "/" ? "/" : root + path.sep);
const exists = (p: string) => fs.lstat(p).then(() => true, () => false);

async function makeMapper(root: string): Promise<Mapper> {
  const rootReal = await fs.realpath(root);
  return {
    rootReal,
    async real(p) {
      if (!path.isAbsolute(p)) return null;
      const n = path.normalize(p);
      if (within(rootReal, n) && (await exists(n))) return n;
      const joined = path.join(rootReal, n);
      if (within(rootReal, joined) && (await exists(joined))) return joined;
      return null;
    },
    virtual: (real) => "/" + path.relative(rootReal, real).split(path.sep).filter(Boolean).join("/"),
  };
}

/** Where a path would be if it existed, even when the directory is gone (for prunable entries). */
function guess(m: Mapper, p: string): string | null {
  const n = path.normalize(p);
  if (within(m.rootReal, n)) return n;
  const joined = path.join(m.rootReal, n);
  return within(m.rootReal, joined) ? joined : null;
}

const read = (p: string) => fs.readFile(p, "utf8").catch(() => null);

interface Rec {
  worktree: string;
  head: string;
  branch: string | null;
  detached: boolean;
  bare: boolean;
  locked: boolean;
  lockReason?: string;
  prunable: boolean;
}

export function parsePorcelain(text: string): Rec[] {
  const out: Rec[] = [];
  for (const block of text.split(/\n\n+/)) {
    const lines = block.split("\n").filter(Boolean);
    const wt = lines.find((l) => l.startsWith("worktree "));
    if (!wt) continue;
    const r: Rec = { worktree: wt.slice(9), head: "", branch: null, detached: false, bare: false, locked: false, prunable: false };
    for (const l of lines) {
      if (l.startsWith("HEAD ")) r.head = l.slice(5);
      else if (l.startsWith("branch ")) r.branch = l.slice(7).replace(/^refs\/heads\//, "");
      else if (l === "detached") r.detached = true;
      else if (l === "bare") r.bare = true;
      else if (l === "locked" || l.startsWith("locked ")) {
        r.locked = true;
        if (l.length > 7) r.lockReason = l.slice(7);
      } else if (l === "prunable" || l.startsWith("prunable ")) r.prunable = true;
    }
    out.push(r);
  }
  return out;
}

/** Private git directories of the linked worktrees, keyed by the real worktree path they record. */
async function privateDirs(m: Mapper, common: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const base = path.join(common, "worktrees");
  const ids = await fs.readdir(base).catch(() => [] as string[]);
  for (const id of ids) {
    const gd = (await read(path.join(base, id, "gitdir")))?.trim();
    if (!gd) continue;
    const g = guess(m, path.dirname(gd));
    if (g) out.set(g, path.join(base, id));
  }
  return out;
}

async function dirtyOf(gitDir: string, workTree: string): Promise<boolean | null> {
  const r = await runGit(workTree, ["--git-dir", gitDir, "--work-tree", workTree, "status", "--porcelain", "-uno", "--no-renames"], { timeoutMs: STATUS_BUDGET_MS, maxBytes: 64 * 1024 });
  if (r.truncated) return true;
  if (r.timedOut || r.code !== 0) return null;
  return r.stdout.length > 0;
}

export async function listWorktrees(root: string, virtualDir: string): Promise<WorktreeList> {
  const start = resolveRead(root, virtualDir);
  const st = await fs.stat(start.real).catch(() => null);
  if (!st?.isDirectory()) throw new FsError(404, "folder not found");
  const m = await makeMapper(root);
  const here = await fs.realpath(start.real);
  const repo = await findRepo(m.rootReal, here);
  if (!repo) throw new FsError(404, "not inside a Git repository");
  const common = repo.commonDir;
  const ls = await runGit(common, ["--git-dir", common, "worktree", "list", "--porcelain"], { maxBytes: LIST_MAX_BYTES });
  if (ls.code !== 0) throw new FsError(502, ls.timedOut ? "git timed out" : "git could not list the worktrees");
  const recs = parsePorcelain(ls.stdout);
  const truncated = recs.length > MAX_WORKTREES;
  const priv = await privateDirs(m, common);
  const worktrees = await Promise.all(
    recs.slice(0, MAX_WORKTREES).map(async (r, i): Promise<WorktreeInfo> => {
      const bare = r.bare;
      const real = await m.real(r.worktree);
      const reach = real ?? guess(m, r.worktree);
      // missing, but its parent folder is reachable (or it is spelled inside the root): the worktree was removed
      const gone = !bare && real === null && reach !== null && (within(m.rootReal, path.normalize(r.worktree)) || (await exists(path.dirname(reach))));
      const prunable = gone;
      const info: WorktreeInfo = {
        path: real ? m.virtual(real) : gone && reach ? m.virtual(reach) : null,
        gitPath: r.worktree,
        name: path.basename(r.worktree),
        main: i === 0,
        bare,
        branch: r.branch,
        detached: r.detached,
        head: r.head.slice(0, 8).replace(/^0+$/, ""),
        locked: r.locked,
        ...(r.lockReason ? { lockReason: r.lockReason } : {}),
        prunable,
        dirty: null,
        current: !!real && within(real, here),
      };
      if (!bare && real && !prunable) {
        const gitDir = i === 0 ? common : priv.get(real);
        if (gitDir) info.dirty = await dirtyOf(gitDir, real);
      }
      return info;
    }),
  );
  // the innermost match wins when worktrees are nested inside each other
  const cur = worktrees.filter((w) => w.current).sort((a, b) => (b.path?.length ?? 0) - (a.path?.length ?? 0));
  for (const w of cur.slice(1)) w.current = false;
  return { repo: within(m.rootReal, common) ? m.virtual(common) : null, bare: repo.kind === "bare" || recs[0]?.bare === true, worktrees, truncated };
}

export function registerGitWorktreeRoutes(app: Hono, cfg: Config): void {
  app.get("/api/git/worktrees", async (c) => c.json(await listWorktrees(cfg.root, c.req.query("path") ?? "/")));
}
