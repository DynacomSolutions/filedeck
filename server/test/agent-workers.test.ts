import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { createAgent } from "../src/agent.ts";
import { loadConfig } from "../src/config.ts";
import { signClaim, USER_HEADER, type UserClaim } from "../src/auth/identity.ts";
import { isRootRoute, makeWorkerSpecs, workerGate, workerKey } from "../src/agent-workers.ts";
import { PoolFull, StaleEpoch, startWorkerProcess, type StartWorker, type WorkerPool, type WorkerSpec } from "../src/worker-pool.ts";
import { WorkerGone } from "../src/worker-proto.ts";
import { sandboxInfo } from "../src/sandbox.ts";
import type { AccountResolver } from "../src/local-accounts.ts";
import { useSandboxOrOff } from "./sandbox-env.ts";
import { chownForTest, fakeResolver, privateTmpdir } from "./worker-env.ts";

/**
 * Sign-in on: every request that is not one of the root process's own routes runs in the worker of its account (agent-workers.ts).
 * Real workers, as `testAccount()`, through the sandbox launcher where the kernel has Landlock.
 */

const T = "agent-secret-workers";
let tmp = "";
type Agent = ReturnType<typeof createAgent>;
const apps: Agent[] = [];
await useSandboxOrOff(); // workers start through the sandbox launcher where the kernel has Landlock
const landlock = (await sandboxInfo()).state === "landlock";

let dropTmp = () => {};
before(() => {
  dropTmp = privateTmpdir(); // the workers' folders go with it
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "filedeck-agentworkers-")));
  fs.writeFileSync(path.join(tmp, "a.txt"), "alpha\n");
  fs.chmodSync(tmp, 0o755);
  chownForTest(tmp);
});
after(async () => {
  for (const a of apps) await (a as unknown as { close(): Promise<void> }).close();
  fs.rmSync(tmp, { recursive: true, force: true });
  dropTmp();
});

const accounts = () => fakeResolver({ alice: {}, guest: {}, toor: { uid: 0 } });

function agent(env: Record<string, string> = {}, opts: { accounts?: AccountResolver; startWorker?: StartWorker } = { accounts: accounts() }): Agent {
  const app = createAgent(loadConfig({ FILEDECK_ROOT: tmp, FILEDECK_NODE: "t", FILEDECK_AGENT_TOKEN: T, FILEDECK_AUTH: "on", ...env } as never), () => {}, opts);
  apps.push(app);
  return app;
}
const poolOf = (app: Agent) => (app as unknown as { pool?: WorkerPool }).pool;
const baseOf = (app: Agent) => (app as unknown as { workerBase?: string }).workerBase;
const IS_ROOT = process.getuid?.() === 0;
const me = process.getuid?.() ?? 0;

const sys = (name: string, epoch = 1): UserClaim => ({ kind: "sys", name, epoch, iat: Date.now() });
const virt = (name: string, grants: UserClaim["grants"], epoch = 1): UserClaim => ({ kind: "virt", name, epoch, runAs: "guest", grants, iat: Date.now() });
const headers = (claim: UserClaim | null, extra: Record<string, string> = {}) => ({
  authorization: `Bearer ${T}`,
  ...(claim ? { [USER_HEADER]: signClaim({ ...claim, iat: Date.now() }, T) } : {}),
  ...extra,
});
const get = (app: Agent, p: string, claim: UserClaim | null) => app.request(p, { headers: headers(claim) });

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
async function until(cond: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return cond();
}

test("sys request runs in a worker", async () => {
  const app = agent();
  const r = await get(app, "/api/fs/stat?path=/", sys("alice"));
  assert.equal(r.status, 200, await r.clone().text());
  assert.ok(!r.headers.has("x-filedeck-jobs"), "the job count is the pool's business");
  assert.deepEqual(
    poolOf(app)!.list().map((w) => w.key),
    ["sys:alice"],
  );
  // a streamed body reaches the worker, with its method, path and query
  const w = await app.request("/api/fs/write?path=/made.txt&create=1", { method: "PUT", headers: headers(sys("alice")), body: "made in a worker\n" });
  assert.equal(w.status, 200, await w.clone().text());
  assert.equal(fs.readFileSync(path.join(tmp, "made.txt"), "utf8"), "made in a worker\n");
  // and a JSON body that the request guard has read
  const m = await app.request("/api/fs/mkdir", { method: "POST", headers: headers(sys("alice"), { "content-type": "application/json" }), body: JSON.stringify({ path: "/dir1" }) });
  assert.equal(m.status, 201, await m.clone().text());
  assert.ok(fs.statSync(path.join(tmp, "dir1")).isDirectory());
  assert.equal(poolOf(app)!.list().length, 1, "one worker for the account");
});

test("unknown and uid 0", async () => {
  let starts = 0;
  const app = agent({}, { accounts: accounts(), startWorker: async () => (starts++, assert.fail("no worker may start")) });
  for (const name of ["bob", "toor"]) {
    const r = await get(app, "/api/fs/stat?path=/", sys(name));
    assert.equal(r.status, 403);
    assert.deepEqual(await r.json(), { error: "no account on this machine" });
  }
  // a virtual account whose runAs is unknown is refused the same way
  const v = await get(app, "/api/fs/stat?path=/", { ...virt("guest9", [{ path: "/", write: true }]), runAs: "bob" });
  assert.equal(v.status, 403);
  assert.equal(starts, 0);
  assert.equal(poolOf(app)!.list().length, 0);
});

test("root routes stay", async () => {
  let starts = 0;
  const app = agent({}, { accounts: accounts(), startWorker: async () => (starts++, assert.fail("no worker may start")) });
  assert.equal((await get(app, "/healthz", null)).status, 200);
  assert.equal((await get(app, "/healthz", sys("alice"))).status, 200);
  const info = await get(app, "/api/info", sys("alice"));
  assert.equal(info.status, 200);
  assert.equal(((await info.json()) as { node: string }).node, "t");
  assert.equal((await get(app, "/metrics", null)).status, 200);
  assert.equal((await get(app, "/api/jobs", sys("alice"))).status, 200);
  assert.equal(starts, 0);
  assert.equal(poolOf(app)!.list().length, 0);
  // the split itself
  assert.ok(isRootRoute("GET", "/api/du"));
  assert.ok(isRootRoute("POST", "/api/jobs/size"));
  assert.ok(isRootRoute("GET", "/api/jobs/abc"));
  assert.ok(isRootRoute("POST", "/api/jobs/abc/cancel"));
  assert.ok(isRootRoute("DELETE", "/api/jobs/abc"));
  assert.ok(!isRootRoute("POST", "/api/jobs/compress"), "archive jobs run as the account");
  assert.ok(!isRootRoute("POST", "/api/jobs/extract"));
  assert.ok(!isRootRoute("GET", "/api/fs/list"));
  assert.ok(!isRootRoute("GET", "/healthz/x"));
  assert.ok(!isRootRoute("GET", "/api/info/"));
});

test("worker key", () => {
  assert.equal(workerKey(sys("alice")), "sys:alice");
  const a = workerKey(virt("guest1", [{ path: "/a", write: true }, { path: "/b", write: false }]));
  const b = workerKey(virt("guest1", [{ path: "/b", write: false }, { path: "/a", write: true }]));
  const c = workerKey(virt("guest1", [{ path: "/a", write: false }, { path: "/b", write: false }]));
  assert.match(a, /^virt:guest1:[0-9a-f]{16}$/);
  assert.equal(a, b, "the order of the grants does not matter");
  assert.notEqual(a, c, "other grants, another key");
  assert.notEqual(a, workerKey({ ...virt("guest1", [{ path: "/a", write: true }, { path: "/b", write: false }]), runAs: "alice" }), "another runAs, another key");
});

test("same runAs, other grants", { skip: !landlock && "sandbox live: skipped (no Landlock on this kernel)" }, async () => {
  const app = agent();
  const one = virt("guest1", [{ path: "/", write: true }]);
  const two = virt("guest2", [{ path: "/", write: false }]);
  assert.equal((await get(app, "/api/fs/stat?path=/", one)).status, 200);
  assert.equal((await get(app, "/api/fs/stat?path=/", two)).status, 200);
  const list = poolOf(app)!.list();
  assert.deepEqual(list.map((w) => w.key).sort(), [workerKey(one), workerKey(two)].sort());
  assert.notEqual(list[0]!.pid, list[1]!.pid);
});

test("epoch change", async () => {
  const app = agent();
  const pool = poolOf(app)!;
  assert.equal((await get(app, "/api/fs/stat?path=/", sys("alice", 1))).status, 200);
  const first = pool.list()[0]!.pid;
  assert.equal((await get(app, "/api/fs/stat?path=/", sys("alice", 2))).status, 200);
  const second = pool.list()[0]!.pid;
  assert.notEqual(second, first, "a new worker for the new epoch");
  assert.ok(!alive(first), "the epoch-1 worker has exited");
  const old = await get(app, "/api/fs/stat?path=/", sys("alice", 1));
  assert.equal(old.status, 401);
  assert.deepEqual(await old.json(), { error: "account changed" });
  assert.deepEqual(
    pool.list().map((w) => w.pid),
    [second],
  );
  // every key of a virtual account goes when its epoch rises
  const g1 = virt("guest1", [{ path: "/", write: true }], 5);
  const g2 = virt("guest1", [{ path: "/", write: false }], 5);
  assert.equal((await get(app, "/api/fs/stat?path=/", g1)).status, 200);
  assert.equal((await get(app, "/api/fs/stat?path=/", g2)).status, 200);
  const before = pool.list().filter((w) => w.key.startsWith("virt:guest1:")).map((w) => w.pid);
  assert.equal(before.length, 2);
  assert.equal((await get(app, "/api/fs/stat?path=/", { ...g1, epoch: 6 })).status, 200);
  assert.ok(before.every((pid) => !alive(pid)), "both workers of the old epoch have exited");
  assert.deepEqual(
    pool.list().filter((w) => w.key.startsWith("virt:guest1:")).map((w) => w.key),
    [workerKey(g1)],
  );
  assert.equal((await get(app, "/api/fs/stat?path=/", g2)).status, 401, "the other grants at the old epoch");
});

test("old epoch inside the pool: a request waiting in a held-back start gets 401, and the worker that stays has the new epoch", async () => {
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  const epochOf = new Map<number, number>();
  let calls = 0;
  const app = agent({}, {
    accounts: accounts(),
    startWorker: async (s) => {
      if (calls++ === 0) await held;
      const child = await startWorkerProcess(s);
      epochOf.set(child.pid!, s.epoch);
      return child;
    },
  });
  const old = get(app, "/api/fs/stat?path=/", sys("alice", 1));
  assert.ok(await until(() => calls === 1, 5000));
  const newer = get(app, "/api/fs/stat?path=/", sys("alice", 2));
  await new Promise((r) => setTimeout(r, 50)); // (the new epoch has reached the pool's stop)
  release();
  const o = await old;
  assert.equal(o.status, 401);
  assert.deepEqual(await o.json(), { error: "account changed" });
  assert.equal((await newer).status, 200);
  const live = poolOf(app)!.list();
  assert.equal(live.length, 1);
  assert.equal(epochOf.get(live[0]!.pid), 2);
});

test("the workers' area is new for each agent, root's only, and removed on close", async () => {
  const a = agent();
  const b = agent();
  const base = baseOf(a)!;
  assert.ok(base && baseOf(b) && base !== baseOf(b));
  const st = fs.lstatSync(base);
  assert.ok(st.isDirectory());
  assert.equal(st.uid, me);
  assert.equal(st.mode & 0o7777, IS_ROOT ? 0o711 : 0o700);
  assert.equal((await get(a, "/api/fs/stat?path=/", sys("alice"))).status, 200);
  const key = fs.lstatSync(path.join(base, `u${fakeAccountUid()}`));
  assert.equal(key.mode & 0o7777, 0o700);
  await (a as unknown as { close(): Promise<void> }).close();
  assert.ok(!fs.existsSync(base), "removed on close");
});

const fakeAccountUid = () => (IS_ROOT ? 65534 : me);

test("a key folder that is already there must be the account's own and private, and is never changed", async () => {
  const logs: string[] = [];
  const orig = console.error;
  console.error = (s: string) => logs.push(String(s));
  try {
    const app = agent({}, { accounts: fakeResolver({ alice: {}, carol: { uid: 4242 } }) });
    const base = baseOf(app)!;
    // owned by another uid (this process): refused, and left as it was
    const carol = path.join(base, "u4242");
    fs.mkdirSync(carol, { mode: 0o700 });
    const r = await get(app, "/api/fs/stat?path=/", sys("carol"));
    assert.equal(r.status, 503);
    assert.deepEqual(await r.json(), { error: "worker folders are not safe" });
    assert.equal(fs.lstatSync(carol).uid, me, "not given away");
    assert.ok(logs.some((l) => l.includes("u4242") && l.includes("owner")), logs.join("\n"));
    // a link in place of the key folder
    const own = path.join(base, `u${fakeAccountUid()}`);
    const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), "filedeck-elsewhere-"));
    fs.symlinkSync(elsewhere, own);
    const l = await get(app, "/api/fs/stat?path=/", sys("alice"));
    assert.equal(l.status, 503);
    assert.deepEqual(await l.json(), { error: "worker folders are not safe" });
    assert.deepEqual(fs.readdirSync(elsewhere), [], "nothing made through the link");
    fs.rmSync(elsewhere, { recursive: true });
    // one others may write to
    fs.unlinkSync(own);
    fs.mkdirSync(own, { mode: 0o700 });
    if (IS_ROOT) fs.chownSync(own, 65534, 65534);
    fs.chmodSync(own, 0o770);
    assert.equal((await get(app, "/api/fs/stat?path=/", sys("alice"))).status, 503);
    assert.equal(fs.lstatSync(own).mode & 0o7777, 0o770, "not changed");
    assert.equal(poolOf(app)!.list().length, 0, "no worker started");
  } finally {
    console.error = orig;
  }
});

test("worker folders: made once per key, made again after a failed start; one name rule for folders and trash", async () => {
  const specs = makeWorkerSpecs(loadConfig({ FILEDECK_ROOT: tmp, FILEDECK_NODE: "t" } as never));
  try {
    const account = (await accounts().resolve("alice"))!;
    const s1 = await specs.spec(sys("alice"), account);
    const dir = path.dirname(s1.tmp!);
    fs.chmodSync(dir, 0o777); // would be refused if it were checked again
    const s2 = await specs.spec(sys("alice"), account);
    assert.equal(s2.tmp, s1.tmp, "the folders are not checked again for each request");
    s2.startFailed!();
    await assert.rejects(specs.spec(sys("alice"), account), /owner .* mode 777/);
    fs.chmodSync(dir, 0o700);
    // a virtual account's name that does not fit the folder rule: one name for its folders and its trash
    const v = await specs.spec(virt("Guest One", [{ path: "/", write: true }]), account);
    assert.match(v.init.trashFolder, /^v-h[0-9a-f]{16}$/);
    assert.ok(path.basename(path.dirname(v.tmp!)).startsWith(`${v.init.trashFolder}-`));
    const w = await specs.spec(virt("guest1", [{ path: "/", write: true }]), account);
    assert.equal(w.init.trashFolder, "v-guest1");
    assert.match(path.basename(path.dirname(w.tmp!)), /^v-guest1-[0-9a-f]{16}$/);
  } finally {
    await specs.close();
  }
});

test("HEAD through the gate: 200, the length kept, nothing logged as failed", async () => {
  const logs: string[] = [];
  const orig = console.error;
  console.error = (x: string) => logs.push(String(x));
  try {
    const app = agent();
    const r = await app.request("/api/fs/read?path=/a.txt", { method: "HEAD", headers: headers(sys("alice")) });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("content-length"), "6");
    assert.equal(await r.text(), "");
    await new Promise((res) => setTimeout(res, 50));
    assert.ok(!logs.some((l) => l.includes("failed")), logs.join("\n"));
  } finally {
    console.error = orig;
  }
});

test("a new key folder: its tmp is made while it is still root's, and a folder swapped in is refused, never changed", async () => {
  const cfg = loadConfig({ FILEDECK_ROOT: tmp, FILEDECK_NODE: "t" } as never);
  const account = (await accounts().resolve("alice"))!;
  const other = fs.mkdtempSync(path.join(os.tmpdir(), "filedeck-swapped-"));
  fs.chmodSync(other, 0o755);
  if (IS_ROOT) fs.chownSync(other, 65534, 65534);
  try {
    for (const at of ["key", "tmp"]) {
      // the account (owner of the key folder once it is handed over) swaps a link in right after the mkdir
      const seen: { step: string; owner: number }[] = [];
      const specs = makeWorkerSpecs(cfg, {
        afterMkdir: (step, p) => {
          seen.push({ step, owner: fs.lstatSync(path.dirname(p)).uid });
          if (step !== at) return;
          fs.rmdirSync(p);
          fs.symlinkSync(other, p);
        },
      });
      try {
        await assert.rejects(specs.spec(sys("alice"), account), { name: "UnsafeFolders" });
        const st = fs.statSync(other);
        assert.equal(st.mode & 0o7777, 0o755, "the swapped-in folder is not changed");
        assert.equal(st.uid, IS_ROOT ? 65534 : me);
      } finally {
        await specs.close();
      }
      // a real folder swapped in (not ours, or open to others) is refused too
      const specs2 = makeWorkerSpecs(cfg, {
        afterMkdir: (step, p) => {
          if (step !== at) return;
          fs.rmdirSync(p);
          fs.mkdirSync(p, { mode: 0o755 });
          fs.chmodSync(p, 0o755);
          if (IS_ROOT) fs.chownSync(p, 65534, 65534);
        },
      });
      try {
        await assert.rejects(specs2.spec(sys("alice"), account), { name: "UnsafeFolders" });
      } finally {
        await specs2.close();
      }
      if (at === "key") continue;
      // the subfolders were made while the key folder still belonged to this process
      const specs3 = makeWorkerSpecs(cfg, { afterMkdir: (step, p) => void seen.push({ step, owner: fs.lstatSync(path.dirname(p)).uid }) });
      seen.length = 0;
      try {
        await specs3.spec(sys("alice"), account);
        // (the caches are outside the key folder now, in their own root-owned parents: see worker-confine.test.ts)
        assert.deepEqual(seen.map((x) => x.step).slice(0, 2), ["key", "tmp"]);
        assert.equal(seen[1]!.owner, me, "the key folder is still ours while its tmp is made");
        const key = fs.lstatSync(path.join(specs3.base, `u${account.uid}`));
        assert.equal(key.uid, account.uid);
        assert.equal(key.mode & 0o7777, 0o700);
      } finally {
        await specs3.close();
      }
    }
  } finally {
    fs.rmSync(other, { recursive: true, force: true });
  }
});

test("an existing key folder with a subfolder missing is refused, not filled in", async () => {
  const specs = makeWorkerSpecs(loadConfig({ FILEDECK_ROOT: tmp, FILEDECK_NODE: "t" } as never));
  try {
    const account = (await accounts().resolve("alice"))!;
    const s1 = await specs.spec(sys("alice"), account);
    fs.rmdirSync(s1.tmp!);
    s1.startFailed!();
    await assert.rejects(specs.spec(sys("alice"), account), { name: "UnsafeFolders" });
    assert.ok(!fs.existsSync(s1.tmp!));
  } finally {
    await specs.close();
  }
});

test("removal: an account's folders are emptied as the account, never walked by root; links in them are not followed", async () => {
  const cfg = loadConfig({ FILEDECK_ROOT: tmp, FILEDECK_NODE: "t" } as never);
  const account = (await accounts().resolve("alice"))!;
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "filedeck-outside-"));
  fs.writeFileSync(path.join(outside, "keep.txt"), "keep");
  const listed: string[] = [];
  const emptied: string[] = [];
  const specs = makeWorkerSpecs(cfg, {
    onRootList: (d) => listed.push(d),
    onEmpty: (d) => {
      emptied.push(d);
      // the account swaps a folder for a link to the outside just as the removal starts
      fs.renameSync(path.join(d, "tmp/a"), path.join(d, "tmp/a2"));
      fs.symlinkSync(outside, path.join(d, "tmp/a"));
    },
  });
  try {
    const s1 = await specs.spec(sys("alice"), account);
    // what the account leaves in its folders: a link to a folder outside, and a tree
    fs.symlinkSync(outside, path.join(s1.tmp!, "out"));
    fs.mkdirSync(path.join(s1.tmp!, "a/b"), { recursive: true });
    fs.writeFileSync(path.join(s1.tmp!, "a/b/f"), "x");
    if (IS_ROOT) chownForTest(s1.tmp!);
    await specs.close();
    assert.equal(fs.readFileSync(path.join(outside, "keep.txt"), "utf8"), "keep", "nothing removed through the link");
    assert.ok(!fs.existsSync(specs.base), "the area is gone once its folders could be emptied");
    const keyDir = path.dirname(s1.tmp!);
    assert.deepEqual(emptied.map((d) => path.basename(d)), [path.basename(keyDir)], "the account's key folder is emptied by the account");
    assert.deepEqual(listed, [specs.base], "root lists only its own folders");
  } finally {
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test("removal: an area renamed away and replaced by a link is removed through its descriptor; nothing behind the link is touched", async () => {
  const cfg = loadConfig({ FILEDECK_ROOT: tmp, FILEDECK_NODE: "t" } as never);
  const account = (await accounts().resolve("alice"))!;
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "filedeck-outside-"));
  fs.writeFileSync(path.join(outside, "keep.txt"), "keep");
  fs.mkdirSync(path.join(outside, `u${account.uid}`));
  fs.writeFileSync(path.join(outside, `u${account.uid}`, "keep2.txt"), "keep");
  const logs: string[] = [];
  const specs = makeWorkerSpecs(cfg, { log: (l) => logs.push(l) });
  const moved = `${specs.base}.moved`;
  try {
    const s1 = await specs.spec(sys("alice"), account);
    fs.writeFileSync(path.join(s1.tmp!, "f"), "x");
    if (IS_ROOT) chownForTest(s1.tmp!);
    // another user of the temporary folder moves the area away and puts a link to its own folder in its place
    fs.renameSync(specs.base, moved);
    fs.symlinkSync(outside, specs.base);
    await specs.close();
    assert.equal(fs.readFileSync(path.join(outside, "keep.txt"), "utf8"), "keep");
    assert.equal(fs.readFileSync(path.join(outside, `u${account.uid}`, "keep2.txt"), "utf8"), "keep");
    assert.ok(fs.lstatSync(specs.base).isSymbolicLink(), "the link is not removed either");
    assert.deepEqual(fs.readdirSync(moved), [], "the real area was emptied through its descriptor");
    assert.ok(logs.some((l) => l.includes("no longer names the area")), logs.join("\n"));
  } finally {
    fs.rmSync(outside, { recursive: true, force: true });
    fs.rmSync(moved, { recursive: true, force: true });
    fs.rmSync(specs.base, { force: true });
  }
});

test("removal: a folder the account's removal cannot empty is left, logged, and never removed by root", async () => {
  if (!IS_ROOT) return; // (without root every folder is this process's own)
  const cfg = loadConfig({ FILEDECK_ROOT: tmp, FILEDECK_NODE: "t" } as never);
  const account = (await accounts().resolve("alice"))!;
  const logs: string[] = [];
  const specs = makeWorkerSpecs(cfg, { log: (l) => logs.push(l) });
  const s1 = await specs.spec(sys("alice"), account);
  // a folder in the account's folder that only root may change: the account cannot empty it
  const stuck = path.join(s1.tmp!, "stuck");
  fs.mkdirSync(stuck);
  fs.writeFileSync(path.join(stuck, "f"), "x");
  fs.chmodSync(stuck, 0o755);
  await specs.close();
  assert.ok(fs.existsSync(path.join(stuck, "f")), "root did not remove it");
  assert.ok(logs.some((l) => l.includes("left")), logs.join("\n"));
  fs.rmSync(specs.base, { recursive: true, force: true });
});

test("thumbnail caches: each account gets its share of the limit", async () => {
  const MiB = 1024 * 1024;
  const account = (await accounts().resolve("alice"))!;
  for (const [limit, max, share] of [
    [60 * MiB, 3, 20 * MiB],
    [64 * MiB, 8, 16 * MiB], // (never under 16 MiB)
  ] as const) {
    const cfg = loadConfig({ FILEDECK_ROOT: tmp, FILEDECK_NODE: "t", FILEDECK_THUMB_CACHE_MAX: String(limit), FILEDECK_MAX_WORKERS: String(max) } as never);
    const specs = makeWorkerSpecs(cfg);
    try {
      const s = await specs.spec(sys("alice"), account);
      assert.equal(s.init.cfg.thumbCacheMax, share);
      if (share * max === limit) assert.ok(s.init.cfg.thumbCacheMax * max <= limit, "every running worker's cache together stays within the limit");
    } finally {
      await specs.close();
    }
  }
});

test("thumbnail caches: emptied as the account when its worker stops, and at agent start; the folder stays", async () => {
  const thumbs = fs.mkdtempSync(path.join(os.tmpdir(), "filedeck-thumbcaches-"));
  fs.chmodSync(thumbs, 0o755);
  const uid = fakeAccountUid();
  const cache = path.join(thumbs, "accounts", `u${uid}`);
  const put = () => {
    fs.writeFileSync(path.join(cache, "t1.webp"), "x");
    // as root: a folder in the cache that only root may change, so the account cannot empty it (root never walks it)
    if (IS_ROOT) {
      fs.mkdirSync(path.join(cache, "rootonly"), { recursive: true });
      fs.writeFileSync(path.join(cache, "rootonly/f"), "x");
      fs.chmodSync(path.join(cache, "rootonly"), 0o755);
    }
    if (IS_ROOT) fs.lchownSync(path.join(cache, "t1.webp"), uid, uid);
  };
  const logs: string[] = [];
  const orig = console.error;
  console.error = (s: string) => logs.push(String(s));
  try {
    const app = agent({ FILEDECK_THUMB_DIR: thumbs });
    assert.equal((await get(app, "/api/fs/stat?path=/", sys("alice"))).status, 200);
    put();
    await poolOf(app)!.stopKey("sys:alice");
    assert.ok(await until(() => !fs.existsSync(path.join(cache, "t1.webp")), 10_000), `emptied once its worker stopped\n${logs.join("\n")}`);
    assert.equal(fs.lstatSync(cache).uid, uid, "the folder stays, still the account's");
    if (IS_ROOT) assert.ok(fs.existsSync(path.join(cache, "rootonly/f")), "emptied by the account, not walked by root");
    await (app as unknown as { close(): Promise<void> }).close();
    // a cache left by an earlier agent (no worker runs for it) is emptied at start
    put();
    const other = path.join(thumbs, "accounts", "u4242");
    fs.mkdirSync(other, { mode: 0o700 });
    if (IS_ROOT) fs.chownSync(other, 4242, 4242);
    fs.writeFileSync(path.join(other, "t2.webp"), "x");
    if (IS_ROOT) fs.lchownSync(path.join(other, "t2.webp"), 4242, 4242);
    const app2 = agent({ FILEDECK_THUMB_DIR: thumbs });
    assert.ok(await until(() => !fs.existsSync(path.join(cache, "t1.webp")) && !fs.existsSync(path.join(other, "t2.webp")), 10_000), `emptied at start\n${logs.join("\n")}`);
    assert.ok(fs.existsSync(other));
    await (app2 as unknown as { close(): Promise<void> }).close();
  } finally {
    console.error = orig;
    fs.rmSync(thumbs, { recursive: true, force: true });
  }
});

test("auth off", async () => {
  let starts = 0;
  let lookups = 0;
  const app = agent(
    { FILEDECK_AUTH: "off" },
    {
      accounts: { resolve: async () => (lookups++, null) },
      startWorker: async () => (starts++, assert.fail("no worker may start")),
    },
  );
  assert.equal(poolOf(app), undefined, "no pool");
  const r = await app.request("/api/fs/stat?path=/", { headers: { authorization: `Bearer ${T}`, [USER_HEADER]: "garbage" } });
  assert.equal(r.status, 200);
  assert.equal(starts, 0);
  assert.equal(lookups, 0);
});

test("a client that drops an open stream frees the worker", async () => {
  const app = agent();
  const pool = poolOf(app)!;
  const srv = await new Promise<ReturnType<typeof serve>>((res) => {
    const s = serve({ fetch: app.fetch, port: 0 }, () => res(s));
  });
  try {
    const url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}/api/events?path=/`;
    const ac = new AbortController();
    const r = await fetch(url, { headers: headers(sys("alice")), signal: ac.signal });
    assert.equal(r.status, 200);
    const reader = r.body!.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    assert.match(first, /event: ready/);
    assert.equal(pool.list()[0]?.busy, true, "the open stream keeps the worker busy");
    ac.abort();
    await reader.cancel().catch(() => {});
    assert.ok(await until(() => pool.list()[0]?.busy === false, 1000), "the worker is free again within 1 s");
  } finally {
    srv.close();
    (srv as unknown as { closeAllConnections?(): void }).closeAllConnections?.();
  }
});

// ---- the gate's own answers, with a stand-in pool ----

interface Seen {
  spec: WorkerSpec;
  req: Request;
  body: string;
}

function gateApp(o: { fetch?: (spec: WorkerSpec, req: Request) => Promise<Response>; accounts?: AccountResolver; logs?: string[] } = {}) {
  const seen: Seen[] = [];
  const stopped: string[] = [];
  const logs = o.logs ?? [];
  const pool = {
    async fetch(spec: WorkerSpec, req: Request) {
      seen.push({ spec, req, body: req.body ? await new Response(req.body).text() : "" });
      return o.fetch ? o.fetch(spec, req) : new Response("ok");
    },
    list: () => [],
    async stopAccount(kind: string, name: string, _epoch?: number) {
      stopped.push(`${kind}:${name}`);
    },
  } as unknown as WorkerPool;
  const app = new Hono();
  app.use("*", async (c, next) => {
    const v = c.req.header("x-test-claim");
    if (v) c.set("user", JSON.parse(v));
    await next();
  });
  app.use(
    "*",
    workerGate(loadConfig({ FILEDECK_ROOT: tmp, FILEDECK_NODE: "t" } as never), {
      pool,
      accounts: o.accounts ?? accounts(),
      spec: async (claim, account) => ({ key: workerKey(claim), kind: claim.kind, name: claim.name, epoch: claim.epoch, account, init: {} as never }),
      log: (s) => logs.push(s),
    }),
  );
  app.get("/healthz", (c) => c.text("root"));
  const call = (p: string, init: RequestInit & { claim?: UserClaim } = {}) =>
    app.request(p, { ...init, headers: { ...(init.headers as Record<string, string>), ...(init.claim ? { "x-test-claim": JSON.stringify(init.claim) } : {}) } });
  return { call, seen, stopped, logs };
}

test("forwarded request: method, path, query, body and headers, without the credentials", async () => {
  const g = gateApp();
  const r = await g.call("/api/fs/write?path=/x&create=1", {
    method: "PUT",
    claim: sys("alice"),
    headers: { authorization: `Bearer ${T}`, cookie: "a=b", [USER_HEADER]: "signed", "x-other": "kept", "content-type": "application/octet-stream" },
    body: "payload",
  });
  assert.equal(r.status, 200);
  const s = g.seen[0]!;
  assert.equal(s.req.method, "PUT");
  assert.equal(new URL(s.req.url).pathname + new URL(s.req.url).search, "/api/fs/write?path=/x&create=1");
  assert.equal(s.body, "payload");
  assert.equal(s.req.headers.get("x-other"), "kept");
  assert.equal(s.req.headers.get("content-type"), "application/octet-stream");
  for (const h of ["authorization", "cookie", USER_HEADER]) assert.equal(s.req.headers.get(h), null, h);
  assert.equal(s.spec.key, "sys:alice");
  // a path the root process keeps is not forwarded
  assert.equal(await (await g.call("/healthz", { claim: sys("alice") })).text(), "root");
  assert.equal(g.seen.length, 1);
});

test("the client's signal reaches the request the pool gets (a request still waiting for its head is ended)", async () => {
  const g = gateApp({
    fetch: (_spec, req) =>
      new Promise((_res, rej) => {
        if (req.signal.aborted) rej(req.signal.reason);
        req.signal.addEventListener("abort", () => rej(req.signal.reason), { once: true });
      }),
  });
  const ac = new AbortController();
  const r = g.call("/api/fs/stat?path=/", { claim: sys("alice"), signal: ac.signal });
  await until(() => g.seen.length === 1, 1000);
  ac.abort();
  assert.equal((await r).status, 499);
  assert.equal(g.seen[0]!.req.signal.aborted, true);
});

test("the worker's answer head is not trusted", async () => {
  const g = gateApp({
    fetch: async () =>
      new Response("body", {
        status: 207,
        headers: {
          "set-cookie": "s=1",
          connection: "close, x-hop",
          "x-hop": "1",
          "keep-alive": "timeout=5",
          "transfer-encoding": "chunked",
          upgrade: "h2c",
          "proxy-authenticate": "Basic",
          te: "trailers",
          trailer: "x-t",
          "x-filedeck-jobs": "3",
          "content-type": "text/plain",
          "x-kept": "yes",
        },
      }),
  });
  const r = await g.call("/api/fs/stat?path=/", { claim: sys("alice") });
  assert.equal(r.status, 207);
  assert.equal(await r.text(), "body");
  for (const h of ["set-cookie", "connection", "x-hop", "keep-alive", "transfer-encoding", "upgrade", "proxy-authenticate", "te", "trailer", "x-filedeck-jobs"]) {
    assert.equal(r.headers.get(h), null, h);
  }
  assert.equal(r.headers.get("x-kept"), "yes");
  assert.equal(r.headers.get("content-type"), "text/plain");
});

test("the gate's answers: pool full, worker gone, worker error, lookup failed", async () => {
  const logs: string[] = [];
  let fail: Error = new PoolFull();
  const g = gateApp({ logs, fetch: async () => Promise.reject(fail) });
  const full = await g.call("/api/fs/stat?path=/", { claim: sys("alice") });
  assert.equal(full.status, 503);
  assert.equal(full.headers.get("retry-after"), "5");
  assert.deepEqual(await full.json(), { error: "too many people are using this machine; try again" });
  fail = new WorkerGone();
  const gone = await g.call("/api/fs/stat?path=/", { claim: sys("alice") });
  assert.equal(gone.status, 503);
  assert.deepEqual(await gone.json(), { error: "worker stopped" });
  fail = new Error("secret detail /etc/shadow");
  const err = await g.call("/api/fs/stat?path=/", { claim: sys("alice") });
  assert.equal(err.status, 500);
  const text = await err.text();
  assert.deepEqual(JSON.parse(text), { error: "worker error" });
  assert.ok(!text.includes("secret"), "the worker's text never reaches the client");
  assert.ok(logs.some((l) => l.includes("secret detail")), "it is logged");
  // a lookup that fails is not "no account"
  const broken = gateApp({ logs, accounts: { resolve: () => Promise.reject(new Error("helper killed")) } });
  const r = await broken.call("/api/fs/stat?path=/", { claim: sys("alice") });
  assert.equal(r.status, 503);
  assert.deepEqual(await r.json(), { error: "account lookup failed; try again" });
  assert.equal(broken.seen.length, 0);
  // a request without a claim never reaches a worker
  const none = await g.call("/api/fs/stat?path=/");
  assert.equal(none.status, 401);
});

test("a stale epoch from the pool is 401; one fresh lookup per key at a time", async () => {
  const g = gateApp({ fetch: async () => Promise.reject(new StaleEpoch()) });
  const r = await g.call("/api/fs/stat?path=/", { claim: sys("alice") });
  assert.equal(r.status, 401);
  assert.deepEqual(await r.json(), { error: "account changed" });
  let freshCalls = 0;
  let release!: () => void;
  const slow = new Promise<void>((res) => (release = res));
  const base = accounts();
  const h = gateApp({ accounts: { resolve: async (n, f) => (f && freshCalls++, await slow, base.resolve(n, f)) } });
  const all = [1, 2, 3].map(() => h.call("/api/fs/stat?path=/", { claim: sys("alice") }));
  await new Promise((res) => setTimeout(res, 20));
  release();
  for (const x of await Promise.all(all)) assert.equal(x.status, 200);
  assert.equal(freshCalls, 1);
});

test("a content-length from the worker: kept when it is a number and the body is held to it, else dropped", async () => {
  const logs: string[] = [];
  let res = () => new Response("abc", { headers: { "content-length": "10" } });
  const g = gateApp({ logs, fetch: async () => res() });
  const short = await g.call("/api/fs/read?path=/a.txt", { claim: sys("alice") });
  assert.equal(short.headers.get("content-length"), "10");
  await assert.rejects(short.text());
  assert.ok(logs.some((l) => l.includes("it said 10")));
  res = () => new Response("abcdef", { headers: { "content-length": "2" } });
  await assert.rejects((await g.call("/api/fs/read?path=/a.txt", { claim: sys("alice") })).text());
  res = () => new Response("abc", { headers: { "content-length": "3" } });
  assert.equal(await (await g.call("/api/fs/read?path=/a.txt", { claim: sys("alice") })).text(), "abc");
  res = () => new Response("abc", { headers: { "content-length": "3, 3" } });
  const odd = await g.call("/api/fs/read?path=/a.txt", { claim: sys("alice") });
  assert.equal(odd.headers.get("content-length"), null);
  assert.equal(await odd.text(), "abc");
});

test("an error after the head ends the body with an error that holds none of the worker's text", async () => {
  const logs: string[] = [];
  const g = gateApp({
    logs,
    fetch: async () =>
      new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(new TextEncoder().encode("part"));
            c.error(new Error("secret detail after the head"));
          },
        }),
      ),
  });
  const r = await g.call("/api/fs/read?path=/a.txt", { claim: sys("alice") });
  assert.equal(r.status, 200);
  const err = await r.text().then(
    () => null,
    (e: Error) => e,
  );
  assert.ok(err, "the body ends with an error");
  assert.ok(!String(err.message).includes("secret") && !String((err.cause as Error | undefined)?.message ?? "").includes("secret"));
  assert.ok(logs.some((l) => l.includes("secret detail after the head")));
});

test("epochs at the gate: a higher one stops the account first, a lower one is refused", async () => {
  const g = gateApp();
  assert.equal((await g.call("/api/fs/stat?path=/", { claim: sys("alice", 3) })).status, 200);
  assert.deepEqual(g.stopped, []);
  assert.equal((await g.call("/api/fs/stat?path=/", { claim: sys("alice", 4) })).status, 200);
  assert.deepEqual(g.stopped, ["sys:alice"]);
  const old = await g.call("/api/fs/stat?path=/", { claim: sys("alice", 3) });
  assert.equal(old.status, 401);
  assert.deepEqual(await old.json(), { error: "account changed" });
  // a request at the old epoch that was still waiting for its account lookup when the epoch rose does not reach the pool
  let release!: () => void;
  const slow = new Promise<void>((r) => (release = r));
  const base = accounts();
  const h = gateApp({ accounts: { resolve: async (n, f) => (n === "alice" ? await slow : undefined, base.resolve(n, f)) } });
  const waiting = h.call("/api/fs/stat?path=/", { claim: sys("alice", 1) });
  await new Promise((r) => setTimeout(r, 20));
  const newer = h.call("/api/fs/stat?path=/", { claim: sys("alice", 2) });
  release();
  assert.equal((await newer).status, 200);
  assert.equal((await waiting).status, 401);
  assert.equal(h.seen.length, 1);
  assert.equal(h.seen[0]!.spec.epoch, 2);
  // per kind and name: a virtual account of the same name is another account
  assert.equal((await g.call("/api/fs/stat?path=/", { claim: virt("alice", [{ path: "/", write: true }], 1) })).status, 200);
  assert.deepEqual(g.stopped, ["sys:alice"]);
});
