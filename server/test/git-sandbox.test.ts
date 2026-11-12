import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createAgent } from "../src/agent.ts";
import { loadConfig } from "../src/config.ts";
import { findRepo, remotes, repoAt, repoStatus, runGit, repoArgs, showFile } from "../src/git.ts";
import { plainGitDir } from "../src/git-sandbox.ts";
import { resetSandbox, sandboxInfo } from "../src/sandbox.ts";
import { useSandbox } from "./sandbox-env.ts";

/**
 * work-item: the Git processes the agent starts are confined by the kernel (Landlock, through the native helper), so a link
 * inside a repository that leads outside the served root fails when Git opens it, whatever the path checks said. Without
 * Landlock the agent only uses git directories with no links and no include settings. The tests print the mode that ran.
 */
let tmp: string, root: string, out: string, box: Awaited<ReturnType<typeof useSandbox>>, app: ReturnType<typeof createAgent>;
const ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.test", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.test" };
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "init.defaultBranch=main", "-c", "protocol.file.allow=always", "-c", "safe.directory=*", ...args], { cwd, env: ENV, encoding: "utf8" }).trim();
const write = (p: string, s: string) => (fs.mkdirSync(path.dirname(p), { recursive: true }), fs.writeFileSync(p, s));
const mk = (name: string) => {
  const d = path.join(root, name);
  fs.mkdirSync(d, { recursive: true });
  git(d, "init", "-q");
  write(path.join(d, "own.txt"), "mine\n");
  git(d, "add", "-A");
  git(d, "commit", "-qm", "own");
  return d;
};
const landlock = () => box.state === "landlock";
const live = (name: string, fn: () => Promise<void>) =>
  test(name, async (t) => {
    if (!landlock()) return t.skip(`git sandbox live: skipped (${box.why})`);
    await fn();
  });

let outHead = "";
before(async () => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "filedeck-gitsandbox-")));
  fs.chmodSync(tmp, 0o755);
  root = path.join(tmp, "host");
  out = path.join(tmp, "outside");
  fs.mkdirSync(root);
  fs.mkdirSync(out);
  box = await useSandbox();
  app = createAgent(loadConfig({ FILEDECK_ROOT: root, FILEDECK_NODE: "t" } as never));
  // a repository outside the root, packed, with a file that must never be readable through the agent
  git(out, "init", "-q");
  write(path.join(out, "key.txt"), "outside secret\n");
  git(out, "add", "-A");
  git(out, "commit", "-qm", "outside");
  git(out, "gc", "-q");
  outHead = git(out, "rev-parse", "HEAD");
  write(path.join(out, "include.cfg"), '[remote "origin"]\n\turl = https://outside.example/secret.git\n');
});
after(async () => {
  await (app as unknown as { close: () => Promise<void> }).close();
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.rmSync(box.dir, { recursive: true, force: true });
  delete process.env.FILEDECK_SANDBOX_HELPER;
  delete process.env.FILEDECK_SANDBOX;
  resetSandbox();
});

live("a link below the git directory's top level cannot lead Git to objects outside the root (pack folder)", async () => {
  const d = mk("packlink");
  fs.rmSync(path.join(d, ".git/objects/pack"), { recursive: true, force: true });
  fs.symlinkSync(path.join(out, ".git/objects/pack"), path.join(d, ".git/objects/pack"));
  assert.equal(git(d, "show", `${outHead}:key.txt`), "outside secret", "control: plain Git reads the outside object through the link");
  const r = await findRepo(root, d);
  assert.ok(r, "the path checks accept this repository: only the process confinement stops the read");
  assert.equal(await showFile(r!, outHead, "key.txt", 1024), null);
  const res = await app.request(`/api/git/show?path=/packlink/key.txt&rev=${outHead}`);
  assert.ok(!(await res.text()).includes("outside secret"));
});

live("the index cannot be a link to an index outside the root", async () => {
  const d = mk("indexlink");
  fs.rmSync(path.join(d, ".git/index"));
  fs.symlinkSync(path.join(out, ".git/index"), path.join(d, ".git/index"));
  assert.match(git(d, "ls-files"), /key\.txt/, "control: plain Git reads the outside index");
  const r = (await findRepo(root, d))!;
  assert.ok(r);
  const st = await repoStatus(r).catch(() => null);
  assert.ok(!st || ![...st.files.keys()].includes("key.txt"), "an outside file was listed");
});

live("an include.path in the repository's config cannot read a file outside the root", async () => {
  const d = mk("includelink");
  git(d, "config", "include.path", path.join(out, "include.cfg"));
  assert.match(git(d, "remote", "-v"), /outside\.example/, "control: plain Git reads the included file");
  const r = (await findRepo(root, d))!;
  assert.ok(r);
  assert.deepEqual((await remotes(r)).filter((x) => x.url.includes("outside.example")), []);
});

live("repositories of every shape still work under the sandbox: plain, linked worktree, bare, with submodules", async () => {
  const main = mk("shape-main");
  git(main, "branch", "feature");
  const wt = path.join(root, "shape-wt");
  git(main, "worktree", "add", "-q", wt, "feature");
  write(path.join(wt, ".git"), "gitdir: ../shape-main/.git/worktrees/shape-wt\n"); // the agent's view: no host paths
  write(path.join(main, ".git/worktrees/shape-wt/commondir"), "../..\n");
  git(root, "clone", "-q", "--bare", main, path.join(root, "shape-bare.git"));
  const sub = path.join(tmp, "subsrc");
  fs.mkdirSync(sub);
  git(sub, "init", "-q");
  write(path.join(sub, "s.txt"), "s\n");
  git(sub, "add", "-A");
  git(sub, "commit", "-qm", "sub");
  const sup = mk("shape-super");
  git(sup, "submodule", "add", "-q", sub, "mod");
  git(sup, "commit", "-qm", "add sub");
  write(path.join(sup, "untracked.txt"), "u\n");
  for (const name of ["shape-main", "shape-wt", "shape-bare.git", "shape-super"]) {
    const info = await app.request(`/api/git/info?path=/${name}&fresh=1`);
    assert.equal(info.status, 200, name);
    const j = (await info.json()) as { repo: { kind: string; summary: { branch: string | null } } | null };
    assert.ok(j.repo, `${name}: not recognised as a repository`);
    assert.equal(j.repo.kind, { "shape-wt": "linked", "shape-bare.git": "bare" }[name] ?? "worktree", name);
    assert.ok(name === "shape-wt" ? j.repo.summary.branch === "feature" : j.repo.summary.branch === "main" || j.repo.kind === "bare", name);
  }
  const st = (await (await app.request("/api/git/status?path=/shape-super&fresh=1")).json()) as { entries: Record<string, string> };
  assert.equal(st.entries["untracked.txt"], "U");
  const wts = (await (await app.request("/api/git/worktrees?path=/shape-main")).json()) as { worktrees: unknown[] };
  assert.equal(wts.worktrees.length, 2);
  const refs = (await (await app.request("/api/git/refs?path=/shape-bare.git")).json()) as { bare: boolean; refs: string[] };
  assert.equal(refs.bare, true);
  assert.ok(refs.refs.includes("main") && refs.refs.includes("feature"));
  const show = await app.request("/api/git/show?path=/shape-main/own.txt&rev=HEAD");
  assert.equal(show.status, 200);
});

test("without Landlock a git directory with a link or an include setting is refused; a plain one is used", async () => {
  process.env.FILEDECK_SANDBOX_HELPER = path.join(box.dir, "missing");
  delete process.env.FILEDECK_SANDBOX;
  resetSandbox();
  try {
    const info = await sandboxInfo();
    console.log(`# git sandbox fallback tests: mode ${info.state}`);
    assert.equal(info.state, "fallback");
    const plain = mk("fb-plain");
    assert.ok(await repoAt(root, plain), "a plain repository is used");
    const linked = mk("fb-link");
    fs.rmSync(path.join(linked, ".git/objects/pack"), { recursive: true, force: true });
    fs.symlinkSync(path.join(out, ".git/objects/pack"), path.join(linked, ".git/objects/pack"));
    assert.equal(await repoAt(root, linked), null, "a link at depth");
    const inc = mk("fb-include");
    git(inc, "config", "include.path", path.join(out, "include.cfg"));
    assert.equal(await repoAt(root, inc), null, "include.path");
    const incIf = mk("fb-includeif");
    fs.appendFileSync(path.join(incIf, ".git/config"), `[includeIf "gitdir:/x/"]\n\tpath = ${path.join(out, "include.cfg")}\n`);
    assert.equal(await repoAt(root, incIf), null, "includeIf");
    assert.equal(await plainGitDir(path.join(plain, ".git")), true);
    assert.equal(await plainGitDir(path.join(linked, ".git")), false);
    const res = await app.request("/api/git/info?path=/fb-link&fresh=1");
    assert.ok(res.status >= 400 || !(await res.text()).includes("branch"), "the git feature does not use the refused repository");
    // require: the Git features answer a clear error
    process.env.FILEDECK_SANDBOX = "require";
    resetSandbox();
    await assert.rejects(repoAt(root, plain), (e: Error & { status?: number }) => e.status === 503 && /sandbox/.test(e.message));
    const r503 = await app.request("/api/git/info?path=/fb-plain&fresh=1");
    assert.equal(r503.status, 503);
    assert.match(await r503.text(), /sandbox/);
    // off: today's checks only
    process.env.FILEDECK_SANDBOX = "off";
    resetSandbox();
    assert.ok(await repoAt(root, linked));
  } finally {
    delete process.env.FILEDECK_SANDBOX;
    process.env.FILEDECK_SANDBOX_HELPER = box.bin;
    resetSandbox();
  }
});

test("the helper's 'Landlock unsupported' status is handled: at probe time it selects the fallback, at run time Git is not run", async () => {
  const fake = path.join(tmp, "fake-sandbox.sh");
  const repoDir = mk("fake-helper");
  try {
    // 1. the probe says no
    write(fake, "#!/bin/sh\nexit 70\n");
    fs.chmodSync(fake, 0o755);
    process.env.FILEDECK_SANDBOX_HELPER = fake;
    resetSandbox();
    assert.equal((await sandboxInfo()).state, "fallback");
    // 2. the probe says yes but the run says no (a kernel or seccomp change in between)
    write(fake, '#!/bin/sh\n[ "$1" = "--probe" ] && exit 0\nexit 70\n');
    resetSandbox();
    assert.equal((await sandboxInfo()).state, "landlock");
    const r = (await findRepo(root, repoDir))!;
    assert.ok(r);
    const res = await runGit(repoDir, [...repoArgs(r), "status", "--porcelain"]);
    assert.equal(res.code, null);
    assert.match(res.stderr, /sandbox unavailable/);
    assert.equal(res.stdout, "", "Git must not have run");
    const again = await sandboxInfo(); // the answer was forgotten: it is found afresh
    assert.equal(again.state, "landlock");
  } finally {
    process.env.FILEDECK_SANDBOX_HELPER = box.bin;
    resetSandbox();
  }
});

test("as root, Git runs as the owner of the git directory (the privilege drop)", async (t) => {
  if (process.getuid?.() !== 0) return t.skip("git sandbox live: skipped (not running as root)");
  const d = mk("owned");
  execFileSync("chown", ["-R", "65534:65534", d]);
  for (const p of [tmp, root]) fs.chmodSync(p, 0o755);
  const r = (await findRepo(root, d))!;
  assert.ok(r);
  const res = await runGit(d, [...repoArgs(r), "status", "--porcelain=v2", "--branch"]);
  assert.equal(res.code, 0, res.stderr);
  assert.match(res.stdout, /branch\.head main/);
});

test("as root, a root-owned repository the unprivileged user cannot read is read by the agent's own user with no capability", async (t) => {
  if (process.getuid?.() !== 0) return t.skip("git sandbox live: skipped (not running as root)");
  if (!landlock()) return t.skip(`git sandbox live: skipped (${box.why})`);
  const d = mk("rootowned-private");
  execFileSync("chmod", ["-R", "go-rwx", d]);
  for (const p of [tmp, root]) fs.chmodSync(p, 0o755);
  const r = (await findRepo(root, d))!;
  assert.ok(r);
  const st = await runGit(d, [...repoArgs(r), "status", "--porcelain=v2", "--branch"]);
  assert.equal(st.code, 0, st.stderr);
  assert.match(st.stdout, /branch\.head main/);
  const log = await runGit(d, [...repoArgs(r), "log", "--format=%s"]);
  assert.equal(log.stdout.trim(), "own");
});

test("repositories are still found and read in the mode that ran here", async () => {
  const d = mk("plain-final");
  const r = await findRepo(root, d);
  assert.ok(r);
  assert.equal((await repoStatus(r!)).summary.branch, "main");
  console.log(`# git sandbox: this run used ${(await sandboxInfo()).state}`);
});

test("git's own error text never reaches the client (a file Git was made to read is not quoted back)", async () => {
  const d = mk("quote");
  const repo = (await findRepo(root, d))!;
  assert.ok(repo);
  const outsideFile = path.join(out, "packed.txt");
  write(outsideFile, "TOP-SECRET-LINE without a newline");
  // the link appears after the repository was accepted; with the sandbox off Git really reads it
  process.env.FILEDECK_SANDBOX = "off";
  resetSandbox();
  try {
    fs.symlinkSync(outsideFile, path.join(d, ".git/packed-refs"));
    let plain = "";
    try {
      execFileSync("git", ["status"], { cwd: d, env: ENV, stdio: "pipe" });
    } catch (e) {
      plain = String((e as { stderr?: Buffer }).stderr);
    }
    assert.match(plain, /TOP-SECRET-LINE/, "control: plain Git quotes the file in its error");
    await assert.rejects(repoStatus(repo), (e: Error) => /^git status failed$/.test(e.message) && !e.message.includes("TOP-SECRET"));
    const res = await app.request("/api/git/info?path=/quote&fresh=1");
    assert.ok(!(await res.text()).includes("TOP-SECRET"));
    const lst = await app.request("/api/git/status?path=/&fresh=1");
    assert.ok(!(await lst.text()).includes("TOP-SECRET"));
  } finally {
    delete process.env.FILEDECK_SANDBOX;
    resetSandbox();
  }
});

test("without Landlock the git directory is checked again before every command, not once", async () => {
  process.env.FILEDECK_SANDBOX_HELPER = path.join(box.dir, "missing");
  delete process.env.FILEDECK_SANDBOX;
  resetSandbox();
  try {
    assert.equal((await sandboxInfo()).state, "fallback");
    const d = mk("recheck");
    const repo = (await repoAt(root, d))!;
    assert.ok(repo, "accepted: no links");
    assert.equal((await runGit(d, [...repoArgs(repo), "status", "--porcelain"])).code, 0);
    fs.symlinkSync(path.join(out, "packed.txt"), path.join(d, ".git/objects/late-link")); // after the check
    await assert.rejects(runGit(d, [...repoArgs(repo), "status", "--porcelain"]), (e: Error & { status?: number }) => e.status === 403 && !/late-link|TOP/.test(e.message));
  } finally {
    process.env.FILEDECK_SANDBOX_HELPER = box.bin;
    resetSandbox();
  }
});
