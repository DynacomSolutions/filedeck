import fs from "node:fs/promises";
import path from "node:path";
import type { Hono } from "hono";
import * as ops from "./fsops.ts";
import { resolveRead, resolveWrite } from "./paths.ts";
import type { Config } from "./config.ts";
import { GitError, findRepo, lastCommit, relIn, remotes, repoAt, repoArgs, repoCwd, repoStatus, runGit, showFile, stashCount, type Commit, type Repo, type RepoSummary, type StatusResult } from "./git.ts";

/** Read-only Git routes: status for listings (work-item), details for the Properties panel and the HEAD side of a diff (work-item). */

/** How long a listing's status request waits before it answers "pending" (the work carries on and is cached). */
export const STATUS_BUDGET_MS = 1500;
const TTL_MS = 30_000;
const ERR_TTL_MS = 5_000;
const MAX_CACHE = 256;
const MAX_CHILD_SCAN = 600;
const MAX_CHILD_REPOS = 200;
const LIST_CAP = 200;

const virt = (root: string, real: string) => (root === "/" ? real : real.slice(root.length) || "/");

interface CacheEntry {
  fp: string;
  at: number;
  res?: StatusResult;
  err?: string;
  p: Promise<StatusResult>;
}

/** Per-repository status cache. An entry is dropped when HEAD, a ref log or the index moves, when the client says the change feed fired, or after a while. */
export class StatusCache {
  private map = new Map<string, CacheEntry>();

  private async fingerprint(r: Repo): Promise<string> {
    const m = async (f: string) => (await fs.stat(path.join(r.gitDir, f)).then((s) => s.mtimeMs, () => 0)).toString();
    return (await Promise.all(["index", "HEAD", "logs/HEAD"].map(m))).join(":");
  }

  /** Resolves with the status, or null when `budgetMs` passes first (the computation continues and fills the cache). */
  async get(r: Repo, fresh: boolean, budgetMs: number): Promise<StatusResult | null> {
    const key = `${r.gitDir}\0${r.workDir}`;
    const fp = r.kind === "bare" ? "" : await this.fingerprint(r);
    let e = this.map.get(key);
    const now = Date.now();
    if (!e || fresh || e.fp !== fp || (e.res && now - e.at > TTL_MS) || (e.err && now - e.at > ERR_TTL_MS)) {
      const entry: CacheEntry = { fp, at: now, p: undefined as never };
      entry.p = repoStatus(r).then(
        (res) => ((entry.res = res), (entry.at = Date.now()), res),
        (err: Error) => ((entry.err = err.message), (entry.at = Date.now()), Promise.reject(err)),
      );
      entry.p.catch(() => undefined);
      this.map.delete(key);
      this.map.set(key, entry);
      if (this.map.size > MAX_CACHE) this.map.delete(this.map.keys().next().value as string);
      e = entry;
    }
    if (e.res) return e.res;
    if (e.err && !e.res) throw new GitError(500, e.err);
    let timer: NodeJS.Timeout | undefined;
    const waited = await Promise.race([e.p, new Promise<null>((r) => (timer = setTimeout(() => r(null), Math.max(0, budgetMs))))]);
    clearTimeout(timer);
    return waited;
  }
}

export interface ChildRepo extends Partial<RepoSummary> {
  kind: RepoSummary["kind"];
  /** the budget ran out before this repository's status was known */
  pending?: boolean;
  error?: string;
}

export interface ListingStatus {
  /** the repository the listed folder is in (or is the root of) */
  repo?: { root: string; prefix: string; summary: RepoSummary };
  /** name -> state letters (S staged, M modified, U untracked, I ignored, C conflicted) for entries of the listed folder with a state */
  entries: Record<string, string>;
  /** state shared by every entry not named in `entries` (the whole folder is untracked or ignored) */
  base?: string;
  /** folders of the listing that are themselves repository roots */
  children: Record<string, ChildRepo>;
  /** some of it is still being worked out: ask again shortly */
  pending: boolean;
  error?: string;
}

const bad = (m: string) => new ops.FsError(400, m);

export function registerGitRoutes(app: Hono, cfg: Config): void {
  const root = cfg.root;
  const cache = new StatusCache();

  app.get("/api/git/status", async (c) => {
    const r = resolveRead(root, c.req.query("path") ?? "/");
    const st = await fs.stat(r.real);
    if (!st.isDirectory()) throw bad("not a directory");
    const fresh = c.req.query("fresh") === "1";
    const bq = c.req.query("budget");
    const deadline = Date.now() + (bq !== undefined && /^\d{1,4}$/.test(bq) ? Math.min(Number(bq), 5000) : STATUS_BUDGET_MS);
    const out: ListingStatus = { entries: {}, children: {}, pending: false };
    const work = async () => {
      const repo = await findRepo(root, r.real);
      const tasks: Promise<void>[] = [];
      if (repo) {
        tasks.push(
          (async () => {
            const res = await cache.get(repo, fresh, deadline - Date.now());
            if (!res) return void (out.pending = true);
            const prefix = repo.kind === "bare" ? "" : relIn(repo, r.real).replace(/^\.$/, "");
            out.repo = { root: virt(root, repo.workDir), prefix, summary: res.summary };
            applyFiles(out, res, prefix);
          })().catch((e: Error) => void (out.error = e.message)),
        );
      }
      tasks.push(scanChildren(r.real, fresh, deadline, out));
      await Promise.all(tasks);
    };
    let timer: NodeJS.Timeout | undefined;
    const done = await Promise.race([work().then(() => true), new Promise<false>((res) => (timer = setTimeout(() => res(false), Math.max(0, deadline - Date.now()) + 150)))]);
    clearTimeout(timer);
    if (!done) out.pending = true;
    return c.json(out);
  });

  /** Folders of the listing that are repository roots, with their summaries (bounded in count and in time). */
  async function scanChildren(dir: string, fresh: boolean, deadline: number, out: ListingStatus): Promise<void> {
    let names: string[];
    try {
      names = (await fs.readdir(dir, { withFileTypes: true })).filter((d) => d.isDirectory() && d.name !== ".git").map((d) => d.name);
    } catch {
      return;
    }
    names = names.slice(0, MAX_CHILD_SCAN);
    const found: [string, Repo][] = [];
    for (let i = 0; i < names.length; i += 32) {
      const got = await Promise.all(names.slice(i, i + 32).map(async (n) => [n, await repoAt(root, path.join(dir, n)).catch(() => null)] as const));
      for (const [n, rp] of got) if (rp && found.length < MAX_CHILD_REPOS) found.push([n, rp]);
    }
    await Promise.all(
      found.map(async ([n, rp]) => {
        out.children[n] = { kind: rp.kind, pending: true };
        try {
          const res = await cache.get(rp, fresh, deadline - Date.now());
          if (res) out.children[n] = res.summary;
          else out.pending = true;
        } catch (e) {
          out.children[n] = { kind: rp.kind, error: (e as Error).message };
        }
      }),
    );
  }

  /** Details for the Properties panel. `path` is a file or a folder inside a repository, or a repository root. */
  app.get("/api/git/info", async (c) => {
    const r = resolveWrite(root, c.req.query("path") ?? "/");
    const st = await fs.lstat(r.real);
    const isDir = st.isDirectory();
    const repo = await findRepo(root, isDir ? r.real : path.dirname(r.real));
    if (!repo) return c.json({ repo: null });
    const fresh = c.req.query("fresh") === "1";
    const res = await cache.get(repo, fresh, 20_000);
    if (!res) throw new GitError(504, "git status timed out");
    const rel = repo.kind === "bare" ? "" : relIn(repo, r.real);
    const wd = virt(root, repo.workDir);
    const lists: Record<"staged" | "modified" | "untracked" | "conflicted", { path: string; dir?: boolean }[]> = { staged: [], modified: [], untracked: [], conflicted: [] };
    const counts = { staged: 0, modified: 0, untracked: 0, conflicted: 0 };
    const key = { S: "staged", M: "modified", U: "untracked", C: "conflicted" } as const;
    for (const [p, letters] of res.files) {
      for (const l of letters) {
        const k = key[l as keyof typeof key];
        if (!k) continue;
        counts[k]++;
        if (lists[k].length < LIST_CAP) {
          const dir = p.endsWith("/");
          lists[k].push({ path: (wd === "/" ? "" : wd) + "/" + (dir ? p.slice(0, -1) : p), ...(dir ? { dir } : {}) });
        }
      }
    }
    const [commit, stash, rem] = await Promise.all([lastCommit(repo), repo.kind === "bare" ? 0 : stashCount(repo), remotes(repo)]);
    let file: { tracked: boolean; letters: string; lastCommit: Commit | null } | undefined;
    if (!isDir && repo.kind !== "bare") {
      const ls = await runGit(repoCwd(repo), [...repoArgs(repo), "ls-files", "--", rel], { timeoutMs: 5000 });
      file = { tracked: ls.code === 0 && ls.stdout.trim().length > 0, letters: res.files.get(rel) ?? "", lastCommit: await lastCommit(repo, rel) };
    }
    const main = repo.kind === "linked" ? (path.basename(repo.commonDir) === ".git" ? path.dirname(repo.commonDir) : repo.commonDir) : undefined;
    return c.json({
      repo: {
        root: wd,
        kind: repo.kind,
        rel,
        summary: res.summary,
        lastCommit: commit,
        stash,
        remotes: rem,
        ...(main ? { mainRepo: virt(root, main) } : {}),
        lists,
        counts,
        listCap: LIST_CAP,
        ...(file ? { file } : {}),
      },
    });
  });

  /** A file as of a revision, shaped like /api/fs/text so the diff viewer can use it as one side. */
  app.get("/api/git/show", async (c) => {
    const r = resolveWrite(root, c.req.query("path") ?? "");
    const repo = await findRepo(root, path.dirname(r.real));
    if (!repo || repo.kind === "bare") throw new ops.FsError(404, "not in a Git work tree");
    const rev = c.req.query("rev") ?? "HEAD";
    const buf = await showFile(repo, rev, relIn(repo, r.real), cfg.maxEdit);
    if (!buf) return c.json({ path: r.virtual, content: "", size: 0, mtime: 0, etag: "", absent: true });
    if (buf.subarray(0, 8192).includes(0)) throw new ops.FsError(415, "binary file");
    let content: string;
    try {
      content = new TextDecoder("utf-8", { fatal: true }).decode(buf);
    } catch {
      throw new ops.FsError(415, "file is not valid UTF-8 text");
    }
    return c.json({ path: r.virtual, content, size: buf.length, mtime: 0, etag: "" });
  });

}

/** Fold a repository's per-path states into the entries of the folder `prefix` (repo-relative, "" at the root). */
export function applyFiles(out: ListingStatus, res: StatusResult, prefix: string): void {
  const dir = prefix ? prefix + "/" : "";
  for (const [p, letters] of res.files) {
    if (p.endsWith("/") && dir.startsWith(p) && dir !== "") {
      // the listed folder lies inside an untracked or ignored folder
      out.base = letters;
      continue;
    }
    if (!p.startsWith(dir)) continue;
    const rest = p.slice(dir.length);
    const name = rest.split("/")[0]!;
    if (!name) continue;
    const cur = out.entries[name] ?? "";
    out.entries[name] = cur + [...letters].filter((l) => !cur.includes(l)).join("");
  }
}
