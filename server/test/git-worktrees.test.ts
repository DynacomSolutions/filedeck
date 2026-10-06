import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createAgent } from "../src/agent.ts";
import { loadConfig } from "../src/config.ts";
import { decodeState, leaves } from "../../web/src/urlState.ts";
import { parsePorcelain } from "../src/git-worktrees.ts";

let tmp: string, app: ReturnType<typeof createAgent>;
const g = (cwd: string, ...a: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", "-c", "protocol.file.allow=always", ...a], { cwd, stdio: "pipe", encoding: "utf8" });
const commit = (cwd: string, file: string, text: string) => {
  fs.writeFileSync(path.join(cwd, file), text);
  g(cwd, "add", file);
  g(cwd, "commit", "-m", `edit ${file}`);
};
interface W { path: string | null; name: string; main: boolean; bare: boolean; branch: string | null; detached: boolean; head: string; locked: boolean; lockReason?: string; prunable: boolean; dirty: boolean | null; current: boolean }
interface L { repo: string | null; bare: boolean; worktrees: W[] }
const list = async (p: string, a = app) => {
  const r = await a.request(`/api/git/worktrees?path=${encodeURIComponent(p)}`);
  return { status: r.status, body: (await r.json()) as L & { error?: string } };
};
const names = (l: L) => l.worktrees.map((w) => w.name).sort();

before(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "filedeck-wt-")));
  // main work tree with two linked worktrees
  fs.mkdirSync(path.join(tmp, "work/main"), { recursive: true });
  const m = path.join(tmp, "work/main");
  g(m, "init", "-b", "main");
  commit(m, "a.txt", "one\n");
  g(m, "worktree", "add", "-b", "feat", path.join(tmp, "work/feat"));
  g(m, "worktree", "add", "--detach", path.join(tmp, "work/det"));
  g(m, "worktree", "add", "-b", "lck", path.join(tmp, "work/lck"));
  g(m, "worktree", "lock", "--reason", "on a usb stick", path.join(tmp, "work/lck"));
  g(m, "worktree", "add", "-b", "gone", path.join(tmp, "work/gone"));
  fs.rmSync(path.join(tmp, "work/gone"), { recursive: true });
  fs.writeFileSync(path.join(tmp, "work/feat/a.txt"), "changed\n"); // dirty
  fs.writeFileSync(path.join(tmp, "work/main/untracked.txt"), "u\n"); // untracked only: not dirty
  fs.mkdirSync(path.join(tmp, "work/main/sub/deep"), { recursive: true });
  // bare mirror with linked worktrees
  g(tmp, "clone", "--bare", m, path.join(tmp, "mirror/repo.git"));
  const b = path.join(tmp, "mirror/repo.git");
  g(b, "worktree", "add", path.join(tmp, "mirror/wt-main"), "main");
  g(b, "worktree", "add", "-b", "task", path.join(tmp, "mirror/wt-task"), "main");
  // The agent runs in a container whose root is the host's "/": records written by git on the host hold host paths
  // ("/work/feat/.git"), not "<root>/work/feat/.git". Rewrite the fixture the same way.
  const strip = (f: string) => fs.writeFileSync(f, fs.readFileSync(f, "utf8").split(tmp).join(""));
  for (const d of ["work/feat", "work/det", "work/lck", "mirror/wt-main", "mirror/wt-task"]) strip(path.join(tmp, d, ".git"));
  for (const c of ["work/main/.git", "mirror/repo.git"]) for (const id of fs.readdirSync(path.join(tmp, c, "worktrees"))) strip(path.join(tmp, c, "worktrees", id, "gitdir"));
  // a plain folder outside any repository
  fs.mkdirSync(path.join(tmp, "plain/x"), { recursive: true });
  app = createAgent(loadConfig({ FILEDECK_ROOT: tmp, FILEDECK_NODE: "t" } as never));
});
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test("porcelain parser", () => {
  const r = parsePorcelain("worktree /a\nHEAD abc\nbranch refs/heads/x\n\nworktree /b\nHEAD def\ndetached\nlocked why\n\nworktree /c.git\nbare\n");
  assert.deepEqual(r.map((x) => [x.worktree, x.branch, x.detached, x.locked, x.lockReason, x.bare]), [["/a", "x", false, false, undefined, false], ["/b", null, true, true, "why", false], ["/c.git", null, false, false, undefined, true]]);
});

test("main work tree lists itself and every linked worktree", async () => {
  const { status, body } = await list("/work/main/sub/deep");
  assert.equal(status, 200);
  assert.deepEqual(names(body), ["det", "feat", "gone", "lck", "main"]);
  const by = Object.fromEntries(body.worktrees.map((w) => [w.name, w]));
  assert.equal(body.worktrees[0]!.name, "main");
  assert.equal(by.main!.main, true);
  assert.equal(by.main!.current, true);
  assert.equal(by.main!.branch, "main");
  assert.equal(by.main!.path, "/work/main");
  assert.match(by.main!.head, /^[0-9a-f]{7,}$/);
  assert.equal(by.main!.dirty, false, "untracked files do not count");
  assert.equal(by.feat!.branch, "feat");
  assert.equal(by.feat!.dirty, true);
  assert.equal(by.feat!.current, false);
  assert.equal(by.det!.detached, true);
  assert.equal(by.det!.branch, null);
  assert.equal(by.det!.dirty, false);
  assert.equal(by.lck!.locked, true);
  assert.equal(by.lck!.lockReason, "on a usb stick");
  assert.equal(by.gone!.prunable, true);
  assert.equal(by.gone!.dirty, null);
  assert.equal(by.gone!.path, "/work/gone");
  assert.equal(by.feat!.prunable, false);
});

test("a linked worktree lists the same set, with itself current", async () => {
  const { body } = await list("/work/feat");
  assert.deepEqual(names(body), ["det", "feat", "gone", "lck", "main"]);
  assert.deepEqual(body.worktrees.filter((w) => w.current).map((w) => w.name), ["feat"]);
});

test("a removed worktree disappears after prune", async () => {
  g(path.join(tmp, "work/main"), "worktree", "add", "-b", "tmp1", path.join(tmp, "work/tmp1"));
  assert.ok(names((await list("/work/main")).body).includes("tmp1"));
  g(path.join(tmp, "work/main"), "worktree", "remove", "--force", path.join(tmp, "work/tmp1"));
  assert.ok(!names((await list("/work/main")).body).includes("tmp1"));
});

test("bare mirror: the bare entry plus its linked worktrees", async () => {
  for (const from of ["/mirror/repo.git", "/mirror/wt-task"]) {
    const { status, body } = await list(from);
    assert.equal(status, 200, from);
    assert.equal(body.bare, true);
    assert.deepEqual(names(body), ["repo.git", "wt-main", "wt-task"]);
    const bare = body.worktrees.find((w) => w.bare)!;
    assert.equal(bare.main, true);
    assert.equal(bare.dirty, null);
    assert.equal(bare.path, "/mirror/repo.git");
    assert.equal(body.worktrees.find((w) => w.name === "wt-task")!.branch, "task");
  }
});

test("not a repository, or a folder that does not exist", async () => {
  assert.equal((await list("/plain/x")).status, 404);
  assert.equal((await list("/nope")).status, 404);
});

test("worktrees outside the root are shown but not navigable", async () => {
  const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "filedeck-wt-out-")));
  try {
    const m = path.join(tmp, "work/main");
    g(m, "worktree", "add", "-b", "elsewhere", path.join(outside, "ext"));
    const { body } = await list("/work/main");
    const ext = body.worktrees.find((w) => w.name === "ext")!;
    assert.equal(ext.branch, "elsewhere");
    assert.equal(ext.dirty, null);
    assert.equal(ext.path, null);
    assert.equal(ext.prunable, false);
    g(m, "worktree", "remove", "--force", path.join(outside, "ext"));
  } finally {
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test("host-path records resolve through the root (container mount)", async () => {
  // Root is a sub-folder of the real filesystem; the repository was created with paths that are valid only on the "host" side.
  const host = path.join(tmp, "hostroot");
  const hostWork = path.join(host, "srv/proj");
  fs.mkdirSync(hostWork, { recursive: true });
  g(hostWork, "init", "-b", "main");
  commit(hostWork, "f.txt", "x\n");
  g(hostWork, "worktree", "add", "-b", "wt", path.join(host, "srv/proj-wt"));
  // rewrite the records so they hold paths as the host sees them: "/srv/...", not "<root>/srv/..."
  const rel = (p: string) => p.slice(host.length);
  const priv = path.join(hostWork, ".git/worktrees/proj-wt");
  fs.writeFileSync(path.join(priv, "gitdir"), rel(path.join(host, "srv/proj-wt/.git")) + "\n");
  fs.writeFileSync(path.join(host, "srv/proj-wt/.git"), `gitdir: ${rel(priv)}\n`);
  const a = createAgent(loadConfig({ FILEDECK_ROOT: host, FILEDECK_NODE: "t" } as never));
  fs.writeFileSync(path.join(host, "srv/proj-wt/f.txt"), "dirty\n");
  const { status, body } = await list("/srv/proj-wt", a);
  assert.equal(status, 200);
  assert.deepEqual(names(body), ["proj", "proj-wt"]);
  const wt = body.worktrees.find((w) => w.name === "proj-wt")!;
  assert.equal(wt.path, "/srv/proj-wt");
  assert.equal(wt.current, true);
  assert.equal(wt.dirty, true);
  assert.equal(wt.prunable, false);
  assert.equal(body.worktrees.find((w) => w.name === "proj")!.dirty, false);
});

test("legacy Worktrees side-panel URLs restore the repository Git tab", () => {
  const wire = { t: { i: "p1", n: "n", p: "/a", v: ["left", 35, "w"] }, a: "p1" };
  const back = decodeState(`?s=${encodeURIComponent(JSON.stringify(wire))}`);
  const leaf = leaves(back!.tree)[0]!;
  assert.deepEqual(leaf.pv, { dock: "left", size: 35, tab: "props" });
  assert.equal(leaf.pt, "git");
});
