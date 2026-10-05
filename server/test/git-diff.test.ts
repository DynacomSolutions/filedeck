import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createAgent } from "../src/agent.ts";
import { loadConfig } from "../src/config.ts";
import { parseNameStatus, parseNumstat, resolveRef } from "../src/git-diff.ts";

// A work tree (work/) and a bare mirror of it (mirror.git/) with a fake refs/pull/1/head.
let tmp: string, app: ReturnType<typeof createAgent>;
let baseSha = "", headSha = "", mainSha = "";
const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
const git = (cwd: string, ...a: string[]) => execFileSync("git", ["-c", "init.defaultBranch=main", ...a], { cwd, env, encoding: "utf8" }).trim();

before(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "filedeck-gitdiff-")));
  const w = path.join(tmp, "work");
  fs.mkdirSync(w);
  git(w, "init", "-q");
  const put = (n: string, c: string | Buffer) => {
    fs.mkdirSync(path.dirname(path.join(w, n)), { recursive: true });
    fs.writeFileSync(path.join(w, n), c);
  };
  put("keep.txt", "same\n");
  put("mod.txt", "one\ntwo\nthree\n");
  put("gone.txt", "bye\nbye\n");
  put("old/name.txt", "a long enough body\nfor rename detection\nto kick in\nline four\nline five\n");
  put("bin.dat", Buffer.from([1, 2, 0, 3]));
  git(w, "add", "-A");
  git(w, "commit", "-q", "-m", "base");
  baseSha = git(w, "rev-parse", "HEAD");
  git(w, "checkout", "-q", "-b", "feature");
  put("mod.txt", "one\nTWO\nthree\nfour\n");
  fs.rmSync(path.join(w, "gone.txt"));
  put("added.txt", "new\nfile\n");
  git(w, "mv", "old/name.txt", "old/renamed.txt");
  put("bin.dat", Buffer.from([1, 2, 0, 3, 4, 5]));
  put("big.txt", "x".repeat(3 * 1024 * 1024));
  git(w, "add", "-A");
  git(w, "commit", "-q", "-m", "feature work");
  headSha = git(w, "rev-parse", "HEAD");
  git(w, "checkout", "-q", "main");
  put("other.txt", "main moved on\n");
  git(w, "add", "-A");
  git(w, "commit", "-q", "-m", "main moves");
  mainSha = git(w, "rev-parse", "HEAD");
  // bare mirror with a fake PR ref
  const m = path.join(tmp, "mirror.git");
  git(tmp, "clone", "-q", "--mirror", w, m);
  git(m, "update-ref", "refs/pull/1/head", headSha);
  git(m, "update-ref", "refs/pull/2/head", mainSha);
  fs.mkdirSync(path.join(tmp, "plain"));
  app = createAgent(loadConfig({ FILEDECK_ROOT: tmp, FILEDECK_NODE: "t" } as never));
});
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const diff = async (q: string) => {
  const r = await app.request("/api/git/diff?" + q);
  return { status: r.status, body: (await r.json()) as Record<string, any> };
};
const byPath = (files: Record<string, any>[], p: string) => files.find((f) => f.path === p);

test("PR number in a bare mirror resolves refs/pull/<n>/head against the default branch (three-dot)", async () => {
  const { status, body } = await diff("path=/mirror.git&pr=1");
  assert.equal(status, 200, JSON.stringify(body));
  assert.equal(body.pr, 1);
  assert.equal(body.head.sha, headSha);
  assert.equal(body.mergeBase, baseSha, "the base is the merge-base, not the moved default branch");
  assert.equal(body.base.sha, baseSha);
  const f = body.files as Record<string, any>[];
  assert.deepEqual(f.map((x) => x.path).sort(), ["added.txt", "big.txt", "bin.dat", "gone.txt", "mod.txt", "old/renamed.txt"]);
  assert.equal(byPath(f, "other.txt"), undefined, "changes that only landed on main are not part of the PR");
});

test("per-file status, counts, rename source and binary flag", async () => {
  const f = (await diff("path=/mirror.git&pr=1")).body.files as Record<string, any>[];
  assert.deepEqual(byPath(f, "added.txt"), { path: "added.txt", status: "A", add: 2, del: 0, binary: false });
  assert.deepEqual(byPath(f, "gone.txt"), { path: "gone.txt", status: "D", add: 0, del: 2, binary: false });
  const mod = byPath(f, "mod.txt")!;
  assert.equal(mod.status, "M");
  assert.equal(mod.add, 2);
  assert.equal(mod.del, 1);
  const ren = byPath(f, "old/renamed.txt")!;
  assert.equal(ren.status, "R");
  assert.equal(ren.oldPath, "old/name.txt");
  assert.ok(ren.similarity >= 90);
  const bin = byPath(f, "bin.dat")!;
  assert.equal(bin.binary, true);
  assert.equal(bin.add, null);
  assert.equal(bin.status, "M");
});

test("two refs in a work tree, three-dot semantics", async () => {
  const { status, body } = await diff("path=/work&base=main&head=feature");
  assert.equal(status, 200, JSON.stringify(body));
  assert.equal(body.mergeBase, baseSha);
  assert.equal(body.head.sha, headSha);
  assert.equal(body.files.length, 6);
  const rev = await diff("path=/work&base=" + headSha + "&head=" + mainSha);
  assert.equal(rev.status, 200);
  assert.ok(byPath(rev.body.files, "other.txt"));
});

test("a PR whose head is already in the default branch is reported, not an error", async () => {
  const { status, body } = await diff("path=/mirror.git&pr=2");
  assert.equal(status, 200);
  assert.equal(body.files.length, 0);
  assert.match(body.note, /already part of the default branch/);
});

test("unknown PR is 404; malformed PR number is 400", async () => {
  assert.equal((await diff("path=/mirror.git&pr=999")).status, 404);
  assert.equal((await diff("path=/mirror.git&pr=abc")).status, 400);
  assert.equal((await diff("path=/mirror.git&pr=0")).status, 400);
  assert.equal((await diff("path=/mirror.git")).status, 400);
});

test("invalid refs are rejected and never reach git as options", async () => {
  const pwned = path.join(tmp, "pwned");
  for (const bad of [`--output=${pwned}`, "-p", "a..b", "a b", "a;b", "$(id)", "HEAD^", "HEAD~1", "main:file", "x\ny", "", "a@{1}", "refs/heads/", "/abs", "a.lock", "..", "@{", "*", "?"]) {
    const r = await diff(`path=/work&base=${encodeURIComponent(bad)}&head=feature`);
    assert.ok(r.status === 400, `${JSON.stringify(bad)} -> ${r.status}`);
  }
  assert.equal((await diff("path=/work&base=nope&head=feature")).status, 404);
  await assert.rejects(resolveRef({ cwd: path.join(tmp, "work") }, "--all"), /invalid ref/);
  assert.equal(fs.existsSync(pwned), false);
});

test("a folder that is not a repository is a 400, a path outside the root is refused", async () => {
  assert.equal((await diff("path=/plain&pr=1")).status, 400);
  const out = await diff("path=/../etc&pr=1");
  assert.ok(out.status === 400 || out.status === 403, String(out.status));
  assert.equal((await diff("path=/missing&pr=1")).status, 404);
});

test("blob: text at a commit, binary flagged, oversized capped, bad input refused", async () => {
  const blob = async (sha: string, file: string) => {
    const r = await app.request(`/api/git/blob?path=/mirror.git&sha=${sha}&file=${encodeURIComponent(file)}`);
    return { status: r.status, body: (await r.json()) as Record<string, any> };
  };
  const t = await blob(headSha, "mod.txt");
  assert.equal(t.status, 200);
  assert.equal(t.body.content, "one\nTWO\nthree\nfour\n");
  assert.equal(t.body.binary, false);
  const old = await blob(baseSha, "mod.txt");
  assert.equal(old.body.content, "one\ntwo\nthree\n");
  const b = await blob(headSha, "bin.dat");
  assert.equal(b.body.binary, true);
  assert.equal(b.body.content, "");
  assert.equal(b.body.size, 6);
  const big = await blob(headSha, "big.txt");
  assert.equal(big.body.tooLarge, true);
  assert.equal(big.body.content, "");
  assert.equal(big.body.size, 3 * 1024 * 1024);
  assert.equal((await blob(headSha, "gone.txt")).status, 404);
  assert.equal((await blob("HEAD", "mod.txt")).status, 400);
  assert.equal((await blob(headSha, "../x")).status, 400);
  assert.equal((await blob(headSha, "")).status, 400);
});

test("refs list offers branches and recent pull requests", async () => {
  const r = await app.request("/api/git/refs?path=/mirror.git");
  const j = (await r.json()) as { bare: boolean; refs: string[]; prs: { n: number }[] };
  assert.equal(j.bare, true);
  assert.ok(j.refs.includes("main") && j.refs.includes("feature"));
  assert.deepEqual(j.prs.map((p) => p.n).sort(), [1, 2]);
});

test("parsers: name-status and numstat with renames and odd names", () => {
  assert.deepEqual(parseNameStatus("A\0a b.txt\0R087\0old\0new\0D\0x\0T\0t\0"), [
    { status: "A", path: "a b.txt" },
    { status: "R", path: "new", oldPath: "old", similarity: 87 },
    { status: "D", path: "x" },
    { status: "M", path: "t" },
  ]);
  const n = parseNumstat("1\t2\ta b.txt\0-\t-\tbin\x000\t0\t\0old\0new\0");
  assert.deepEqual(n.get("a b.txt"), { add: 1, del: 2 });
  assert.deepEqual(n.get("bin"), { add: null, del: null });
  assert.deepEqual(n.get("new"), { add: 0, del: 0 });
});
