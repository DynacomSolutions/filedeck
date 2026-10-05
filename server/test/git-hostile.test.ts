import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createAgent } from "../src/agent.ts";
import { loadConfig } from "../src/config.ts";
import { findRepo, runGit } from "../src/git.ts";

/**
 * work-item: a repository's own configuration must never make the agent run a command. Every repository here tries a
 * different route to a command (clean filter, process filter, filters from an include file, `.git/info/attributes`,
 * odd driver names, fsmonitor, hooks, a submodule's own filter); the command touches a file in `marks/`. Every Git route
 * is then called and `marks/` must stay empty while the answers stay right.
 */
let tmp: string, root: string, marks: string, app: ReturnType<typeof createAgent>;
const ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.test", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.test" };
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "init.defaultBranch=main", "-c", "commit.gpgsign=false", "-c", "protocol.file.allow=always", ...args], { cwd, env: ENV, encoding: "utf8" }).trim();
const write = (p: string, s: string) => (fs.mkdirSync(path.dirname(p), { recursive: true }), fs.writeFileSync(p, s));
const marked = () => fs.readdirSync(marks);
const reset = () => fs.readdirSync(marks).forEach((f) => fs.rmSync(path.join(marks, f)));
const stale = (p: string) => fs.utimesSync(p, new Date(Date.now() + 5000), new Date(Date.now() + 5000)); // stat data now differs from the index

before(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "filedeck-hostile-")));
  root = path.join(tmp, "host");
  marks = path.join(tmp, "marks");
  fs.mkdirSync(root);
  fs.mkdirSync(marks);
  app = createAgent(loadConfig({ FILEDECK_ROOT: root, FILEDECK_NODE: "t" } as never));
});
after(async () => {
  await (app as unknown as { close: () => Promise<void> }).close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const cmd = (tag: string) => `touch ${marks}/${tag}; cat`;
/** A repository with two commits, a.txt (filtered) and b.txt, set up by `hostile` after the commits. */
function makeRepo(name: string, attrsIn: "tree" | "info", hostile: (d: string) => void, filterName = "x") {
  const d = path.join(root, name);
  fs.mkdirSync(d, { recursive: true });
  git(d, "init", "-q");
  write(path.join(d, "a.txt"), "alpha\n");
  write(path.join(d, "b.txt"), "bravo\n");
  if (attrsIn === "tree") write(path.join(d, ".gitattributes"), `a.txt filter=${filterName}\n`);
  git(d, "add", "-A");
  git(d, "commit", "-qm", "first");
  write(path.join(d, "b.txt"), "bravo\ncharlie\n");
  git(d, "commit", "-qam", "second");
  if (attrsIn === "info") write(path.join(d, ".git/info/attributes"), `a.txt filter=${filterName}\n`);
  hostile(d);
  stale(path.join(d, "a.txt")); // unchanged content, different stat data: this is when Git runs the clean filter
  return d;
}
const cfg = (d: string, ...kv: string[]) => {
  for (let i = 0; i < kv.length; i += 2) git(d, "config", kv[i]!, kv[i + 1]!);
};

const repos: Record<string, { control: (d: string) => void }> = {};
function hostileSet() {
  makeRepo("clean", "tree", (d) => cfg(d, "filter.x.clean", cmd("clean")));
  makeRepo("process", "tree", (d) => cfg(d, "filter.x.process", `touch ${marks}/process`, "filter.x.required", "true"));
  makeRepo("include", "tree", (d) => {
    write(path.join(d, "extra.cfg"), `[filter "x"]\n\tclean = ${cmd("include")}\n\tsmudge = ${cmd("include-smudge")}\n`);
    cfg(d, "include.path", path.join(d, "extra.cfg"));
  });
  makeRepo("includeif", "tree", (d) => {
    write(path.join(d, "extra.cfg"), `[filter "x"]\n\tclean = ${cmd("includeif")}\n`);
    cfg(d, "includeIf.gitdir:**/.git.path", path.join(d, "extra.cfg"), "includeIf.gitdir:/**.path", "x");
    fs.appendFileSync(path.join(d, ".git/config"), `[includeIf "gitdir:${d}/.git"]\n\tpath = ${path.join(d, "extra.cfg")}\n`);
  });
  makeRepo("info", "info", (d) => cfg(d, "filter.x.clean", cmd("info")));
  makeRepo("oddname", "tree", (d) => fs.appendFileSync(path.join(d, ".git/config"), `[filter "a.b"]\n\tclean = ${cmd("oddname")}\n`), "a.b");
  makeRepo("fsmonitor", "tree", (d) => cfg(d, "core.fsmonitor", `touch ${marks}/fsmonitor; cat`));
  makeRepo("hooks", "tree", (d) => {
    const h = path.join(d, "evilhooks");
    for (const n of ["pre-commit", "post-index-change", "reference-transaction", "fsmonitor-watchman"]) write(path.join(h, n), `#!/bin/sh\ntouch ${marks}/hook-${n}\n`), fs.chmodSync(path.join(h, n), 0o755);
    cfg(d, "core.hooksPath", h);
    for (const n of ["post-index-change", "reference-transaction"]) write(path.join(d, ".git/hooks", n), `#!/bin/sh\ntouch ${marks}/hook-${n}\n`), fs.chmodSync(path.join(d, ".git/hooks", n), 0o755);
  });
  makeRepo("misc", "tree", (d) => {
    cfg(d, "core.pager", `touch ${marks}/pager; cat`, "diff.external", `touch ${marks}/extdiff`, "diff.x.textconv", `touch ${marks}/textconv; cat`, "core.sshCommand", `touch ${marks}/ssh`, "credential.helper", `!touch ${marks}/cred`, "core.alternateRefsCommand", `touch ${marks}/altrefs`);
    cfg(d, "alias.status", `!touch ${marks}/alias`);
  });
}

/** Every route, on the repository named `name`. Returns status, info and show bodies for the correctness checks. */
async function allRoutes(name: string) {
  const get = async (url: string) => {
    const r = await app.request(url);
    assert.ok(r.status < 500, `${url} -> ${r.status} ${await r.clone().text()}`);
    return { status: r.status, body: (await r.json().catch(() => null)) as any };
  };
  const q = encodeURIComponent;
  const head = git(path.join(root, name), "rev-parse", "HEAD");
  const prev = git(path.join(root, name), "rev-parse", "HEAD~1");
  const out = {
    list: await get(`/api/git/status?path=/&fresh=1`),
    inside: await get(`/api/git/status?path=${q("/" + name)}&fresh=1`),
    info: await get(`/api/git/info?path=${q("/" + name + "/a.txt")}&fresh=1`),
    infoDir: await get(`/api/git/info?path=${q("/" + name)}&fresh=1`),
    show: await get(`/api/git/show?path=${q("/" + name + "/a.txt")}&rev=HEAD`),
    showWork: await get(`/api/git/show?path=${q("/" + name + "/a.txt")}`),
    refs: await get(`/api/git/refs?path=${q("/" + name)}`),
    worktrees: await get(`/api/git/worktrees?path=${q("/" + name)}`),
    diff: await get(`/api/git/diff?path=${q("/" + name)}&base=${prev}&head=${head}`),
    blob: await get(`/api/git/blob?path=${q("/" + name)}&sha=${head}&file=a.txt`),
  };
  return out;
}

test("hostile repositories: no Git route runs a repository-configured command, and the answers stay right", async () => {
  hostileSet();
  for (const name of ["clean", "process", "include", "includeif", "info", "oddname", "fsmonitor", "hooks", "misc"]) {
    const d = path.join(root, name);
    // the control: plain Git with the same config does run the command, so the repository really is hostile
    if (name !== "misc" && name !== "hooks") {
      try {
        execFileSync("git", ["-c", "safe.directory=*", "status", "--porcelain"], { cwd: d, env: { ...ENV, GIT_OPTIONAL_LOCKS: "0" }, stdio: "ignore" });
      } catch {
        // a required filter that fails makes plain Git exit non-zero; the command still ran
      }
      assert.ok(marked().length > 0, `${name}: the control run should have fired the hostile command`);
      reset();
      stale(path.join(d, "a.txt"));
    }
    const indexBefore = fs.readFileSync(path.join(d, ".git/index"));
    const r = await allRoutes(name);
    assert.deepEqual(marked(), [], `${name}: a repository command ran`);
    assert.deepEqual(fs.readFileSync(path.join(d, ".git/index")), indexBefore, `${name}: index was written`);
    assert.ok(!fs.existsSync(path.join(d, ".git/index.lock")));
    // correctness: a.txt has unchanged content, so it is clean; the repository has no modified, staged or untracked entry
    const pill = r.list.body.children[name];
    assert.ok(pill, `${name}: listed as a repository`);
    assert.equal(pill.branch, "main");
    assert.deepEqual([pill.staged, pill.modified, pill.conflicted], [0, 0, 0], name); // untracked: the hostile files themselves
    assert.equal(r.inside.body.entries["a.txt"], undefined, name);
    assert.equal(r.show.status, 200);
    assert.equal(r.show.body.content, "alpha\n");
    assert.equal(r.showWork.body.content, "alpha\n");
    assert.equal(r.diff.status, 200, JSON.stringify(r.diff.body));
    assert.deepEqual(r.diff.body.files.map((f: any) => f.path), ["b.txt"]);
    assert.equal(r.blob.status, 200);
    assert.equal(r.info.status, 200);
  }
});

test("a filtered file is reported consistently: clean when untouched, modified when edited", async () => {
  const d = path.join(root, "clean");
  const one = async () => (await (await app.request("/api/git/status?path=/clean&fresh=1")).json()) as any;
  stale(path.join(d, "a.txt"));
  assert.equal((await one()).entries["a.txt"] ?? "", "");
  write(path.join(d, "a.txt"), "alpha edited\n");
  assert.equal((await one()).entries["a.txt"], "M");
  assert.deepEqual(marked(), []);
});

test("a submodule's own filters do not run when the superproject is read", async () => {
  reset();
  const sub = path.join(tmp, "subsrc");
  fs.mkdirSync(sub);
  git(sub, "init", "-q");
  write(path.join(sub, "s.txt"), "s\n");
  write(path.join(sub, ".gitattributes"), "s.txt filter=x\n");
  git(sub, "add", "-A");
  git(sub, "commit", "-qm", "sub");
  const d = path.join(root, "super");
  fs.mkdirSync(d);
  git(d, "init", "-q");
  write(path.join(d, "t.txt"), "t\n");
  git(d, "add", "-A");
  git(d, "commit", "-qm", "super");
  git(d, "submodule", "add", "-q", sub, "mod");
  git(d, "commit", "-qm", "add sub");
  git(path.join(d, "mod"), "config", "filter.x.clean", cmd("submodule"));
  stale(path.join(d, "mod/s.txt"));
  try {
    execFileSync("git", ["-c", "safe.directory=*", "status", "--porcelain"], { cwd: d, env: { ...ENV, GIT_OPTIONAL_LOCKS: "0" }, stdio: "ignore" });
  } catch {}
  assert.deepEqual(marked(), ["submodule"], "control: plain Git runs the submodule's filter");
  reset();
  stale(path.join(d, "mod/s.txt"));
  const r = await app.request("/api/git/status?path=/super&fresh=1");
  assert.equal(r.status, 200);
  const r2 = await app.request("/api/git/info?path=/super&fresh=1");
  assert.equal(r2.status, 200);
  assert.deepEqual(marked(), [], "the submodule's clean filter ran");
});

test("gc.auto and maintenance never start from a read", async () => {
  const d = path.join(root, "gc");
  fs.mkdirSync(d);
  git(d, "init", "-q");
  for (let i = 0; i < 30; i++) {
    write(path.join(d, `f${i}.txt`), `${i}\n`);
    git(d, "add", "-A");
    git(d, "commit", "-qm", `c${i}`);
  }
  cfg(d, "gc.auto", "1", "gc.autoPackLimit", "1", "maintenance.auto", "true", "gc.autoDetach", "false");
  const before = fs.readdirSync(path.join(d, ".git/objects/pack"));
  await app.request("/api/git/status?path=/gc&fresh=1");
  await app.request("/api/git/info?path=/gc/f1.txt&fresh=1");
  assert.deepEqual(fs.readdirSync(path.join(d, ".git/objects/pack")), before);
  assert.ok(!fs.existsSync(path.join(d, ".git/gc.pid")) && !fs.existsSync(path.join(d, ".git/gc.log")));
});

test("findRepo goes on upwards past a .git that is not a repository", async () => {
  const outer = path.join(root, "outer");
  fs.mkdirSync(outer);
  git(outer, "init", "-q");
  const inner = path.join(outer, "inner/deeper");
  fs.mkdirSync(path.join(inner, ".git"), { recursive: true }); // empty .git directory
  const r = await findRepo(root, inner);
  assert.equal(r?.workDir, outer);
  write(path.join(outer, "inner/.git"), "gitdir: /nowhere/at/all\n"); // a .git file pointing nowhere
  assert.equal((await findRepo(root, path.join(outer, "inner")))?.workDir, outer);
  assert.equal(await findRepo(root, path.join(root, "gc/..")), null, "no repository above the root: still none");
});

test("runGit overrides drivers whose names contain dots, and fails closed when it cannot read the config", async () => {
  const d = path.join(root, "oddname");
  const r = await runGit(d, ["--git-dir", path.join(d, ".git"), "--work-tree", d, "status", "--porcelain"]);
  assert.equal(r.code, 0);
  assert.deepEqual(marked(), []);
  const bad = await runGit(path.join(tmp, "marks"), ["--git-dir", path.join(tmp, "nonexistent"), "status"]);
  assert.notEqual(bad.code, 0);
});
