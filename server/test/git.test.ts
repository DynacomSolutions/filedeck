import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createAgent } from "../src/agent.ts";
import { loadConfig } from "../src/config.ts";
import { parseStatus, runGit, safeRev, stripUserInfo } from "../src/git.ts";
import type { ListingStatus } from "../src/git-routes.ts";

/** The agent's root is a folder of its own, like a node's /host: repositories live at <root>/home/... and are named /home/... */
let tmp: string, root: string, app: ReturnType<typeof createAgent>;
const ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "Ada Lovelace", GIT_AUTHOR_EMAIL: "ada@example.test", GIT_COMMITTER_NAME: "Ada Lovelace", GIT_COMMITTER_EMAIL: "ada@example.test" };
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "init.defaultBranch=main", "-c", "commit.gpgsign=false", ...args], { cwd, env: ENV, encoding: "utf8" });
const write = (p: string, s: string) => (fs.mkdirSync(path.dirname(p), { recursive: true }), fs.writeFileSync(p, s));
const real = (v: string) => path.join(root, v);
const get = async <T,>(url: string, status = 200): Promise<T> => {
  const r = await app.request(url);
  assert.equal(r.status, status, await r.clone().text());
  return (await r.json()) as T;
};
const status = (p: string, extra = "") => get<ListingStatus>(`/api/git/status?path=${encodeURIComponent(p)}&fresh=1${extra}`);

before(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "filedeck-git-")));
  root = path.join(tmp, "host");
  fs.mkdirSync(path.join(root, "home"), { recursive: true });
  app = createAgent(loadConfig({ FILEDECK_ROOT: root, FILEDECK_NODE: "t" } as never));
});
after(async () => {
  await (app as unknown as { close: () => Promise<void> }).close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** home/main: committed a.txt, sub/b.txt; then a modified, sub/c.txt staged, sub/d.txt and new/ untracked, out.log ignored. */
function makeMain() {
  const d = real("/home/main");
  fs.mkdirSync(d, { recursive: true });
  git(d, "init", "-q");
  write(path.join(d, ".gitignore"), "*.log\nbuild/\n");
  write(path.join(d, "a.txt"), "one\n");
  write(path.join(d, "sub/b.txt"), "bee\n");
  git(d, "add", "-A");
  git(d, "commit", "-qm", "first commit");
  write(path.join(d, "a.txt"), "one\ntwo\n");
  write(path.join(d, "sub/c.txt"), "sea\n");
  git(d, "add", "sub/c.txt");
  write(path.join(d, "sub/d.txt"), "dee\n");
  write(path.join(d, "new/e.txt"), "e\n");
  write(path.join(d, "out.log"), "log\n");
  write(path.join(d, "build/x.o"), "obj\n");
  return d;
}

test("parseStatus reads branch, upstream, ahead/behind and every kind of entry", () => {
  const out = ["# branch.oid 0123456789abcdef", "# branch.head main", "# branch.upstream origin/main", "# branch.ab +2 -1", "1 .M N... 100644 100644 100644 aaa bbb a file.txt", "1 MM N... 100644 100644 100644 aaa bbb both.txt", "u UU N... 1 2 3 4 aaa bbb ccc clash.txt", "? new/", "! out.log", ""].join("\0");
  const r = parseStatus("worktree", out);
  assert.deepEqual({ ...r.summary }, { kind: "worktree", branch: "main", detached: false, head: "0123456", upstream: "origin/main", ahead: 2, behind: 1, staged: 1, modified: 2, untracked: 1, conflicted: 1 });
  assert.equal(r.files.get("a file.txt"), "M");
  assert.equal(r.files.get("both.txt"), "SM");
  assert.equal(r.files.get("clash.txt"), "C");
  assert.equal(r.files.get("new/"), "U");
  assert.equal(r.files.get("out.log"), "I");
  const d = parseStatus("worktree", "# branch.oid (initial)\0# branch.head (detached)\0");
  assert.equal(d.summary.detached, true);
  assert.equal(d.summary.head, null);
});

test("safeRev refuses options and odd operators; credentials are stripped from remote URLs", () => {
  for (const ok of ["HEAD", "HEAD~2", "main", "origin/main", "abc1234", "v1.0.0"]) assert.ok(safeRev(ok), ok);
  for (const no of ["--output=/tmp/x", "-n", "a..b", "@{u}", "", "x y", "a;b", "$(id)", ":/x", "main.lock"]) assert.ok(!safeRev(no), no);
  assert.equal(stripUserInfo("https://user:tok3n@host.example/org/repo.git"), "https://host.example/org/repo.git");
  assert.equal(stripUserInfo("git@host.example:org/repo.git"), "git@host.example:org/repo.git");
});

test("a work tree: folder pill counts, per-file states, folder states, ignored and untracked folders", async () => {
  makeMain();
  const top = await status("/home");
  assert.equal(top.repo, undefined);
  const m = top.children.main!;
  assert.equal(m.kind, "worktree");
  assert.equal(m.branch, "main");
  assert.deepEqual([m.staged, m.modified, m.untracked, m.conflicted], [1, 1, 2, 0]); // untracked: sub/d.txt and new/
  const root_ = await status("/home/main");
  assert.equal(root_.repo?.root, "/home/main");
  assert.equal(root_.repo?.prefix, "");
  assert.equal(root_.entries["a.txt"], "M");
  assert.equal(root_.entries["sub"], "SU"); // c.txt staged, d.txt untracked
  assert.equal(root_.entries["new"], "U");
  assert.equal(root_.entries["out.log"], "I");
  assert.equal(root_.entries["build"], "I");
  assert.equal(root_.entries["b.txt"], undefined);
  const sub = await status("/home/main/sub");
  assert.equal(sub.repo?.prefix, "sub");
  assert.deepEqual(sub.entries, { "c.txt": "S", "d.txt": "U" });
  const inNew = await status("/home/main/new");
  assert.equal(inNew.base, "U");
  const inBuild = await status("/home/main/build");
  assert.equal(inBuild.base, "I");
});

test("editing a file shows up with fresh=1 and the pill follows", async () => {
  const d = real("/home/main");
  write(path.join(d, "sub/b.txt"), "bee\nchanged\n");
  const sub = await status("/home/main/sub");
  assert.equal(sub.entries["b.txt"], "M");
  assert.equal((await status("/home")).children.main!.modified, 2);
  git(d, "checkout", "--", "sub/b.txt");
  assert.equal((await status("/home/main/sub")).entries["b.txt"], undefined);
});

test("a repository the listing is not in has no repo and no pills", async () => {
  fs.mkdirSync(real("/home/plain/inner"), { recursive: true });
  const s = await status("/home/plain");
  assert.deepEqual({ ...s, pending: false }, { entries: {}, children: {}, pending: false });
});

test("upstream: ahead and behind", async () => {
  const origin = real("/home/origin.git");
  fs.mkdirSync(origin, { recursive: true });
  git(origin, "init", "-q", "--bare");
  const a = real("/home/ab/a");
  fs.mkdirSync(a, { recursive: true });
  git(a, "init", "-q");
  write(path.join(a, "f"), "1\n");
  git(a, "add", "f");
  git(a, "commit", "-qm", "one");
  git(a, "remote", "add", "origin", origin);
  git(a, "push", "-q", "-u", "origin", "main");
  const b = real("/home/ab/b");
  git(real("/home/ab"), "clone", "-q", origin, b);
  write(path.join(b, "g"), "2\n");
  git(b, "add", "g");
  git(b, "commit", "-qm", "two");
  git(b, "push", "-q");
  write(path.join(a, "h"), "3\n");
  git(a, "add", "h");
  git(a, "commit", "-qm", "three");
  git(a, "fetch", "-q");
  const s = await status("/home/ab");
  assert.deepEqual({ ahead: s.children.a!.ahead, behind: s.children.a!.behind, upstream: s.children.a!.upstream }, { ahead: 1, behind: 1, upstream: "origin/main" });
  assert.equal(s.children.b!.ahead, 0);
  assert.equal(s.children.b!.behind, 0);
});

test("a bare repository is recognised and shows its branch", async () => {
  const s = await status("/home");
  assert.equal(s.children["origin.git"]?.kind, "bare");
  assert.equal(s.children["origin.git"]?.branch, "main");
  const inside = await status("/home/origin.git");
  assert.equal(inside.repo?.summary.kind, "bare");
});

test("a linked worktree, whose .git file names an absolute host path, is read through the root", async () => {
  const main = real("/home/main");
  const wt = real("/home/wt-feature");
  git(main, "worktree", "add", "-q", "-b", "feature", wt);
  // as on a node: the file holds the path the HOST sees, not the agent's /host-prefixed one
  const gf = path.join(wt, ".git");
  fs.writeFileSync(gf, `gitdir: /home/main/.git/worktrees/wt-feature\n`);
  write(path.join(wt, "a.txt"), "changed in the worktree\n");
  const s = await status("/home");
  const w = s.children["wt-feature"]!;
  assert.equal(w.kind, "linked");
  assert.equal(w.branch, "feature");
  assert.equal(w.modified, 1);
  const inner = await status("/home/wt-feature");
  assert.equal(inner.entries["a.txt"], "M");
  const info = await get<{ repo: { kind: string; mainRepo: string; root: string } }>("/api/git/info?path=/home/wt-feature/a.txt");
  assert.equal(info.repo.kind, "linked");
  assert.equal(info.repo.mainRepo, "/home/main");
  assert.equal(info.repo.root, "/home/wt-feature");
});

test("details: last commit, stash, remotes without credentials, lists and a file's own state", async () => {
  const d = real("/home/main");
  git(d, "remote", "add", "origin", "https://user:s3cret@host.example/org/repo.git");
  git(d, "stash", "push", "-q", "-m", "wip", "--", "a.txt");
  write(path.join(d, "a.txt"), "one\nthree\n");
  const i = await get<{
    repo: { summary: { branch: string }; lastCommit: { subject: string; author: string; hash: string }; stash: number; remotes: { name: string; url: string }[]; lists: Record<string, { path: string; dir?: boolean }[]>; counts: Record<string, number> };
  }>("/api/git/info?path=/home/main&fresh=1");
  assert.equal(i.repo.summary.branch, "main");
  assert.equal(i.repo.lastCommit.subject, "first commit");
  assert.equal(i.repo.lastCommit.author, "Ada Lovelace");
  assert.equal(i.repo.lastCommit.hash.length, 40);
  assert.equal(i.repo.stash, 1);
  assert.deepEqual(i.repo.remotes, [{ name: "origin", url: "https://host.example/org/repo.git" }]);
  assert.ok(!JSON.stringify(i).includes("s3cret"));
  assert.deepEqual(i.repo.lists.staged!.map((x) => x.path), ["/home/main/sub/c.txt"]);
  assert.deepEqual(i.repo.lists.modified!.map((x) => x.path), ["/home/main/a.txt"]);
  assert.deepEqual(i.repo.lists.untracked!.map((x) => x.path).sort(), ["/home/main/new", "/home/main/sub/d.txt"]);
  assert.equal(i.repo.lists.untracked!.find((x) => x.path === "/home/main/new")?.dir, true);
  const f = await get<{ repo: { rel: string; file: { tracked: boolean; letters: string; lastCommit: { subject: string } } } }>("/api/git/info?path=/home/main/a.txt");
  assert.equal(f.repo.rel, "a.txt");
  assert.deepEqual({ tracked: f.repo.file.tracked, letters: f.repo.file.letters, subject: f.repo.file.lastCommit.subject }, { tracked: true, letters: "M", subject: "first commit" });
  const u = await get<{ repo: { file: { tracked: boolean; letters: string } } }>("/api/git/info?path=/home/main/sub/d.txt");
  assert.deepEqual({ tracked: u.repo.file.tracked, letters: u.repo.file.letters }, { tracked: false, letters: "U" });
  assert.deepEqual(await get("/api/git/info?path=/home/plain"), { repo: null });
});

test("show: HEAD content, untracked is absent, options and bad revisions are refused", async () => {
  const h = await get<{ content: string; absent?: boolean }>("/api/git/show?path=/home/main/a.txt&rev=HEAD");
  assert.equal(h.content, "one\n");
  const u = await get<{ content: string; absent?: boolean }>("/api/git/show?path=/home/main/sub/d.txt");
  assert.equal(u.absent, true);
  assert.equal(u.content, "");
  assert.equal((await app.request("/api/git/show?path=/home/main/a.txt&rev=--output%3D/tmp/pwned")).status, 400);
  assert.equal((await app.request("/api/git/show?path=/home/main/a.txt&rev=a..b")).status, 400);
  assert.equal((await app.request("/api/git/show?path=/home/plain/inner")).status, 404);
  fs.writeFileSync(path.join(real("/home/main"), "bin.dat"), Buffer.from([0, 1, 2, 3]));
  git(real("/home/main"), "add", "bin.dat");
  git(real("/home/main"), "commit", "-qm", "binary");
  assert.equal((await app.request("/api/git/show?path=/home/main/bin.dat")).status, 415);
});

test("nothing is written: no index lock is taken and the index file is untouched by a status", async () => {
  const idx = path.join(real("/home/main"), ".git/index");
  const before = fs.statSync(idx).mtimeMs;
  write(path.join(real("/home/main"), "a.txt"), "touched again\n");
  await status("/home/main");
  assert.equal(fs.statSync(idx).mtimeMs, before);
  assert.equal(fs.existsSync(idx + ".lock"), false);
});

test("a git run is stopped at its time limit and at its output cap", async () => {
  const slow = await runGit(tmp, ["-c", "alias.slow=!sleep 5", "slow"], { timeoutMs: 100 });
  assert.equal(slow.timedOut, true);
  const big = await runGit(tmp, ["-c", "alias.big=!yes | head -c 100000", "big"], { maxBytes: 1000 });
  assert.equal(big.truncated, true);
});

test("a listing whose status is not ready in time answers pending, and the next one has it", async () => {
  const r = await get<ListingStatus>("/api/git/status?path=/home/main&fresh=1&budget=0");
  assert.equal(r.pending, true);
  await new Promise((res) => setTimeout(res, 800));
  const again = await get<ListingStatus>("/api/git/status?path=/home/main");
  assert.equal(again.pending, false);
  assert.equal(again.repo?.summary.branch, "main");
});

test("paths are confined: a traversal is refused", async () => {
  assert.equal((await app.request("/api/git/status?path=/home/../..")).status, 400);
  assert.equal((await app.request("/api/git/info?path=/../etc")).status, 400);
});

test("a diff against HEAD survives the URL: the revision rides along on the left side, and a hostile one is dropped", async () => {
  const { encodeState, decodeState } = await import("../../web/src/urlState.ts");
  const tree = { kind: "leaf", id: "p1", node: "n", path: "/r" } as const;
  const url = encodeState({ tree, active: "p1", diff: { left: { node: "n", path: "/r/f.txt", rev: "HEAD" }, right: { node: "n", path: "/r/f.txt" } } });
  assert.deepEqual(decodeState(url)?.diff, { left: { node: "n", path: "/r/f.txt", rev: "HEAD" }, right: { node: "n", path: "/r/f.txt" } });
  const plain = encodeState({ tree, active: "p1", diff: { left: { node: "n", path: "/a" }, right: { node: "n", path: "/b" } } });
  assert.deepEqual(decodeState(plain)?.diff?.left, { node: "n", path: "/a" });
  const w = JSON.parse(new URLSearchParams(url).get("s")!);
  w.f[0][2] = "--output=/x";
  const hostile = decodeState("?s=" + encodeURIComponent(JSON.stringify(w)));
  assert.deepEqual(hostile?.diff?.left, { node: "n", path: "/r/f.txt" });
});
