import { spawn } from "node:child_process";
import path from "node:path";
import { FsError } from "./fsops.ts";

/**
 * Read-only git for the pull request diff view. Everything here runs `git` next to the data (a work tree or a bare
 * `--mirror` clone, owned by whoever, so `safe.directory=*`), never writes (`GIT_OPTIONAL_LOCKS=0`), never passes
 * client input as an option (refs are validated, then resolved with `--end-of-options`; paths come after `--` or
 * inside a `<sha>:<path>` argument) and needs no GitHub token: a PR is resolved through `refs/pull/<n>/head`.
 */

export interface GitRun {
  code: number;
  out: Buffer;
  /** the output hit `maxBytes` and was cut */
  truncated: boolean;
}

export interface RunOpts {
  maxBytes?: number;
  timeoutMs?: number;
  /** directories git must not climb out of when looking for the repository (the agent root's parent) */
  ceiling?: string;
}

/** Runs `git <args>` in `cwd`. Resolves with the exit code (never rejects on a non-zero exit); kills on timeout or output cap. */
export function runGit(cwd: string, args: string[], o: RunOpts = {}): Promise<GitRun> {
  const maxBytes = o.maxBytes ?? 8 * 1024 * 1024;
  const timeoutMs = o.timeoutMs ?? 20_000;
  return new Promise((resolve, reject) => {
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
      HOME: "/nonexistent",
      LANG: "C",
      LC_ALL: "C",
      GIT_OPTIONAL_LOCKS: "0",
      GIT_TERMINAL_PROMPT: "0",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_NO_REPLACE_OBJECTS: "1",
    };
    if (o.ceiling) env.GIT_CEILING_DIRECTORIES = o.ceiling;
    // core.fsmonitor/hooksPath/pager come from the repository's own config, which belongs to someone else: neutralise them.
    const p = spawn("git", ["-c", "safe.directory=*", "-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "-c", "core.pager=cat", ...args], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    let n = 0;
    let truncated = false;
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      p.kill("SIGKILL");
      reject(new FsError(504, "git timed out"));
    }, timeoutMs);
    p.stdout.on("data", (b: Buffer) => {
      if (truncated) return;
      if (n + b.length > maxBytes) {
        chunks.push(b.subarray(0, maxBytes - n));
        n = maxBytes;
        truncated = true;
        p.kill("SIGKILL");
        return;
      }
      chunks.push(b);
      n += b.length;
    });
    p.stderr.resume();
    p.on("error", (e) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      reject((e as NodeJS.ErrnoException).code === "ENOENT" ? new FsError(501, "git is not installed on this node") : e);
    });
    p.on("close", (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ code: truncated ? 0 : (code ?? 1), out: Buffer.concat(chunks), truncated });
    });
  });
}

const text = (r: GitRun) => r.out.toString("utf8");
const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
export const isSha = (s: string) => SHA.test(s);
/** Characters a ref the UI offers can contain; narrower than git allows, on purpose. */
const REF_CHARS = /^[A-Za-z0-9._/@+#=,-]+$/;

export interface GitCtx {
  cwd: string;
  ceiling?: string;
}

const git = (c: GitCtx, args: string[], o: RunOpts = {}) => runGit(c.cwd, args, { ...o, ceiling: c.ceiling });

/** Confirms `cwd` is inside a git repository and says whether it is bare. */
export async function repoInfo(c: GitCtx): Promise<{ bare: boolean }> {
  const r = await git(c, ["rev-parse", "--is-bare-repository"], { maxBytes: 64 });
  if (r.code !== 0) throw new FsError(400, "not a git repository");
  return { bare: text(r).trim() === "true" };
}

/** Strictly validates a ref name and resolves it to a commit sha. Throws 400 for a malformed name, 404 when it does not exist. */
export async function resolveRef(c: GitCtx, ref: string): Promise<string> {
  if (typeof ref !== "string" || !ref || ref.length > 256 || ref.startsWith("-") || !REF_CHARS.test(ref)) throw new FsError(400, "invalid ref");
  if (!isSha(ref)) {
    const ok = await git(c, ["check-ref-format", "--allow-onelevel", ref], { maxBytes: 64, timeoutMs: 5000 });
    if (ok.code !== 0) throw new FsError(400, "invalid ref");
  } else if (ref.length !== 40 && ref.length !== 64) throw new FsError(400, "invalid ref");
  const r = await git(c, ["rev-parse", "--verify", "--quiet", "--end-of-options", `${ref}^{commit}`], { maxBytes: 256, timeoutMs: 10_000 });
  const sha = text(r).trim();
  if (r.code !== 0 || !isSha(sha)) throw new FsError(404, `ref not found: ${ref}`);
  return sha;
}

const tryRef = async (c: GitCtx, ref: string): Promise<string | null> => {
  try {
    return await resolveRef(c, ref);
  } catch (e) {
    if (e instanceof FsError && e.status === 404) return null;
    throw e;
  }
};

/** The repository's default branch tip: `origin/HEAD` of a work tree, else HEAD (a mirror's HEAD is the default branch). */
async function defaultTip(c: GitCtx): Promise<{ ref: string; sha: string } | null> {
  for (const ref of ["refs/remotes/origin/HEAD", "HEAD"]) {
    const sha = await tryRef(c, ref);
    if (sha) return { ref: ref === "HEAD" ? "HEAD" : "origin/HEAD", sha };
  }
  return null;
}

async function mergeBase(c: GitCtx, a: string, b: string): Promise<string | null> {
  const r = await git(c, ["merge-base", a, b], { maxBytes: 256, timeoutMs: 15_000 });
  const sha = text(r).trim();
  return r.code === 0 && isSha(sha) ? sha : null;
}

export interface Side {
  ref: string;
  sha: string;
}
export type FileStatus = "A" | "M" | "D" | "R";
export interface ChangedFile {
  path: string;
  /** previous path of a renamed file */
  oldPath?: string;
  status: FileStatus;
  /** lines added and removed; null for binary files */
  add: number | null;
  del: number | null;
  binary: boolean;
  /** rename similarity, percent */
  similarity?: number;
}
export interface PrDiff {
  base: Side;
  head: Side;
  mergeBase: string;
  files: ChangedFile[];
  truncated: boolean;
  note?: string;
  pr?: number;
}

export type DiffInput = { pr: number } | { base: string; head: string };

const MAX_FILES = 5000;

/** Picks the commit pair for a PR number or two refs. The "base" returned is the merge-base, so the diff has three-dot semantics. */
export async function resolveRange(c: GitCtx, input: DiffInput): Promise<{ base: Side; head: Side; mergeBase: string; note?: string; pr?: number }> {
  if ("pr" in input) {
    const n = input.pr;
    if (!Number.isInteger(n) || n < 1 || n > 99_999_999) throw new FsError(400, "invalid pull request number");
    const head = await tryRef(c, `refs/pull/${n}/head`);
    if (!head) throw new FsError(404, `pull request #${n} is not in this repository (no refs/pull/${n}/head); fetch it first`);
    // The merge ref's first parent is the base tip GitHub merged against; without it use the default branch.
    let tip: Side | null = null;
    const merged = await tryRef(c, `refs/pull/${n}/merge`);
    if (merged) {
      const p = await git(c, ["rev-parse", "--verify", "--quiet", "--end-of-options", `${merged}^1`], { maxBytes: 256 });
      const sha = text(p).trim();
      if (p.code === 0 && isSha(sha)) tip = { ref: `refs/pull/${n}/merge^1`, sha };
    }
    const def = await defaultTip(c);
    if (!tip && def) tip = { ref: def.ref, sha: def.sha };
    if (!tip) throw new FsError(404, "the repository has no default branch to compare against");
    let mb = await mergeBase(c, tip.sha, head);
    let note: string | undefined;
    if (mb === head && def) {
      // The head is already inside the default branch (merged without squashing): the base is the first parent of the merge that brought it in.
      const r = await git(c, ["rev-list", "--ancestry-path", "--merges", "--reverse", "--max-count=1000", `${head}..${def.sha}`], { maxBytes: 100_000, timeoutMs: 20_000 });
      const first = text(r).split("\n")[0]?.trim() ?? "";
      if (isSha(first)) {
        const p = await git(c, ["rev-parse", "--verify", "--quiet", "--end-of-options", `${first}^1`], { maxBytes: 256 });
        const par = text(p).trim();
        const m2 = p.code === 0 && isSha(par) ? await mergeBase(c, par, head) : null;
        if (m2 && m2 !== head) {
          mb = m2;
          note = "merged pull request: compared with the branch point of its head";
        }
      }
      if (mb === head) note = "the head is already part of the default branch, so there is nothing to show";
    }
    if (!mb) throw new FsError(404, "the pull request and the default branch share no history");
    return { base: { ref: tip.ref, sha: mb }, head: { ref: `refs/pull/${n}/head`, sha: head }, mergeBase: mb, ...(note ? { note } : {}), pr: n };
  }
  const [b, h] = await Promise.all([resolveRef(c, input.base), resolveRef(c, input.head)]);
  const mb = await mergeBase(c, b, h);
  if (!mb) throw new FsError(404, "the two refs share no history");
  return { base: { ref: input.base, sha: mb }, head: { ref: input.head, sha: h }, mergeBase: mb };
}

/** Parses `-z` name-status output into rows: `[status, path, oldPath?, similarity?]`. */
export function parseNameStatus(buf: string): { status: FileStatus; path: string; oldPath?: string; similarity?: number }[] {
  const t = buf.split("\0");
  const out: { status: FileStatus; path: string; oldPath?: string; similarity?: number }[] = [];
  for (let i = 0; i < t.length; ) {
    const code = t[i++];
    if (!code) continue;
    const k = code[0]!;
    if (k === "R" || k === "C") {
      const oldPath = t[i++] ?? "";
      const p = t[i++] ?? "";
      out.push({ status: k === "R" ? "R" : "A", path: p, ...(k === "R" ? { oldPath } : {}), similarity: Number(code.slice(1)) || undefined });
    } else {
      const p = t[i++] ?? "";
      out.push({ status: k === "A" ? "A" : k === "D" ? "D" : "M", path: p });
    }
  }
  return out;
}

/** Parses `-z` numstat output: `add\tdel\tpath\0`, or `add\tdel\t\0old\0new\0` for a rename. Keyed by the new path. */
export function parseNumstat(buf: string): Map<string, { add: number | null; del: number | null }> {
  const t = buf.split("\0");
  const out = new Map<string, { add: number | null; del: number | null }>();
  for (let i = 0; i < t.length; ) {
    const rec = t[i++];
    if (!rec) continue;
    const m = /^(-|\d+)\t(-|\d+)\t(.*)$/s.exec(rec);
    if (!m) continue;
    let p = m[3]!;
    if (p === "") {
      i++; // old path
      p = t[i++] ?? "";
    }
    out.set(p, { add: m[1] === "-" ? null : Number(m[1]), del: m[2] === "-" ? null : Number(m[2]) });
  }
  return out;
}

/** Changed files between the merge-base and the head, with status, rename source and line counts. */
export async function prDiff(c: GitCtx, input: DiffInput): Promise<PrDiff> {
  const range = await resolveRange(c, input);
  const base = ["diff", "--no-ext-diff", "--no-textconv", "--no-color", "-M", "-z"];
  const [ns, num] = await Promise.all([
    git(c, [...base, "--name-status", range.base.sha, range.head.sha, "--"], { maxBytes: 16 * 1024 * 1024, timeoutMs: 30_000 }),
    git(c, [...base, "--numstat", range.base.sha, range.head.sha, "--"], { maxBytes: 16 * 1024 * 1024, timeoutMs: 30_000 }),
  ]);
  if (ns.code !== 0 || num.code !== 0) throw new FsError(502, "git diff failed");
  const rows = parseNameStatus(text(ns));
  const counts = parseNumstat(text(num));
  const files: ChangedFile[] = rows.slice(0, MAX_FILES).map((r) => {
    const n = counts.get(r.path) ?? { add: 0, del: 0 };
    const binary = n.add === null || n.del === null;
    return { path: r.path, ...(r.oldPath !== undefined ? { oldPath: r.oldPath } : {}), status: r.status, add: n.add, del: n.del, binary, ...(r.similarity !== undefined && r.status === "R" ? { similarity: r.similarity } : {}) };
  });
  return { base: range.base, head: range.head, mergeBase: range.mergeBase, files, truncated: rows.length > MAX_FILES || ns.truncated || num.truncated, ...(range.note ? { note: range.note } : {}), ...(range.pr ? { pr: range.pr } : {}) };
}

export interface Blob {
  size: number;
  binary: boolean;
  /** larger than the cap: not sent */
  tooLarge: boolean;
  content: string;
}
export const MAX_BLOB = 2 * 1024 * 1024;

/** File content at a commit (`git cat-file`, size first), capped; binary content (a NUL in the first 8 KiB) is not sent. */
export async function readBlob(c: GitCtx, sha: string, file: string, cap = MAX_BLOB): Promise<Blob> {
  if (!isSha(sha)) throw new FsError(400, "invalid commit");
  if (!file || file.length > 4096 || file.includes("\0") || file.includes("\n") || file.startsWith("/") || file.startsWith("./") || file.startsWith("../")) throw new FsError(400, "invalid path");
  const spec = `${sha}:${file}`;
  const sz = await git(c, ["cat-file", "-s", spec], { maxBytes: 64, timeoutMs: 10_000 });
  const size = Number(text(sz).trim());
  if (sz.code !== 0 || !Number.isFinite(size)) throw new FsError(404, "file not found at that commit");
  if (size > cap) return { size, binary: false, tooLarge: true, content: "" };
  const r = await git(c, ["cat-file", "blob", spec], { maxBytes: cap + 1, timeoutMs: 20_000 });
  if (r.code !== 0) throw new FsError(404, "not a regular file at that commit");
  const binary = r.out.subarray(0, 8192).includes(0);
  return { size, binary, tooLarge: false, content: binary ? "" : r.out.toString("utf8") };
}

export interface RefList {
  bare: boolean;
  /** short names: branches (local and remote) then tags, newest first */
  refs: string[];
  /** recent pull requests found as refs/pull/<n>/head, newest first */
  prs: { n: number; subject: string }[];
}

/** What the picker offers: recent refs and pull requests. Capped; the user can still type any ref. */
export async function listRefs(c: GitCtx): Promise<RefList> {
  const { bare } = await repoInfo(c);
  const [rf, pr] = await Promise.all([
    git(c, ["for-each-ref", "--sort=-committerdate", "--count=200", "--format=%(refname:short)", "refs/heads", "refs/remotes", "refs/tags"], { maxBytes: 256 * 1024, timeoutMs: 15_000 }),
    git(c, ["for-each-ref", "--sort=-committerdate", "--format=%(refname)%09%(subject)", "refs/pull"], { maxBytes: 4 * 1024 * 1024, timeoutMs: 20_000 }),
  ]);
  const refs = text(rf).split("\n").filter((x) => x && x !== "origin" && !x.endsWith("/HEAD") && REF_CHARS.test(x));
  const prs: { n: number; subject: string }[] = [];
  for (const line of text(pr).split("\n")) {
    const m = /^refs\/pull\/(\d+)\/head\t(.*)$/.exec(line);
    if (m) prs.push({ n: Number(m[1]), subject: m[2]!.slice(0, 200) });
    if (prs.length >= 40) break;
  }
  return { bare, refs, prs };
}

/** The directory git must not climb above: the parent of the agent's root (so a repository at the root itself still works). */
export const ceilingFor = (root: string) => (root === "/" ? undefined : path.dirname(root));
