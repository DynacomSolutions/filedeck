import { ApiError, nodeBase, type TextFile } from "./api";

/** Read-only Git state from the agent (server/src/git-routes.ts). */
export interface GitSummary {
  kind: "worktree" | "linked" | "bare";
  branch?: string | null;
  detached?: boolean;
  head?: string | null;
  upstream?: string;
  ahead?: number;
  behind?: number;
  staged?: number;
  modified?: number;
  untracked?: number;
  conflicted?: number;
  /** the status was not ready within the time budget */
  pending?: boolean;
  error?: string;
}
export interface GitListing {
  repo?: { root: string; prefix: string; summary: GitSummary };
  /** state letters per entry name: S staged, M modified, U untracked, I ignored, C conflicted */
  entries: Record<string, string>;
  /** the state of every entry not named in `entries` (the folder is inside an untracked or ignored folder) */
  base?: string;
  children: Record<string, GitSummary>;
  pending: boolean;
  error?: string;
}
export interface GitCommit {
  hash: string;
  author: string;
  email: string;
  date: string;
  subject: string;
}
export interface GitItem {
  path: string;
  dir?: boolean;
}
export interface GitInfo {
  repo: null | {
    root: string;
    kind: GitSummary["kind"];
    rel: string;
    summary: GitSummary;
    lastCommit: GitCommit | null;
    stash: number;
    remotes: { name: string; url: string }[];
    mainRepo?: string;
    lists: Record<"staged" | "modified" | "untracked" | "conflicted", GitItem[]>;
    counts: Record<"staged" | "modified" | "untracked" | "conflicted", number>;
    listCap: number;
    file?: { tracked: boolean; letters: string; lastCommit: GitCommit | null };
  };
}

const enc = encodeURIComponent;
async function j<T>(r: Response): Promise<T> {
  if (!r.ok) {
    let msg = r.statusText;
    try {
      msg = ((await r.json()) as { error?: string }).error ?? msg;
    } catch {
      /* not json */
    }
    throw new ApiError(msg, r.status);
  }
  return (await r.json()) as T;
}

export const gitApi = {
  status: (node: string, path: string, fresh: boolean, signal?: AbortSignal) => fetch(`${nodeBase(node)}/api/git/status?path=${enc(path)}${fresh ? "&fresh=1" : ""}`, { signal }).then((r) => j<GitListing>(r)),
  info: (node: string, path: string, fresh = false) => fetch(`${nodeBase(node)}/api/git/info?path=${enc(path)}${fresh ? "&fresh=1" : ""}`).then((r) => j<GitInfo>(r)),
  /** A file as of a revision, shaped like a text file so the diff viewer can show it as one side. */
  show: (node: string, path: string, rev: string) => fetch(`${nodeBase(node)}/api/git/show?path=${enc(path)}&rev=${enc(rev)}`).then((r) => j<TextFile & { absent?: boolean }>(r)),
};

/** What a state letter means, for tooltips and screen readers. */
export const STATE_WORDS: Record<string, string> = { S: "staged", M: "modified", U: "untracked", I: "ignored", C: "conflicted" };
export const stateText = (letters: string) => [...letters].map((l) => STATE_WORDS[l] ?? l).join(", ");

export const shortHash = (h: string) => h.slice(0, 7);
