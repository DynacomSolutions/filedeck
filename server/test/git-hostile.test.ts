import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createAgent } from "../src/agent.ts";
import { loadConfig } from "../src/config.ts";
import { findRepo, repoAt, repoArgs, runGit, showFile } from "../src/git.ts";
import { resetSandbox } from "../src/sandbox.ts";
import { useSandbox } from "./sandbox-env.ts";

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

before(async () => {
  // These repositories are hostile in ways the path checks admit (include files, filters, hooks): the sandbox state is the
  // one the kernel allows. Without Landlock the fallback would refuse some of them outright, so the checks run unsandboxed.
  const box = await useSandbox();
  if (box.state !== "landlock") {
    process.env.FILEDECK_SANDBOX = "off";
    resetSandbox();
  }
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

/**
 * The folder listing answers within a time budget and leaves a repository whose status is not ready as "pending" (the computation goes on and fills the cache).
 * On a loaded host the first answer can be such a partial one, so ask again (from the cache) until the repository has its status.
 */
async function settledList(name: string, get: (url: string) => Promise<{ status: number; body: any }>) {
  let res = await get(`/api/git/status?path=/&fresh=1&budget=5000`);
  for (let i = 0; i < 120 && res.body?.children?.[name]?.branch === undefined; i++) {
    await new Promise((r) => setTimeout(r, 500));
    res = await get(`/api/git/status?path=/&budget=5000`);
  }
  return res;
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
    list: await settledList(name, get),
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

test("signature and program settings in a repository's config never run a program (stash list, log, show)", async () => {
  reset();
  const d = path.join(root, "signed");
  fs.mkdirSync(d);
  git(d, "init", "-q");
  write(path.join(d, "a.txt"), "alpha\n");
  git(d, "add", "-A");
  git(d, "commit", "-qm", "first");
  const head = git(d, "rev-parse", "HEAD");
  const tree = git(d, "rev-parse", "HEAD^{tree}");
  // a commit that carries a (fake) signature header, so that showing signatures makes Git call the verifier
  const raw = `tree ${tree}\nparent ${head}\nauthor t <t@example.test> 1700000000 +0000\ncommitter t <t@example.test> 1700000000 +0000\ngpgsig -----BEGIN PGP SIGNATURE-----\n \n abcd\n -----END PGP SIGNATURE-----\n\nWIP on main\n`;
  const sha = execFileSync("git", ["hash-object", "-t", "commit", "-w", "--stdin"], { cwd: d, env: ENV, input: raw, encoding: "utf8" }).trim();
  git(d, "update-ref", "--create-reflog", "-m", "WIP on main", "refs/stash", sha);
  const prog = path.join(tmp, "verifier.sh");
  write(prog, `#!/bin/sh\ntouch ${marks}/verifier\n`);
  fs.chmodSync(prog, 0o755);
  cfg(d, "log.showSignature", "true", "gpg.program", prog, "gpg.openpgp.program", prog, "gpg.x509.program", prog, "gpg.ssh.program", prog, "core.sshCommand", prog, "core.editor", prog, "core.askPass", prog, "credential.helper", `!${prog}`);
  git(d, "config", "gpg.format", "openpgp");
  // the control: plain Git with this config does call the program
  execFileSync("git", ["-c", "safe.directory=*", "stash", "list"], { cwd: d, env: ENV, stdio: "ignore" });
  execFileSync("git", ["-c", "safe.directory=*", "log", "-1", "refs/stash"], { cwd: d, env: ENV, stdio: "ignore" });
  assert.deepEqual(marked(), ["verifier"], "control: plain Git runs the verifier");
  reset();
  for (const url of ["/api/git/info?path=/signed&fresh=1", "/api/git/info?path=/signed/a.txt&fresh=1", "/api/git/status?path=/signed&fresh=1"]) {
    const r = await app.request(url);
    assert.equal(r.status, 200, url);
  }
  const r = await runGit(d, ["--git-dir", path.join(d, ".git"), "--work-tree", d, "stash", "list"]);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /WIP on main/);
  await runGit(d, ["--git-dir", path.join(d, ".git"), "--work-tree", d, "log", "-1", "refs/stash"]);
  await runGit(d, ["--git-dir", path.join(d, ".git"), "--work-tree", d, "show", "refs/stash"]);
  assert.deepEqual(marked(), [], "a repository-configured program ran");
});

test("a relative gitdir or commondir that leaves the root is not a repository", async () => {
  const outside = path.join(tmp, "outside-repo");
  fs.mkdirSync(outside);
  git(outside, "init", "-q");
  // a work tree under the root whose `.git` file points, relatively, at a repository outside it
  const a = path.join(root, "escape-gitdir");
  fs.mkdirSync(a);
  write(path.join(a, ".git"), `gitdir: ${path.relative(a, path.join(outside, ".git"))}\n`);
  assert.equal(await repoAt(root, a), null);
  // an admin directory inside the root whose commondir leaves it
  const admin = path.join(root, "escape-admin");
  fs.mkdirSync(admin, { recursive: true });
  write(path.join(admin, "HEAD"), "ref: refs/heads/main\n");
  write(path.join(admin, "commondir"), `${path.relative(admin, path.join(outside, ".git"))}\n`);
  const b = path.join(root, "escape-commondir");
  fs.mkdirSync(b);
  write(path.join(b, ".git"), `gitdir: ${path.relative(b, admin)}\n`);
  assert.equal(await repoAt(root, b), null);
  // a relative gitdir that stays inside the root still works
  const ok = path.join(root, "inside-ok");
  fs.mkdirSync(ok);
  git(ok, "init", "-q", "--separate-git-dir", path.join(root, "inside-ok-git"));
  write(path.join(ok, ".git"), `gitdir: ../inside-ok-git\n`);
  assert.equal((await repoAt(root, ok))?.gitDir, path.join(root, "inside-ok-git"));
});

const plainGit = (cwd: string, ...args: string[]) => {
  try {
    execFileSync("git", ["-c", "safe.directory=*", "-c", "protocol.ext.allow=always", ...args], { cwd, env: { ...ENV, GIT_OPTIONAL_LOCKS: "0" }, stdio: "ignore" });
  } catch {
    // a failing command is fine: only the marks matter
  }
};

test("a partial clone's lazy fetch never runs a program named by the repository (uploadpack, ext transport)", async () => {
  reset();
  const src = path.join(tmp, "lazysrc");
  fs.mkdirSync(src);
  git(src, "init", "-q");
  git(src, "config", "uploadpack.allowFilter", "true");
  git(src, "config", "uploadpack.allowAnySHA1InWant", "true");
  write(path.join(src, "a.txt"), "alpha\n");
  git(src, "add", "-A");
  git(src, "commit", "-qm", "one");
  const prog = path.join(tmp, "uploadpack.sh");
  write(prog, `#!/bin/sh\ntouch ${marks}/uploadpack\nexec git-upload-pack "$@"\n`);
  fs.chmodSync(prog, 0o755);
  const extProg = path.join(tmp, "extprog.sh");
  write(extProg, `#!/bin/sh\ntouch ${marks}/ext\nexec git-upload-pack "$1"\n`);
  fs.chmodSync(extProg, 0o755);
  // a partial clone without its blobs: reading a file makes Git fetch it from the remote, with the remote's configured program
  const clone = (d: string, kind: string) => {
    git(tmp, "clone", "-q", "--no-checkout", "--filter=blob:none", `file://${src}`, d);
    if (kind === "uploadpack") git(d, "config", "remote.origin.uploadpack", prog);
    else {
      git(d, "config", "remote.origin.url", `ext::${extProg} ${src}`);
      git(d, "config", "protocol.allow", "always");
    }
  };
  for (const kind of ["uploadpack", "ext"]) {
    clone(path.join(tmp, `control-${kind}`), kind);
    plainGit(path.join(tmp, `control-${kind}`), "cat-file", "-p", "HEAD:a.txt");
    assert.deepEqual(marked(), [kind], `control: plain Git runs the ${kind} program`);
    reset();
    const d = path.join(root, `lazy-${kind}`);
    clone(d, kind);
    const repo = await findRepo(root, d);
    assert.ok(repo);
    assert.equal(await showFile(repo!, "HEAD", "a.txt", 1024), null, "the blob is not fetched");
    const head = git(d, "rev-parse", "HEAD");
    for (const url of [`/api/git/show?path=/lazy-${kind}/a.txt&rev=HEAD`, `/api/git/blob?path=/lazy-${kind}&sha=${head}&file=a.txt`, `/api/git/status?path=/lazy-${kind}&fresh=1`]) await app.request(url);
    assert.deepEqual(marked(), [], `${kind}: a program ran`);
  }
});

test("a .gitmodules override of the submodule ignore setting does not make status enter the submodule", async () => {
  reset();
  const sub = path.join(tmp, "subsrc2");
  fs.mkdirSync(sub);
  git(sub, "init", "-q");
  write(path.join(sub, "s.txt"), "s\n");
  write(path.join(sub, ".gitattributes"), "s.txt filter=x\n");
  git(sub, "add", "-A");
  git(sub, "commit", "-qm", "sub");
  const d = path.join(root, "super2");
  fs.mkdirSync(d);
  git(d, "init", "-q");
  write(path.join(d, "t.txt"), "t\n");
  git(d, "add", "-A");
  git(d, "commit", "-qm", "super");
  git(d, "submodule", "add", "-q", sub, "mod");
  git(d, "commit", "-qm", "add sub");
  git(path.join(d, "mod"), "config", "filter.x.clean", cmd("submodule-ignore"));
  fs.appendFileSync(path.join(d, ".gitmodules"), "\tignore = none\n");
  stale(path.join(d, "mod/s.txt"));
  plainGit(d, "status", "--porcelain");
  assert.deepEqual(marked(), ["submodule-ignore"], "control: plain Git runs the submodule's filter");
  reset();
  stale(path.join(d, "mod/s.txt"));
  assert.equal((await app.request("/api/git/status?path=/super2&fresh=1")).status, 200);
  assert.equal((await app.request("/api/git/info?path=/super2&fresh=1")).status, 200);
  assert.deepEqual(marked(), [], "the submodule's clean filter ran");
});

test("a repository whose objects reach outside the root through alternates or links is refused", async () => {
  const out = path.join(tmp, "alt-outside");
  fs.mkdirSync(out);
  git(out, "init", "-q");
  write(path.join(out, "key.txt"), "outside secret\n");
  git(out, "add", "-A");
  git(out, "commit", "-qm", "outside");
  const outHead = git(out, "rev-parse", "HEAD");
  const mk = (name: string) => {
    const d = path.join(root, name);
    fs.mkdirSync(d);
    git(d, "init", "-q");
    return d;
  };
  const a = mk("alt-file");
  write(path.join(a, ".git/objects/info/alternates"), path.join(out, ".git/objects") + "\n");
  assert.equal(git(a, "show", `${outHead.slice(0, 5)}:key.txt`), "outside secret", "control: Git reads the outside object through the alternate");
  assert.equal(await repoAt(root, a), null, "alternates leading outside");
  const body = await (await app.request(`/api/git/show?path=/alt-file/key.txt&rev=${outHead.slice(0, 7)}`)).text();
  assert.ok(!body.includes("outside secret"));
  // nested: an alternate inside the root whose own alternates lead out
  const mid = mk("alt-mid");
  write(path.join(mid, ".git/objects/info/alternates"), path.join(out, ".git/objects") + "\n");
  const b = mk("alt-nested");
  write(path.join(b, ".git/objects/info/alternates"), path.join(mid, ".git/objects") + "\n");
  assert.equal(await repoAt(root, b), null, "nested alternates leading outside");
  // an alternate inside the root is fine
  const c = mk("alt-ok");
  mk("alt-ok-src");
  write(path.join(c, ".git/objects/info/alternates"), "../../../alt-ok-src/.git/objects\n");
  assert.ok(await repoAt(root, c));
  // symlinked entries
  for (const entry of ["objects", "refs", "packed-refs"]) {
    const d = mk(`link-${entry}`);
    const target = path.join(out, ".git", entry);
    if (!fs.existsSync(target)) write(target, "");
    fs.rmSync(path.join(d, ".git", entry), { recursive: true, force: true });
    fs.symlinkSync(target, path.join(d, ".git", entry));
    assert.equal(await repoAt(root, d), null, `${entry} linked outside`);
  }
});

test("git is told the validated git and common directories, so a commondir file swapped afterwards is not followed", async () => {
  const main = path.join(root, "pin-main");
  fs.mkdirSync(main);
  git(main, "init", "-q");
  write(path.join(main, "f.txt"), "f\n");
  git(main, "add", "-A");
  git(main, "commit", "-qm", "one");
  const wt = path.join(root, "pin-wt");
  git(main, "worktree", "add", "-q", wt);
  // the agent's view: no host paths, so the work tree points at its admin directory relatively
  write(path.join(wt, ".git"), "gitdir: ../pin-main/.git/worktrees/pin-wt\n");
  write(path.join(main, ".git/worktrees/pin-wt/commondir"), "../..\n");
  const other = path.join(tmp, "pin-other");
  fs.mkdirSync(other);
  git(other, "init", "-q");
  const repo = (await findRepo(root, wt))!;
  assert.equal(repo.kind, "linked");
  const adminDir = repo.gitDir;
  const want = fs.realpathSync(path.join(main, ".git"));
  const common = async () => (await runGit(wt, [...repoArgs(repo), "rev-parse", "--path-format=absolute", "--git-common-dir"])).stdout.trim();
  assert.equal(await common(), want);
  fs.writeFileSync(path.join(adminDir, "commondir"), path.join(other, ".git") + "\n"); // swapped after the check
  assert.equal(await common(), want, "git re-read the commondir file");
  // an absolute commondir is checked re-based onto the root, and must be used the same way
  fs.writeFileSync(path.join(adminDir, "commondir"), "/pin-main/.git\n");
  assert.equal(await common(), want);
});

test("a commondir file that appears after the check is not followed, also in a repository that has none (bare, plain work tree)", async () => {
  const other = path.join(tmp, "late-other");
  fs.mkdirSync(other);
  git(other, "init", "-q");
  git(other, "commit", "-q", "--allow-empty", "-m", "elsewhere");
  const bare = path.join(root, "late-bare.git");
  git(tmp, "init", "-q", "--bare", bare);
  const plain = path.join(root, "late-plain");
  fs.mkdirSync(plain);
  git(plain, "init", "-q");
  for (const [dir, gitDir] of [[bare, bare], [plain, path.join(plain, ".git")]] as const) {
    const repo = (await findRepo(root, dir))!;
    assert.ok(repo);
    const want = fs.realpathSync(gitDir);
    const common = async () => (await runGit(dir, [...repoArgs(repo), "rev-parse", "--path-format=absolute", "--git-common-dir"])).stdout.trim();
    assert.equal(await common(), want);
    fs.writeFileSync(path.join(gitDir, "commondir"), path.join(other, ".git") + "\n"); // created after the check
    assert.equal(await common(), want, `${dir}: git read a commondir file that did not exist when the repository was checked`);
    const isBare = (await runGit(dir, [...repoArgs(repo), "rev-parse", "--is-bare-repository"])).stdout.trim();
    assert.equal(isBare, repo.kind === "bare" ? "true" : "false");
  }
});
