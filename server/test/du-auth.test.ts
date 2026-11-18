import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createAgent } from "../src/agent.ts";
import { loadConfig } from "../src/config.ts";
import { claimFor, signClaim, USER_HEADER, type Identity, type UserClaim } from "../src/auth/identity.ts";
import { tokenIdentity } from "../src/auth/routes.ts";
import { sandboxInfo } from "../src/sandbox.ts";
import { Hono } from "hono";
import { agentError } from "../src/agent-routes.ts";
import { Jobs } from "../src/jobs.ts";
import { entryChain, registerSizeRoutes } from "../src/props.ts";
import { useSandboxOrOff } from "./sandbox-env.ts";
import { chownForTest, fakeResolver, privateTmpdir } from "./worker-env.ts";

/**
 * Sign-in on: folder sizes (`/api/du`, `/api/jobs/size`) follow the account. The root process holds the size store, so it asks the
 * account's worker which folders the account can open, and leaves out the rest. A virtual account gets sizes only inside its grants.
 */

await useSandboxOrOff();
const landlock = (await sandboxInfo()).state === "landlock";
const NEED = landlock ? false : "sandbox live: skipped (no Landlock on this kernel)";
const ROOT_ONLY = process.getuid?.() === 0 ? false : "worker live: skipped (not running as root)";

const T = "agent-secret-du";
let work = "";
let root = "";
let dropTmp = () => {};
type Agent = ReturnType<typeof createAgent>;
let app: Agent;

before(() => {
  dropTmp = privateTmpdir();
  work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "filedeck-duauth-")));
  root = path.join(work, "root");
  const index = path.join(work, "index");
  fs.mkdirSync(index);
  fs.mkdirSync(path.join(root, "a/x/deep"), { recursive: true });
  fs.mkdirSync(path.join(root, "a/y"));
  fs.mkdirSync(path.join(root, "a/z"));
  fs.writeFileSync(path.join(root, "a/x/deep/f.bin"), Buffer.alloc(4096, 1));
  fs.writeFileSync(path.join(root, "a/top.txt"), "top\n");
  fs.writeFileSync(path.join(root, "a/z/hidden-name.txt"), "z\n");
  fs.mkdirSync(path.join(root, "a/z/zz/deeper"), { recursive: true });
  fs.mkdirSync(path.join(root, "a/z/plain"));
  fs.symlinkSync("/a/y", path.join(root, "a/z/lnk")); // a link in a folder the account cannot open, to one it can
  fs.symlinkSync("/a/z/hidden-name.txt", path.join(root, "a/zl")); // a link the account owns, to a file in a folder it cannot open
  fs.mkdirSync(path.join(root, "b"));
  fs.mkdirSync(path.join(root, "c/inner"), { recursive: true });
  fs.writeFileSync(path.join(root, "c/secret"), Buffer.alloc(8192, 2));
  fs.mkdirSync(path.join(root, "p"));
  fs.writeFileSync(path.join(root, "p/private"), "p\n");
  fs.mkdirSync(path.join(root, "q"));
  fs.writeFileSync(path.join(root, "q/open"), "q\n");
  fs.symlinkSync("/p/private", path.join(root, "q/lnk")); // the account's own link, to a file in root's 0700 folder
  fs.mkdirSync(path.join(root, "p/inner/deeper"), { recursive: true });
  // a folder others may pass through but not list (0711), with a folder below it that anyone may list (0755)
  fs.mkdirSync(path.join(root, "h/pub/sub"), { recursive: true });
  fs.writeFileSync(path.join(root, "h/pub/f"), "h\n");
  fs.chmodSync(work, 0o755);
  chownForTest(root);
  // a folder inside the grant that the account (the runAs user) cannot open
  fs.chmodSync(path.join(root, "a/z"), 0o000);
  if (process.getuid?.() === 0) {
    fs.chownSync(path.join(root, "p"), 0, 0);
    fs.chmodSync(path.join(root, "p"), 0o700);
    for (const d of ["h", "h/pub", "h/pub/sub"]) fs.chownSync(path.join(root, d), 0, 0);
    fs.chownSync(path.join(root, "h/pub/f"), 0, 0);
    fs.chmodSync(path.join(root, "h"), 0o711);
    fs.chmodSync(path.join(root, "h/pub"), 0o755);
  }
  app = createAgent(
    loadConfig({ FILEDECK_ROOT: root, FILEDECK_NODE: "t", FILEDECK_AGENT_TOKEN: T, FILEDECK_AUTH: "on", FILEDECK_INDEX_DIR: index, FILEDECK_API_TOKEN_ACCOUNT: "du-bot" } as never),
    () => {},
    { accounts: fakeResolver({ guest: {}, alice: {} }) },
  );
});
after(async () => {
  await (app as unknown as { close(): Promise<void> } | undefined)?.close();
  fs.chmodSync(path.join(root, "a/z"), 0o755);
  fs.rmSync(work, { recursive: true, force: true });
  dropTmp();
});

const virt = (name = "guest1", grants: UserClaim["grants"] = [{ path: "/a", write: true }]): UserClaim => ({ kind: "virt", name, epoch: 1, runAs: "guest", grants, iat: Date.now() });
const sys = (name: string): UserClaim => ({ kind: "sys", name, epoch: 1, iat: Date.now() });
const headers = (claim: UserClaim, extra: Record<string, string> = {}) => ({ authorization: `Bearer ${T}`, [USER_HEADER]: signClaim({ ...claim, iat: Date.now() }, T), ...extra });
const get = (p: string, claim: UserClaim) => app.request(p, { headers: headers(claim) });
type Entry = { path: string; type: string; bytes: number };
type Answer = { path: string; entries: Entry[]; error?: string };

/** the answer of /api/du, waiting through 202 (poll the job, then ask again) */
async function du(q: string, claim: UserClaim): Promise<Response> {
  for (let i = 0; i < 200; i++) {
    const r = await get(`/api/du?${q}`, claim);
    if (r.status !== 202) return r;
    const { jobId } = (await r.json()) as { jobId: string };
    for (let k = 0; k < 400; k++) {
      const j = await get(`/api/jobs/${jobId}`, claim);
      assert.equal(j.status, 200, `the job of a du is followed by whoever asked: ${await j.clone().text()}`);
      const s = ((await j.json()) as { state: string }).state;
      if (s !== "queued" && s !== "running") break;
      await new Promise((res) => setTimeout(res, 25));
    }
  }
  throw new Error("no answer");
}
async function answer(q: string, claim: UserClaim): Promise<Answer> {
  const r = await du(q, claim);
  assert.equal(r.status, 200, await r.clone().text());
  const a = (await r.json()) as Answer;
  assert.equal(a.error, undefined);
  return a;
}
async function refused(q: string, claim: UserClaim, error: string): Promise<void> {
  const r = await get(`/api/du?${q}`, claim);
  assert.equal(r.status, 403, `${q}: ${await r.clone().text()}`);
  assert.deepEqual(await r.json(), { error });
}

test("a virtual account gets sizes inside its grants only, without the folders it cannot open", { skip: NEED }, async () => {
  const claim = virt();
  const a = await answer("path=/a&depth=2&all=1", claim);
  const paths = a.entries.map((e) => e.path);
  assert.ok(paths.every((p) => p === "/a" || p.startsWith("/a/")), paths.join(" "));
  for (const p of ["/a", "/a/x", "/a/x/deep", "/a/y", "/a/top.txt"]) assert.ok(paths.includes(p), `${p} in ${paths.join(" ")}`);
  assert.ok(!paths.includes("/a/z"), "a folder the account cannot open is left out");
  assert.ok(!paths.some((p) => p.startsWith("/a/z/")), "and so are its files");
  // the folder's total covers everything below it (the grant covers the whole subtree)
  assert.ok(a.entries.find((e) => e.path === "/a/x")!.bytes >= 4096);
  // a folder that only leads to the grant, a folder outside it, and a folder inside it that it cannot open
  await refused("path=/&depth=2", claim, "outside your folders");
  await refused("path=/c", claim, "outside your folders");
  await refused("path=/a/z", claim, "permission denied");
  const s = await app.request("/api/jobs/size", { method: "POST", headers: headers(claim, { "content-type": "application/json" }), body: JSON.stringify({ path: "/c" }) });
  assert.equal(s.status, 403);
  assert.deepEqual(await s.json(), { error: "outside your folders" });
  const z = await app.request("/api/jobs/size", { method: "POST", headers: headers(claim, { "content-type": "application/json" }), body: JSON.stringify({ path: "/a/z" }) });
  assert.equal(z.status, 403);
  const ok = await app.request("/api/jobs/size", { method: "POST", headers: headers(claim, { "content-type": "application/json" }), body: JSON.stringify({ path: "/a/top.txt" }) });
  assert.equal(ok.status, 202, "a file in a folder the account can open");
  // from the store only, too
  const cached = await get("/api/du?path=/a&depth=2&all=1&cachedOnly=1", claim);
  assert.equal(cached.status, 200);
  assert.ok(!((await cached.json()) as Answer).entries.some((e) => e.path === "/a/z" || e.path.startsWith("/a/z/")));
});

test("the API token's account gets the same filter", { skip: NEED }, async () => {
  // what the hub sends for a request with FILEDECK_API_TOKEN (FILEDECK_API_TOKEN_ACCOUNT=du-bot, a virtual account here)
  const cfg = loadConfig({ FILEDECK_API_TOKEN_ACCOUNT: "du-bot" } as never);
  const bot: Identity = { kind: "virt", name: "du-bot", admin: false, epoch: 1, nodes: { t: { runAs: "guest", grants: [{ path: "/a", write: false }] } } };
  const id = tokenIdentity(cfg, { identity: (kind: string, name: string) => (kind === "virt" && name === "du-bot" ? bot : undefined), epochOf: () => 1 } as never);
  assert.ok(!("error" in id));
  const claim = claimFor(id as Identity, "t", Date.now())!;
  const a = await answer("path=/a&depth=2", claim);
  assert.ok(!a.entries.some((e) => e.path === "/a/z" || e.path.startsWith("/a/z/")));
  assert.ok(a.entries.some((e) => e.path === "/a/x/deep"));
  await refused("path=/", claim, "outside your folders");
  await refused("path=/c", claim, "outside your folders");
});

test("a system account does not get the folders its user cannot open", { skip: ROOT_ONLY }, async () => {
  const claim = sys("alice");
  const a = await answer("path=/&depth=1", claim);
  const paths = a.entries.map((e) => e.path);
  assert.ok(paths.includes("/q"), paths.join(" "));
  assert.ok(!paths.includes("/p"), "root's 0700 folder is left out");
  await refused("path=/p", claim, "permission denied");
  const s = await app.request("/api/jobs/size", { method: "POST", headers: headers(claim, { "content-type": "application/json" }), body: JSON.stringify({ path: "/p" }) });
  assert.equal(s.status, 403);
});

const postSize = (p: string, claim: UserClaim) => app.request("/api/jobs/size", { method: "POST", headers: headers(claim, { "content-type": "application/json" }), body: JSON.stringify({ path: p }) });

/** every view of a size job the account gets while it runs and once it is done (the answer to the request, the job, the list) */
async function sizeViews(p: string, claim: UserClaim): Promise<string[]> {
  const r = await postSize(p, claim);
  assert.equal(r.status, 202, await r.clone().text());
  const views = [await r.text()];
  const { id } = JSON.parse(views[0]!) as { id: string };
  for (let i = 0; i < 400; i++) {
    const j = await get(`/api/jobs/${id}`, claim);
    assert.equal(j.status, 200);
    const t = await j.text();
    views.push(t);
    const st = (JSON.parse(t) as { state: string }).state;
    if (st !== "queued" && st !== "running") break;
    await new Promise((res) => setTimeout(res, 5));
  }
  views.push(await (await get("/api/jobs", claim)).text());
  return views;
}
const currents = (views: string[]) =>
  views.flatMap((t) => {
    const v = JSON.parse(t) as { progress?: { current: string }; jobs?: { progress: { current: string } }[] };
    return [...(v.progress ? [v.progress.current] : []), ...(v.jobs ?? []).map((j) => j.progress.current)];
  });

test("a size job never shows the path its walk is at (a virtual account, a folder it cannot open)", { skip: NEED }, async () => {
  const views = await sizeViews("/a", virt("guest5"));
  for (const t of views) assert.doesNotMatch(t, /\/a\/z/);
  assert.ok(currents(views).every((c) => c === ""), currents(views).join(" "));
});

test("a name in a folder the account cannot open: the same answer whether it is a link or not", { skip: NEED }, async () => {
  const claim = virt("guest6");
  for (const p of ["/a/z/lnk", "/a/z/plain", "/a/z/missing"]) {
    await refused(`path=${p}`, claim, "permission denied");
    const s = await postSize(p, claim);
    assert.equal(s.status, 403, p);
    assert.deepEqual(await s.json(), { error: "permission denied" }, p);
  }
});

test("a system account's size job never shows the path its walk is at", { skip: ROOT_ONLY }, async () => {
  const views = await sizeViews("/", sys("alice"));
  for (const t of views) assert.doesNotMatch(t, /"\/p\//);
  assert.ok(currents(views).every((c) => c === ""), currents(views).join(" "));
});

test("a folder below one the account may pass through but not list is left out, and so is all below it", { skip: ROOT_ONLY }, async () => {
  const a = await answer("path=/&depth=3&all=1", sys("alice"));
  const paths = a.entries.map((e) => e.path);
  assert.ok(paths.includes("/q"), paths.join(" "));
  assert.ok(!paths.some((p) => p === "/h" || p.startsWith("/h/")), paths.join(" "));
});

test("the size of a file is answered only when the account can open the folder it really is in", { skip: ROOT_ONLY }, async () => {
  for (const [p, claim] of [["/q/lnk", sys("alice")], ["/a/zl", virt("guest7")]] as const) {
    const r = await postSize(p, claim);
    assert.equal(r.status, 403, `${p}: ${await r.clone().text()}`);
    assert.deepEqual(await r.json(), { error: "permission denied" });
  }
  assert.equal((await postSize("/q/open", sys("alice"))).status, 202, "a file in a folder the account can open");
});

test("an entry that is not below the asked folder has no chain, and is left out", () => {
  const e = (p: string, type = "dir") => ({ path: p, type, bytes: 0, diskBytes: 0, files: 0, dirs: 0 }) as Parameters<typeof entryChain>[1];
  assert.deepEqual(entryChain("/a", e("/a")), []);
  assert.deepEqual(entryChain("/a", e("/a/x/y")), ["/a/x", "/a/x/y"]);
  assert.deepEqual(entryChain("/a", e("/a/x/f", "file")), ["/a/x"]);
  assert.deepEqual(entryChain("/", e("/x/f", "file")), ["/x"]);
  assert.equal(entryChain("/a", e("/b")), null);
  assert.equal(entryChain("/a", e("/ab")), null);
  assert.equal(entryChain("/a", e("/ab/f", "file")), null);
});

test("an asked folder that is a link: the folder it leads to is checked too", async () => {
  // a stand-in for the worker: the link itself is listable, the folder it leads to is not
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "filedeck-dulink-")));
  try {
    fs.mkdirSync(path.join(dir, "root/real/inner"), { recursive: true });
    fs.writeFileSync(path.join(dir, "root/real/inner/f"), "x");
    fs.symlinkSync("/real", path.join(dir, "root/lnk"));
    fs.mkdirSync(path.join(dir, "index"));
    const cfg = loadConfig({ FILEDECK_ROOT: path.join(dir, "root"), FILEDECK_NODE: "t", FILEDECK_INDEX_DIR: path.join(dir, "index") } as never);
    const asked: string[] = [];
    const h = new Hono();
    h.onError(agentError);
    const sizes = registerSizeRoutes(h, cfg, new Jobs(2), { canList: async (_c, ps) => (asked.push(...ps), ps.map((p) => p === "/lnk")) });
    try {
      const r = await h.request("/api/du?path=/lnk&depth=2");
      assert.equal(r.status, 403, await r.clone().text());
      assert.ok(asked.includes("/real"), asked.join(" "));
    } finally {
      sizes.close();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
