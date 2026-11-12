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
import { openChecked, resolveRead } from "./paths.ts";
import { NO_SUBMODULE_RECURSION, confineGitDir, findRepo, runGit } from "./git.ts";
import type { Config } from "./config.ts";

const LIST_MAX_BYTES = 4 * 1024 * 1024;
const STATUS_BUDGET_MS = 4000;
const MAX_WORKTREES = 200;

export interface WorktreeInfo {
  /** virtual path on this node; null when the worktree is outside the agent root (shown, not navigable) */
  path: string | null;
  /** a label for the worktree: its virtual path, or just its folder name when it lies outside the root (host paths git reports are not passed on) */
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
  /** where a folder is, or would be if it existed (a removed worktree), with links followed; null when that is outside the root */
  place(p: string): Promise<string | null>;
  virtual(real: string): string;
}

const within = (root: string, p: string) => p === root || p.startsWith(root === "/" ? "/" : root + path.sep);
const exists = (p: string) => fs.lstat(p).then(() => true, () => false);

/**
 * Where `p` really is, with every link on the way followed, when that lies inside `rootReal`; else null. A path that does not exist
 * (a removed worktree) is judged by its nearest existing ancestor, and the missing tail is added back. Comparing the text of a path
 * with the root does not do this: a link inside the root can lead out of it.
 */
async function settle(rootReal: string, p: string): Promise<string | null> {
  const tail: string[] = [];
  for (let cur = p; ; ) {
    try {
      const rp = await fs.realpath(cur);
      return within(rootReal, rp) ? path.join(rp, ...tail.reverse()) : null;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      const up = path.dirname(cur);
      if ((code !== "ENOENT" && code !== "ENOTDIR") || up === cur) return null;
      tail.push(path.basename(cur));
      cur = up;
    }
  }
}

async function makeMapper(root: string): Promise<Mapper> {
  const rootReal = await fs.realpath(root);
  return {
    rootReal,
    async real(p) {
      if (!path.isAbsolute(p)) return null;
      const n = path.normalize(p);
      if (within(rootReal, n) && (await exists(n))) return settle(rootReal, n);
      const joined = path.join(rootReal, n);
      if (within(rootReal, joined) && (await exists(joined))) return settle(rootReal, joined);
      return null;
    },
    async place(p) {
      if (!path.isAbsolute(p)) return null;
      const n = path.normalize(p);
      if (within(rootReal, n)) return settle(rootReal, n);
      // a host path: it lies under the mount point here, and counts only where the folder above it is there (as for a removed worktree)
      const joined = path.join(rootReal, n);
      return within(rootReal, joined) && (await exists(path.dirname(joined))) ? settle(rootReal, joined) : null;
    },
    virtual: (real) => "/" + path.relative(rootReal, real).split(path.sep).filter(Boolean).join("/"),
  };
}

/** Keeps printable characters only (a folder name is data too). */
const printable = (s: string) => s.replace(/[\p{C}\p{Zl}\p{Zp}]/gu, "?").slice(0, 255);

const read = (p: string) => fs.readFile(p, "utf8").catch(() => null);

interface Rec {
  worktree: string;
  head: string;
  branch: string | null;
  detached: boolean;
  bare: boolean;
  locked: boolean;
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
      else if (l === "locked" || l.startsWith("locked ")) r.locked = true; // the reason is read from the file, see `lockReasonOf` else if (l === "prunable" || l.startsWith("prunable ")) r.prunable = true;
    }
    out.push(r);
  }
  return out;
}

interface Admin {
  /** the folder name under `worktrees/`: the worktree's own id, never text from git */
  id: string;
  dir: string;
}

/**
 * Private git directories of the linked worktrees, keyed by the real worktree path they record and by the path as recorded
 * (what git lists). Each `gitdir` file is read through `readAdminFile`; one that is a link, too big or not a single path
 * (absolute, or relative to the private directory) is not trusted, and the worktree is then listed without a location.
 */
async function privateDirs(m: Mapper, common: string): Promise<{ byReal: Map<string, string>; byListed: Map<string, Admin> }> {
  const out = new Map<string, string>();
  const byListed = new Map<string, Admin>();
  const base = path.join(common, "worktrees");
  const ids = await fs.readdir(base).catch(() => [] as string[]);
  for (const id of ids) {
    const dir = path.join(base, id);
    const gd = oneLine(await readAdminFile(m.rootReal, common, dir, "gitdir", ADMIN_FILE_MAX), 4096);
    if (!gd) continue;
    // an absolute path is the host's own; a relative one (`worktree.useRelativePaths`, Git 2.48 and newer) is relative to this
    // private directory. Either way the place must lie inside the served root, with every link on the way followed (`settle`);
    // otherwise the worktree is listed without a location.
    const full = path.isAbsolute(gd) ? path.normalize(gd) : path.resolve(dir, gd);
    if (!path.isAbsolute(gd) && !within(m.rootReal, full)) continue;
    const place = await m.place(path.dirname(full));
    if (!place) continue;
    byListed.set(path.dirname(full), { id, dir });
    out.set(place, dir);
  }
  return { byReal: out, byListed };
}

const ADMIN_FILE_MAX = 4096;
const LOCK_REASON_MAX = 512;

/**
 * A small text file of a linked worktree's private directory (`worktrees/<id>/<file>`), read here and not taken from git's
 * output: opened without following a link, proven to be inside the git directory, a regular file of at most `max` bytes.
 * Anything else gives null.
 */
async function readAdminFile(rootReal: string, common: string, adminDir: string, file: string, max: number): Promise<string | null> {
  try {
    const [base, admin] = await Promise.all([fs.lstat(path.join(common, "worktrees")), fs.lstat(adminDir)]);
    if (!base.isDirectory() || !admin.isDirectory()) return null; // a link in the way
    const fh = await openChecked(rootReal, path.join(adminDir, file));
    try {
      const st = await fh.stat();
      if (!st.isFile() || st.size > max) return null;
      const [loc, gitReal] = await Promise.all([fs.readlink(`/proc/self/fd/${fh.fd}`), fs.realpath(common)]);
      if (!loc.startsWith(gitReal + path.sep)) return null;
      return await fh.readFile({ encoding: "utf8" });
    } finally {
      await fh.close();
    }
  } catch {
    return null;
  }
}

/** One line of printable text (no control characters, no line breaks), else undefined. */
const oneLine = (text: string | null, n: number): string | undefined => {
  const t = (text ?? "").replace(/\r?\n$/, "");
  return t && /^[^\p{C}\p{Zl}\p{Zp}]+$/u.test(t) ? t.slice(0, n) : undefined;
};

/** The reason a worktree is locked: the `locked` file of its private directory (see `readAdminFile`), printable text only. */
async function lockReasonOf(rootReal: string, common: string, adminDir: string): Promise<string | undefined> {
  return oneLine(await readAdminFile(rootReal, common, adminDir, "locked", LOCK_REASON_MAX), 200);
}

async function dirtyOf(root: string, gitDir: string, workTree: string): Promise<boolean | null> {
  if (!(await confineGitDir(root, gitDir))) return null; // links or alternates leading out of the root: not asked
  const r = await runGit(workTree, ["--git-dir", gitDir, "--work-tree", workTree, "status", "--porcelain", "-uno", "--no-renames", NO_SUBMODULE_RECURSION], { timeoutMs: STATUS_BUDGET_MS, maxBytes: 64 * 1024 });
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
  const { byReal: priv, byListed } = await privateDirs(m, common);
  const labels = new Set<string>();
  const worktrees = await Promise.all(
    recs.slice(0, MAX_WORKTREES).map(async (r, i): Promise<WorktreeInfo> => {
      const bare = r.bare;
      // a linked worktree is placed only when its private directory's own `gitdir` file (read here) says where it is; what git
      // printed for it may have come through a link
      const adm = i === 0 ? undefined : byListed.get(r.worktree);
      const trusted = i === 0 || adm !== undefined;
      const real = trusted ? await m.real(r.worktree) : null;
      const reach = trusted ? (real ?? (await m.place(r.worktree))) : null;
      // missing, but its parent folder is reachable (or it is spelled inside the root): the worktree was removed
      const gone = trusted && !bare && real === null && reach !== null && (within(m.rootReal, path.normalize(r.worktree)) || (await exists(path.dirname(reach))));
      const prunable = gone;
      const info: WorktreeInfo = {
        path: real ? m.virtual(real) : gone && reach ? m.virtual(reach) : null,
        gitPath: "",
        name: adm ? printable(adm.id) : i === 0 ? printable(path.basename(bare ? common : path.dirname(common))) : "(unknown worktree)",
        main: i === 0,
        bare,
        branch: r.branch,
        detached: r.detached,
        head: r.head.slice(0, 8).replace(/^0+$/, ""),
        locked: r.locked,

        prunable,
        dirty: null,
        current: !!real && within(real, here),
      };
      // a label that is not a host path: the virtual path, else the folder name (made unique)
      let label = info.path ?? info.name;
      for (let n = 2; labels.has(label); n++) label = `${info.path ?? info.name} (${n})`;
      labels.add(label);
      info.gitPath = label;
      if (r.locked) {
        const reason = adm ? await lockReasonOf(m.rootReal, common, adm.dir) : undefined;
        if (reason) info.lockReason = reason;
      }
      if (!bare && real && !prunable) {
        const gitDir = i === 0 ? common : priv.get(real);
        if (gitDir) info.dirty = await dirtyOf(m.rootReal, gitDir, real);
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
