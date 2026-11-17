import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createAgent } from "../src/agent.ts";
import { loadConfig } from "../src/config.ts";
import { signClaim, USER_HEADER, type UserClaim } from "../src/auth/identity.ts";
import { makeWorkerSpecs, type WorkerSpecs } from "../src/agent-workers.ts";
import { runtimeRoots } from "../src/account-dirs.ts";
import type { WorkerPool } from "../src/worker-pool.ts";
import { sandboxInfo } from "../src/sandbox.ts";
import { haveSevenZip } from "../src/sevenzip.ts";
import { useSandboxOrOff } from "./sandbox-env.ts";
import { chownForTest, fakeResolver, privateTmpdir, testAccount } from "./worker-env.ts";

/**
 * A virtual account's worker under Landlock (sign-in part 2, Task 7): only its grants (and the folders a worker needs to run) can be
 * opened, a link inside a grant that leads out of it fails at open time in the kernel, and the helper programs (git, bsdtar, ffmpeg,
 * 7zz, qpdf) still work inside the worker. Needs Landlock, not root: the worker runs as this test's own user.
 */

await useSandboxOrOff();
const landlock = (await sandboxInfo()).state === "landlock";
const NEED = landlock ? false : "sandbox live: skipped (no Landlock on this kernel)";
const have = (cmd: string, arg = "--version") => spawnSync(cmd, [arg], { stdio: "ignore" }).status === 0;
const HAVE_GIT = have("git");
const HAVE_BSDTAR = have("bsdtar");
const HAVE_FFMPEG = have("ffmpeg", "-version");
const HAVE_7ZZ = haveSevenZip();
const HAVE_QPDF = have("qpdf");
/** the skip for a helper that is not installed here (the CI image has every one of them) */
const tool = (ok: boolean, name: string) => (NEED ? NEED : ok ? false : `worker helpers: skipped (${name} not installed here)`);

const T = "agent-secret-confine";
let work = "";
let root = "";
let thumbs = "";
let index = "";
let dropTmp = () => {};
type Agent = ReturnType<typeof createAgent>;
let app: Agent;
const me = testAccount();

before(() => {
  dropTmp = privateTmpdir();
  work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "filedeck-confine-")));
  root = path.join(work, "root");
  thumbs = path.join(work, "thumbs");
  index = path.join(work, "index");
  fs.mkdirSync(path.join(root, "a/repo"), { recursive: true });
  fs.mkdirSync(path.join(root, "a/x"));
  fs.mkdirSync(path.join(root, "b"));
  fs.mkdirSync(path.join(root, "c"));
  fs.writeFileSync(path.join(root, "a/t.txt"), "plain text in a\n");
  fs.writeFileSync(path.join(root, "a/notes.txt"), "a needle in a\n");
  fs.writeFileSync(path.join(root, "b/f.txt"), "read only b\n");
  fs.writeFileSync(path.join(root, "c/secret"), "TOPSECRET needle\n");
  if (HAVE_FFMPEG) {
    spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=red:s=64x64", "-frames:v", "1", path.join(root, "a/img.png")]);
    fs.copyFileSync(path.join(root, "a/img.png"), path.join(root, "c/img.png"));
  }
  if (HAVE_GIT) {
    for (const repo of [path.join(root, "a/repo"), path.join(root, "c")]) {
      const git = (...args: string[]) => spawnSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", ...args], { stdio: "ignore" });
      git("init", "-q");
      fs.writeFileSync(path.join(repo, "r.txt"), "tracked\n");
      git("add", "-A");
      git("commit", "-qm", "one");
      fs.writeFileSync(path.join(repo, "r.txt"), "changed\n");
    }
  }
  if (HAVE_QPDF) spawnSync("qpdf", ["--empty", path.join(root, "a/doc.pdf")]);
  // links inside the grant /a that lead out of it, to what this user (the runAs account) can read
  fs.symlinkSync("../c/secret", path.join(root, "a/out"));
  fs.symlinkSync("/c", path.join(root, "a/up"));
  // (a root pass runs the workers as nobody: they must pass through these folders, and the tree is theirs)
  fs.chmodSync(work, 0o755);
  chownForTest(root);
  app = createAgent(
    loadConfig({ FILEDECK_ROOT: root, FILEDECK_NODE: "t", FILEDECK_AGENT_TOKEN: T, FILEDECK_AUTH: "on", FILEDECK_THUMB_DIR: thumbs, FILEDECK_INDEX_DIR: index } as never),
    () => {},
    { accounts: fakeResolver({ guest: {} }) },
  );
});
after(async () => {
  await (app as unknown as { close(): Promise<void> } | undefined)?.close();
  fs.rmSync(work, { recursive: true, force: true });
  dropTmp();
});

const GRANTS = [
  { path: "/a", write: true },
  { path: "/b", write: false },
];
const virt = (grants: UserClaim["grants"] = GRANTS, epoch = 1, name = "guest1"): UserClaim => ({ kind: "virt", name, epoch, runAs: "guest", grants, iat: Date.now() });
const headers = (claim: UserClaim, extra: Record<string, string> = {}) => ({
  authorization: `Bearer ${T}`,
  [USER_HEADER]: signClaim({ ...claim, iat: Date.now() }, T),
  ...extra,
});
const get = (p: string, claim = virt()) => app.request(p, { headers: headers(claim) });
const post = (p: string, body: unknown, claim = virt()) =>
  app.request(p, { method: "POST", headers: headers(claim, { "content-type": "application/json" }), body: JSON.stringify(body) });
const poolOf = () => (app as unknown as { pool: WorkerPool }).pool;
const specsOf = () => (app as unknown as { workerSpecs: WorkerSpecs }).workerSpecs;

/** a job's state, asked of the worker itself (the root process's job list does not hold a worker's jobs yet) */
async function waitJob(id: string, claim = virt()): Promise<Record<string, any>> {
  const spec = await specsOf().spec(claim, (await fakeResolver({ guest: {} }).resolve("guest"))!);
  for (let i = 0; i < 800; i++) {
    const r = await poolOf().fetch(spec, new Request(`http://agent/api/jobs/${id}`));
    const v = (await r.json()) as Record<string, any>;
    if (["done", "failed", "canceled"].includes(v.state)) return v;
    await new Promise((res) => setTimeout(res, 25));
  }
  throw new Error("job did not finish");
}

test("grants: a write grant can be written, a read grant only read, nothing else opened", { skip: NEED }, async () => {
  const w = await app.request("/api/fs/write?path=/a/new.txt&create=1", { method: "PUT", headers: headers(virt()), body: "new in a\n" });
  assert.ok(w.status === 200 || w.status === 201, `${w.status} ${await w.clone().text()}`);
  assert.equal(fs.readFileSync(path.join(root, "a/new.txt"), "utf8"), "new in a\n");
  const r = await get("/api/fs/text?path=/b/f.txt");
  assert.equal(r.status, 200, await r.clone().text());
  assert.match(await r.text(), /read only b/);
  const x = await app.request("/api/fs/write?path=/b/x&create=1", { method: "PUT", headers: headers(virt()), body: "x" });
  assert.ok(x.status === 403 || x.status === 500, `writing a read grant: ${x.status} ${await x.clone().text()}`);
  assert.ok(!fs.existsSync(path.join(root, "b/x")));
  const s = await get("/api/fs/text?path=/c/secret");
  assert.ok(s.status >= 400, `outside the grants: ${s.status}`);
  assert.doesNotMatch(await s.text(), /TOPSECRET/);
  // the root of the volume: no grant there, so its listing shows nothing that is not a grant or the parent of one
  const l = await get("/api/fs/list?path=/");
  const text = await l.text();
  if (l.status === 200) {
    const names = ((JSON.parse(text) as { entries?: { name: string }[] }).entries ?? []).map((e) => e.name);
    for (const n of names) assert.ok(n === "a" || n === "b", `listing / shows ${n}`);
  } else assert.ok(l.status >= 400, text);
  assert.doesNotMatch(text, /"c"/);
  // what every worker may use to run never covers the served tree (a Node program at <folder>/bin/node must not give all of <folder>)
  const rt = await runtimeRoots();
  for (const r of [...rt.readOnly, ...rt.readExec]) assert.ok(root !== r && !root.startsWith(r + "/"), `${r} covers the served tree`);
});

test("link out of a grant: reading, search, thumbnail, zip and git through it fail or show nothing of /c", { skip: NEED }, async () => {
  for (const p of ["/a/out", "/a/up/secret"]) {
    const r = await get(`/api/fs/text?path=${encodeURIComponent(p)}`);
    const t = await r.text();
    assert.ok(r.status >= 400, `${p}: ${r.status} ${t}`);
    assert.doesNotMatch(t, /TOPSECRET/);
    const raw = await get(`/api/fs/read?path=${encodeURIComponent(p)}`);
    assert.ok(raw.status >= 400, `${p} (read): ${raw.status}`);
    assert.doesNotMatch(await raw.text(), /TOPSECRET/);
  }
  const s = await get("/api/fs/search?path=/a&content=needle");
  const st = await s.text();
  assert.doesNotMatch(st, /TOPSECRET/);
  assert.match(st, /notes\.txt/, `the search itself works: ${s.status} ${st}`);
  assert.doesNotMatch(st, /"[^"]*\/?(?:out|up\/secret)"/, st);
  if (HAVE_FFMPEG) {
    const th = await get("/api/fs/thumb?path=/a/up/img.png");
    assert.ok(th.status >= 400, `thumbnail through the link: ${th.status}`);
    await th.body?.cancel();
  }
  if (HAVE_BSDTAR) {
    const t = await post("/api/fs/zip-ticket", { dir: "/a", names: ["out", "up"] });
    if (t.status === 201) {
      const { id } = (await t.json()) as { id: string };
      const z = await get(`/api/fs/zip?ticket=${id}`);
      const body = Buffer.from(await z.arrayBuffer());
      assert.ok(!body.includes("TOPSECRET"), "the zip holds none of /c");
    } else assert.ok(t.status >= 400);
  }
  if (HAVE_GIT) {
    const g = await get("/api/git/status?path=/a/up");
    const gt = await g.text();
    assert.ok(g.status >= 400 || !/r\.txt/.test(gt), `git status through the link: ${g.status} ${gt}`);
    assert.doesNotMatch(gt, /TOPSECRET/);
  }
});

test("helpers inside: git status", { skip: tool(HAVE_GIT, "git") }, async () => {
  const r = await get("/api/git/status?path=/a/repo");
  const t = await r.text();
  assert.equal(r.status, 200, t);
  assert.match(t, /r\.txt/);
});

test("helpers inside: compress and extract with bsdtar", { skip: tool(HAVE_BSDTAR, "bsdtar") }, async () => {
  const c = await post("/api/jobs/compress", { dir: "/a", names: ["t.txt"], format: "zip", name: "t" });
  assert.equal(c.status, 202, await c.clone().text());
  const job = await waitJob(((await c.json()) as { id: string }).id);
  assert.equal(job.state, "done", JSON.stringify(job));
  assert.ok(fs.existsSync(path.join(root, "a/t.zip")));
  const x = await post("/api/jobs/extract", { path: "/a/t.zip", destDir: "/a/x", subfolder: false });
  assert.equal(x.status, 202, await x.clone().text());
  const xj = await waitJob(((await x.json()) as { id: string }).id);
  assert.equal(xj.state, "done", JSON.stringify(xj));
  assert.equal(fs.readFileSync(path.join(root, "a/x/t.txt"), "utf8"), "plain text in a\n");
});

test("helpers inside: compress with 7zz", { skip: tool(HAVE_7ZZ, "7zz") }, async () => {
  const c = await post("/api/jobs/compress", { dir: "/a", names: ["t.txt"], format: "7z", name: "t7" });
  assert.equal(c.status, 202, await c.clone().text());
  const job = await waitJob(((await c.json()) as { id: string }).id);
  assert.equal(job.state, "done", JSON.stringify(job));
  assert.ok(fs.existsSync(path.join(root, "a/t7.7z")));
});

test("helpers inside: a thumbnail with ffmpeg, cached in the account's folder", { skip: tool(HAVE_FFMPEG, "ffmpeg") }, async () => {
  const r = await get("/api/fs/thumb?path=/a/img.png");
  assert.equal(r.status, 200, await r.clone().text());
  assert.equal(r.headers.get("content-type"), "image/jpeg");
  await r.arrayBuffer();
  const mine = path.join(thumbs, `u${me.uid}`);
  const files = fs.readdirSync(mine, { recursive: true }).filter((n) => String(n).endsWith(".jpg"));
  assert.ok(files.length >= 1, `a thumbnail under ${mine}`);
  assert.equal(fs.lstatSync(mine).mode & 0o7777, 0o700);
});

test("helpers inside: a PDF's status with qpdf", { skip: tool(HAVE_QPDF, "qpdf") }, async () => {
  const r = await get("/api/pdf/status?path=/a/doc.pdf");
  assert.equal(r.status, 200, await r.clone().text());
  assert.deepEqual(await r.json(), { encrypted: false, locked: false });
});

test("index per account: one folder per set of grants, the old one removed", { skip: NEED }, async () => {
  const r = await get("/api/fs/lsdir?path=/a", virt(GRANTS, 1, "guest2"));
  assert.equal(r.status, 200, await r.clone().text());
  await r.text();
  const accounts = path.join(index, "accounts");
  const first = fs.readdirSync(accounts).filter((n) => n.startsWith("v-guest2-"));
  assert.equal(first.length, 1, fs.readdirSync(accounts).join(", "));
  assert.match(first[0]!, /^v-guest2-[0-9a-f]{16}$/);
  const dbs = fs.readdirSync(path.join(accounts, first[0]!));
  assert.ok(dbs.some((n) => /^index-t\.db/.test(n)), `a database in the account's index folder: ${dbs.join(", ")}`);
  // the root process never uses that file: its own index (if any) is at the top of the index folder
  assert.ok(!fs.readdirSync(index).some((n) => n.startsWith(first[0]!)));
  const st = fs.lstatSync(path.join(accounts, first[0]!));
  assert.equal(st.uid, me.uid);
  assert.equal(st.mode & 0o7777, 0o700);
  // other grants (with the new epoch the gate stops the old worker first): a new folder, and the old one is gone
  const r2 = await get("/api/fs/lsdir?path=/a", virt([{ path: "/a", write: false }], 2, "guest2"));
  assert.equal(r2.status, 200, await r2.clone().text());
  await r2.text();
  const second = fs.readdirSync(accounts).filter((n) => n.startsWith("v-guest2-"));
  assert.equal(second.length, 1, second.join(", "));
  assert.notEqual(second[0], first[0]);
  // the parents are this process's and closed to others' writes
  for (const d of [thumbs, accounts]) {
    const p = fs.lstatSync(d);
    assert.equal(p.uid, process.getuid!());
    assert.equal(p.mode & 0o022, 0);
  }
});

test("a parent of the account folders that others may write to is refused", { skip: NEED }, async () => {
  const logs: string[] = [];
  const orig = console.error;
  console.error = (s: string) => logs.push(String(s));
  const bad = path.join(work, "thumbs-open");
  fs.mkdirSync(bad);
  fs.chmodSync(bad, 0o777);
  const other = createAgent(
    loadConfig({ FILEDECK_ROOT: root, FILEDECK_NODE: "t", FILEDECK_AGENT_TOKEN: T, FILEDECK_AUTH: "on", FILEDECK_THUMB_DIR: bad, FILEDECK_INDEX_DIR: index } as never),
    () => {},
    { accounts: fakeResolver({ guest: {} }) },
  );
  try {
    const r = await other.request("/api/fs/stat?path=/a", { headers: headers(virt(GRANTS, 1, "guest3")) });
    assert.equal(r.status, 503);
    assert.deepEqual(await r.json(), { error: "worker folders are not safe" });
    assert.ok(logs.some((l) => l.includes(bad)), logs.join("\n"));
    assert.deepEqual(fs.readdirSync(bad), [], "nothing made in it");
    assert.equal(fs.lstatSync(bad).mode & 0o7777, 0o777, "not changed");
  } finally {
    console.error = orig;
    await (other as unknown as { close(): Promise<void> }).close();
  }
});

test("a grant that does not exist is left out, the others still work", { skip: NEED }, async () => {
  const logs: string[] = [];
  const orig = console.error;
  console.error = (s: string) => logs.push(String(s));
  try {
    const claim = virt([...GRANTS, { path: "/missing", write: true }], 1, "guest4");
    const r = await get("/api/fs/text?path=/b/f.txt", claim);
    assert.equal(r.status, 200, `${await r.clone().text()}\n${logs.join("\n")}`);
    await r.text();
    assert.ok(logs.some((l) => l.includes("/missing")), logs.join("\n"));
  } finally {
    console.error = orig;
  }
});

test("cache folders: one swapped for a link after its mkdir is refused; one already there must be the account's and is never changed", async () => {
  const base = path.join(work, "caches");
  fs.mkdirSync(base);
  const cfg = loadConfig({ FILEDECK_ROOT: root, FILEDECK_NODE: "t", FILEDECK_THUMB_DIR: path.join(base, "thumbs"), FILEDECK_INDEX_DIR: path.join(base, "index") } as never);
  const account = (await fakeResolver({ guest: {} }).resolve("guest"))!;
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "filedeck-outside-"));
  fs.chmodSync(outside, 0o755);
  try {
    for (const at of ["thumbs", "index"] as const) {
      const specs = makeWorkerSpecs(cfg, {
        afterMkdir: (step, p) => {
          if (step !== at) return;
          fs.rmdirSync(p);
          fs.symlinkSync(outside, p);
        },
      });
      try {
        await assert.rejects(specs.spec(virt(GRANTS, 1, `swap${at}`), account), { name: "UnsafeFolders" });
        assert.equal(fs.statSync(outside).mode & 0o7777, 0o755, "the folder behind the link is not changed");
      } finally {
        await specs.close();
      }
      fs.rmSync(at === "thumbs" ? path.join(base, "thumbs", `u${account.uid}`) : path.join(base, "index/accounts"), { recursive: true, force: true });
    }
    // a folder there already, open to others: refused and left as it is
    const open = path.join(base, "thumbs", `u${account.uid}`);
    fs.mkdirSync(open, { recursive: true });
    fs.chmodSync(open, 0o777);
    const specs = makeWorkerSpecs(cfg);
    try {
      await assert.rejects(specs.spec(virt(GRANTS, 1, "openthumbs"), account), /mode 777/);
      assert.equal(fs.lstatSync(open).mode & 0o7777, 0o777);
    } finally {
      await specs.close();
    }
  } finally {
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test("an old index folder that is a link is removed as a link, nothing behind it", async () => {
  const base = path.join(work, "links");
  fs.mkdirSync(base);
  const cfg = loadConfig({ FILEDECK_ROOT: root, FILEDECK_NODE: "t", FILEDECK_THUMB_DIR: path.join(base, "thumbs"), FILEDECK_INDEX_DIR: path.join(base, "index") } as never);
  const account = (await fakeResolver({ guest: {} }).resolve("guest"))!;
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "filedeck-outside-"));
  fs.writeFileSync(path.join(outside, "keep.txt"), "keep");
  fs.mkdirSync(path.join(base, "index/accounts"), { recursive: true, mode: 0o711 });
  const old = path.join(base, "index/accounts", "v-guest5-0123456789abcdef");
  fs.symlinkSync(outside, old);
  const other = path.join(base, "index/accounts", "v-guest55-0123456789abcdef"); // another name: not touched
  fs.mkdirSync(other, { mode: 0o700 });
  const specs = makeWorkerSpecs(cfg);
  try {
    const s = await specs.spec(virt(GRANTS, 1, "guest5"), account);
    assert.ok(!fs.existsSync(old), "the link is gone");
    assert.equal(fs.readFileSync(path.join(outside, "keep.txt"), "utf8"), "keep");
    assert.ok(fs.existsSync(other));
    assert.match(path.basename(s.init.cfg.indexDir), /^v-guest5-[0-9a-f]{16}$/);
    assert.ok(fs.existsSync(s.init.cfg.indexDir));
  } finally {
    await specs.close();
    fs.rmSync(outside, { recursive: true, force: true });
  }
});
