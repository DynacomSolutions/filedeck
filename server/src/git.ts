import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { FsError } from "./fsops.ts";
import { resolveRead } from "./paths.ts";

/**
 * Read-only Git plumbing for the agent. Everything here only reads: `GIT_OPTIONAL_LOCKS=0` stops `git status` from
 * refreshing the index, `core.fsmonitor` is forced off (a repository's own config must not start a daemon), no hook runs,
 * and nothing is fetched. Repositories on a node are often owned by other users, hence `safe.directory=*`.
 *
 * A linked worktree's `.git` file holds the HOST's absolute path to its git directory, which does not exist inside the
 * agent's `/host` mount, so repositories are located by hand (`findRepo`) and Git is pointed at them with
 * `--git-dir` and `--work-tree`, every path re-based onto the root through `paths.ts`.
 *
 * Nothing user-supplied is ever passed as an option: paths come after `--` or are `rev:path` operands that start with a
 * validated revision, and revisions are checked by `safeRev`.
 */

export interface GitRun {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** the output hit the cap and the process was stopped */
  truncated: boolean;
}

export interface GitOpts {
  timeoutMs?: number;
  maxBytes?: number;
  /** bytes, not text: for `show` of a file that may not be UTF-8 */
  raw?: boolean;
}

export const BASE_ARGS = [
  "-c", "safe.directory=*", "-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "-c", "core.quotepath=off", "-c", "core.pager=cat",
  "-c", "color.ui=false", "-c", "gc.auto=0", "-c", "maintenance.auto=false", "-c", "core.untrackedCache=false",
  // status asks each submodule's own `git status` for its dirty state, which would run the submodule's own filters:
  // only the recorded commit is compared
  "-c", "diff.ignoreSubmodules=dirty", "-c", "status.submoduleSummary=false",
];

/**
 * Subcommands that only read objects and refs: they never run a clean, smudge or process filter, so they skip the
 * config probe. Anything else is probed, so a new kind of call is safe by default.
 */
const OBJECT_ONLY = new Set(["rev-parse", "check-ref-format", "cat-file", "for-each-ref", "rev-list", "merge-base", "log", "show", "stash", "remote", "config"]);

/** The subcommand of an argument list that starts with `--git-dir X [--work-tree Y]` options. */
function subcommand(args: string[]): { lead: string[]; sub: string } {
  let i = 0;
  while (i < args.length && args[i]!.startsWith("--")) i += args[i] === "--git-dir" || args[i] === "--work-tree" ? 2 : 1;
  return { lead: args.slice(0, i), sub: args[i] ?? "" };
}

/** Runs a tiny Git command and collects its output (no filters involved: it only reads configuration). */
function probe(cwd: string, args: string[], env: NodeJS.ProcessEnv, timeoutMs: number): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const child = spawn("git", [...BASE_ARGS, ...args], { cwd, stdio: ["ignore", "pipe", "ignore"], env });
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    const finish = (code: number | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ code, out: Buffer.concat(chunks).toString("utf8") });
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(null);
    }, timeoutMs);
    timer.unref();
    child.stdout.on("data", (d: Buffer) => {
      size += d.length;
      if (size <= 1024 * 1024) chunks.push(d);
    });
    child.on("error", () => finish(null));
    child.on("close", (code) => finish(code));
  });
}

/**
 * Environment that replaces every content filter the repository's effective configuration defines (its own config,
 * `include.path` and `includeIf` files; the user's and the system's are already off) by a no-op, so `git status` and
 * friends never run a command a repository named: with `* filter=x` in `.gitattributes` or `.git/info/attributes` and
 * `filter.x.clean` in the config, Git runs that command as the agent user whenever a file's stat data differs from the
 * index. Environment config (`GIT_CONFIG_COUNT`) is used rather than `-c`, which cannot carry a driver name with `=` in it.
 * `GIT_ATTR_SOURCE` is not used: it hides `.gitattributes` from the work tree, which would also drop `eol` and `text`
 * rules and report CRLF files as modified, and it does not cover `.git/info/attributes`.
 * Returns null when the probe failed or timed out: the caller must then not run the command.
 */
export async function filterNeutralisedEnv(cwd: string, args: string[], env: NodeJS.ProcessEnv): Promise<NodeJS.ProcessEnv | null> {
  const { lead, sub } = subcommand(args);
  if (OBJECT_ONLY.has(sub)) return env;
  const r = await probe(cwd, [...lead, "config", "-z", "--get-regexp", "^filter\\..*\\.(clean|smudge|process)$"], env, 5000);
  // 1: no such key. 128 and the like: not a repository, the real command fails the same way (and no filter can apply)
  if (r.code === null) return null;
  if (r.code !== 0) return env;
  const names = new Set<string>();
  for (const rec of r.out.split("\0")) {
    const key = rec.split("\n", 1)[0]!;
    const m = /^filter\.(.+)\.(?:clean|smudge|process)$/s.exec(key);
    if (m) names.add(m[1]!);
  }
  if (names.size === 0) return env;
  const out: NodeJS.ProcessEnv = { ...env };
  let n = Number(env.GIT_CONFIG_COUNT ?? 0) || 0;
  const set = (k: string, v: string) => {
    out[`GIT_CONFIG_KEY_${n}`] = k;
    out[`GIT_CONFIG_VALUE_${n}`] = v;
    n++;
  };
  for (const name of names) {
    set(`filter.${name}.clean`, "cat");
    set(`filter.${name}.smudge`, "cat");
    set(`filter.${name}.process`, "");
    set(`filter.${name}.required`, "false");
  }
  out.GIT_CONFIG_COUNT = String(n);
  return out;
}

/** The environment every agent Git command runs in. */
export function gitEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: os.tmpdir(),
    LC_ALL: "C",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_ASKPASS: "true",
    GIT_PAGER: "cat",
    GIT_NO_REPLACE_OBJECTS: "1",
    ...extra,
  };
}

/** At most this many Git processes at once on a node, so a big listing never floods the host. */
const MAX_PROCS = 4;
let running = 0;
const waiters: (() => void)[] = [];
async function slot<T>(fn: () => Promise<T>): Promise<T> {
  if (running >= MAX_PROCS) await new Promise<void>((r) => waiters.push(r));
  running++;
  try {
    return await fn();
  } finally {
    running--;
    waiters.shift()?.();
  }
}

/** Run `git <args>` in `cwd` (a real path). `args` start with the subcommand or `--git-dir` options, never user input. */
export function runGit(cwd: string, args: string[], o: GitOpts = {}): Promise<GitRun & { buf: Buffer }> {
  const timeoutMs = o.timeoutMs ?? 10_000;
  const maxBytes = o.maxBytes ?? 8 * 1024 * 1024;
  return slot(async () => {
    const env = await filterNeutralisedEnv(cwd, args, gitEnv());
    if (!env) return { code: null, stdout: "", stderr: "git configuration could not be read", timedOut: true, truncated: false, buf: Buffer.alloc(0) };
    return await new Promise<GitRun & { buf: Buffer }>((resolve) => {
        const child = spawn("git", [...BASE_ARGS, ...args], {
          cwd,
          stdio: ["ignore", "pipe", "pipe"],
          detached: true, // its own process group, so a timeout takes helper processes (aliases, filters) down too
          env,
        });
        const out: Buffer[] = [];
        let size = 0;
        let errText = "";
        let timedOut = false;
        let truncated = false;
        let done = false;
        const killTree = () => {
          try {
            if (child.pid) process.kill(-child.pid, "SIGKILL");
          } catch {
            child.kill("SIGKILL");
          }
        };
        const timer = setTimeout(() => {
          timedOut = true;
          killTree();
        }, timeoutMs);
        timer.unref();
        child.stdout.on("data", (d: Buffer) => {
          size += d.length;
          if (size > maxBytes) {
            if (!truncated) {
              truncated = true;
              killTree();
            }
            return;
          }
          out.push(d);
        });
        child.stderr.on("data", (d: Buffer) => {
          if (errText.length < 4096) errText += d.toString("utf8");
        });
        const finish = (code: number | null) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          const buf = Buffer.concat(out);
          resolve({ code, stdout: o.raw ? "" : buf.toString("utf8"), stderr: errText, timedOut, truncated, buf });
        };
        child.on("error", (e) => {
          errText += String(e.message);
          finish(null);
        });
        child.on("close", (code) => finish(code));
    });
  });
}

/** A revision name that cannot be mistaken for an option or contain odd operators. */
export function safeRev(rev: string): boolean {
  return typeof rev === "string" && /^[A-Za-z0-9_][A-Za-z0-9_./@~^-]{0,199}$/.test(rev) && !rev.includes("..") && !rev.endsWith(".lock") && !rev.includes("@{");
}

export type RepoKind = "worktree" | "linked" | "bare";

/** Where a repository lives, as real paths inside the agent's root. */
export interface Repo {
  kind: RepoKind;
  /** real path of the work tree root (the git directory for a bare repository) */
  workDir: string;
  /** real path of the git directory this work tree uses (for a linked worktree: its own admin directory) */
  gitDir: string;
  /** real path of the common git directory (the main repository's), same as gitDir unless linked */
  commonDir: string;
  /** real path of the folder the work tree root is inside of, used to tell a path in the repo from one outside it */
  root: string;
}

const exists = (p: string) => fs.lstat(p).then(() => true, () => false);

/** The git directory a `.git` file points at, re-based onto the root when it is an absolute host path. */
async function gitFileTarget(root: string, file: string): Promise<string | null> {
  let text: string;
  try {
    text = await fs.readFile(file, "utf8");
  } catch {
    return null;
  }
  const m = /^gitdir:\s*(.+?)\s*$/m.exec(text.slice(0, 4096));
  if (!m) return null;
  const t = m[1]!;
  if (path.isAbsolute(t)) {
    try {
      return resolveRead(root, t).real;
    } catch {
      return null;
    }
  }
  return path.resolve(path.dirname(file), t);
}

async function looksBare(dir: string): Promise<boolean> {
  const [h, o, r] = await Promise.all([exists(path.join(dir, "HEAD")), exists(path.join(dir, "objects")), exists(path.join(dir, "refs"))]);
  return h && o && r;
}

/** Git's own test for a git directory: HEAD, objects and refs (a linked worktree's admin directory gets them from its commondir). */
async function isGitDir(dir: string): Promise<boolean> {
  if (!(await exists(path.join(dir, "HEAD")))) return false;
  const cd = await fs.readFile(path.join(dir, "commondir"), "utf8").then((t) => path.resolve(dir, t.trim()), () => null);
  return looksBare(cd ?? dir);
}

/** Is `dir` itself a repository root (a `.git` entry in it, or a bare repository)? */
export async function repoAt(root: string, dir: string): Promise<Repo | null> {
  if (path.basename(dir) === ".git") return null;
  const dotgit = path.join(dir, ".git");
  let st;
  try {
    st = await fs.lstat(dotgit);
  } catch {
    st = null;
  }
  // a `.git` that is not a valid repository is skipped, as Git does: the search goes on in the folders above
  if (st?.isDirectory()) return (await isGitDir(dotgit)) ? { kind: "worktree", workDir: dir, gitDir: dotgit, commonDir: dotgit, root } : null;
  if (st?.isFile()) {
    const gd = await gitFileTarget(root, dotgit);
    if (!gd || !(await isGitDir(gd))) return null;
    const cd = await fs.readFile(path.join(gd, "commondir"), "utf8").then((t) => path.resolve(gd, t.trim()), () => null);
    // a submodule's git directory sits inside the superproject's `.git/modules`, with no commondir: it is an ordinary work tree
    return { kind: cd ? "linked" : "worktree", workDir: dir, gitDir: gd, commonDir: cd ?? gd, root };
  }
  if (!st && (await looksBare(dir))) return { kind: "bare", workDir: dir, gitDir: dir, commonDir: dir, root };
  return null;
}

/** The repository containing `dir` (a real path under `root`): the nearest ancestor that is a repository root. */
export async function findRepo(root: string, dir: string): Promise<Repo | null> {
  let d = dir;
  for (let i = 0; i < 64; i++) {
    const r = await repoAt(root, d);
    if (r) return r;
    if (d === root || d === path.dirname(d)) return null;
    d = path.dirname(d);
  }
  return null;
}

/** Arguments that point Git at a repository, to precede the subcommand. */
export const repoArgs = (r: Repo): string[] => (r.kind === "bare" ? ["--git-dir", r.gitDir] : ["--git-dir", r.gitDir, "--work-tree", r.workDir]);
export const repoCwd = (r: Repo) => r.workDir;

export interface RepoSummary {
  kind: RepoKind;
  /** checked-out branch, or null when detached or unborn */
  branch: string | null;
  detached: boolean;
  /** short commit id of HEAD, null in a repository with no commits */
  head: string | null;
  upstream?: string;
  ahead?: number;
  behind?: number;
  staged: number;
  modified: number;
  untracked: number;
  conflicted: number;
}

/** Per-path state letters: S staged, M modified in the work tree, U untracked, I ignored, C conflicted. */
export interface StatusResult {
  summary: RepoSummary;
  /** repo-relative path (directories end with "/" when untracked or ignored as a whole) -> state letters */
  files: Map<string, string>;
}

/** Parse `git status --porcelain=v2 -z --branch`. */
export function parseStatus(kind: RepoKind, out: string): StatusResult {
  const s: RepoSummary = { kind, branch: null, detached: false, head: null, staged: 0, modified: 0, untracked: 0, conflicted: 0 };
  const files = new Map<string, string>();
  const add = (p: string, letters: string) => {
    const cur = files.get(p) ?? "";
    files.set(p, cur + [...letters].filter((c) => !cur.includes(c)).join(""));
  };
  for (const rec of out.split("\0")) {
    if (!rec) continue;
    if (rec.startsWith("# ")) {
      const [k, ...rest] = rec.slice(2).split(" ");
      const v = rest.join(" ");
      if (k === "branch.oid") s.head = v === "(initial)" ? null : v.slice(0, 7);
      else if (k === "branch.head") {
        if (v === "(detached)") s.detached = true;
        else s.branch = v;
      } else if (k === "branch.upstream") s.upstream = v;
      else if (k === "branch.ab") {
        const m = /^\+(\d+) -(\d+)$/.exec(v);
        if (m) {
          s.ahead = Number(m[1]);
          s.behind = Number(m[2]);
        }
      }
    } else if (rec[0] === "1" || rec[0] === "2") {
      // 1 XY sub mH mI mW hH hI path   (2 adds score and the original path as the next record, not requested: --no-renames)
      const f = rec.split(" ");
      const xy = f[1]!;
      const p = f.slice(rec[0] === "1" ? 8 : 9).join(" ");
      let l = "";
      if (xy[0] !== ".") (l += "S"), s.staged++;
      if (xy[1] !== ".") (l += "M"), s.modified++;
      if (l) add(p, l);
    } else if (rec[0] === "u") {
      const p = rec.split(" ").slice(10).join(" ");
      s.conflicted++;
      add(p, "C");
    } else if (rec[0] === "?") {
      s.untracked++;
      add(rec.slice(2), "U");
    } else if (rec[0] === "!") add(rec.slice(2), "I");
  }
  return { summary: s, files };
}

/** The branch name of a bare repository, read from HEAD without running Git. */
async function bareSummary(r: Repo): Promise<RepoSummary> {
  const s: RepoSummary = { kind: "bare", branch: null, detached: false, head: null, staged: 0, modified: 0, untracked: 0, conflicted: 0 };
  try {
    const h = (await fs.readFile(path.join(r.gitDir, "HEAD"), "utf8")).trim();
    const m = /^ref:\s*refs\/heads\/(.+)$/.exec(h);
    if (m) s.branch = m[1]!;
    else if (/^[0-9a-f]{40,64}$/.test(h)) (s.detached = true), (s.head = h.slice(0, 7));
  } catch {
    /* unreadable */
  }
  return s;
}

export class GitError extends FsError {
  constructor(status: 400 | 404 | 413 | 500 | 504, message: string) {
    super(status, message);
  }
}

/** Full status of a repository (bare: only the branch). */
export async function repoStatus(r: Repo, o: { timeoutMs?: number } = {}): Promise<StatusResult> {
  if (r.kind === "bare") return { summary: await bareSummary(r), files: new Map() };
  const res = await runGit(repoCwd(r), [...repoArgs(r), "status", "--porcelain=v2", "-z", "--branch", "--no-renames", "--untracked-files=normal", "--ignored=matching"], { timeoutMs: o.timeoutMs ?? 30_000, maxBytes: 32 * 1024 * 1024 });
  if (res.timedOut) throw new GitError(504, "git status timed out");
  if (res.code !== 0 && !res.truncated) throw new GitError(500, res.stderr.trim().split("\n")[0] || "git status failed");
  return parseStatus(r.kind, res.stdout);
}

/** URLs may carry credentials (https://user:token@host/...): never show the user-info part. */
export function stripUserInfo(url: string): string {
  return url.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@\s]*@/i, "$1");
}

export interface Commit {
  hash: string;
  author: string;
  email: string;
  /** ISO 8601 */
  date: string;
  subject: string;
}

/** The latest commit (optionally touching one repo-relative path); null when there is none. */
export async function lastCommit(r: Repo, relPath?: string): Promise<Commit | null> {
  const args = [...repoArgs(r), "log", "-1", "--no-show-signature", "--format=%H%x00%an%x00%ae%x00%aI%x00%s", "HEAD"];
  if (relPath) args.push("--", relPath);
  const res = await runGit(repoCwd(r), args, { timeoutMs: 8000 });
  if (res.code !== 0 || !res.stdout.trim()) return null;
  const [hash, author, email, date, ...subject] = res.stdout.trim().split("\0");
  return { hash: hash!, author: author ?? "", email: email ?? "", date: date ?? "", subject: subject.join("\0") };
}

export async function stashCount(r: Repo): Promise<number> {
  const res = await runGit(repoCwd(r), [...repoArgs(r), "stash", "list"], { timeoutMs: 5000, maxBytes: 1024 * 1024 });
  return res.code === 0 ? res.stdout.split("\n").filter(Boolean).length : 0;
}

export async function remotes(r: Repo): Promise<{ name: string; url: string }[]> {
  const res = await runGit(repoCwd(r), [...repoArgs(r), "remote", "-v"], { timeoutMs: 5000, maxBytes: 256 * 1024 });
  if (res.code !== 0) return [];
  const out: { name: string; url: string }[] = [];
  const seen = new Set<string>();
  for (const line of res.stdout.split("\n")) {
    const m = /^(\S+)\t(.+) \((fetch|push)\)$/.exec(line);
    if (!m || m[3] !== "fetch" || seen.has(m[1]!)) continue;
    seen.add(m[1]!);
    out.push({ name: m[1]!, url: stripUserInfo(m[2]!) });
  }
  return out;
}

/** `git show <rev>:<path>` as bytes (null when the path is not in that revision). */
export async function showFile(r: Repo, rev: string, relPath: string, maxBytes: number): Promise<Buffer | null> {
  if (!safeRev(rev)) throw new GitError(400, "invalid revision");
  const res = await runGit(repoCwd(r), [...repoArgs(r), "show", `${rev}:${relPath}`], { timeoutMs: 10_000, maxBytes, raw: true });
  if (res.truncated) throw new GitError(413, "file too large to diff");
  if (res.timedOut) throw new GitError(504, "git show timed out");
  if (res.code !== 0) return null;
  return res.buf;
}

/** Repo-relative path ("a/b.txt") of a real path inside the repository's work tree. */
export const relIn = (r: Repo, real: string) => path.relative(r.workDir, real).split(path.sep).join("/");
