import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, workerConfig } from "../src/config.ts";
import { createWorkerApp, type WorkerInit } from "../src/worker.ts";
import { WorkerGone } from "../src/worker-proto.ts";
import { BACKOFF_MS, MAX_ACCOUNTS, PoolFull, StaleEpoch, WorkerPool, startWorkerProcess, workerLog, type StartWorker, type WorkerSpec } from "../src/worker-pool.ts";
import { resetSandbox } from "../src/sandbox.ts";
import { useSandbox } from "./sandbox-env.ts";
import { chownForTest, testAccount } from "./worker-env.ts";

/**
 * The worker pool with real worker processes (as `testAccount()`, through the sandbox launcher where it can be built), and with a
 * stand-in worker (fake-worker.ts) for the rules a real worker cannot easily show (live jobs, a failed start, requests to the root).
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const temps: string[] = [];
const pools: WorkerPool[] = [];
/** what the pools logged (the worker's own lines among them), shown when a request fails */
const logs: string[] = [];
let tmp = "";
let state = "";

before(async () => {
  const box = await useSandbox();
  temps.push(box.dir);
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "filedeck-pool-root-")));
  state = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "filedeck-pool-state-")));
  temps.push(tmp, state);
  fs.writeFileSync(path.join(tmp, "a.txt"), "alpha\n");
  fs.chmodSync(tmp, 0o755);
  fs.chmodSync(state, 0o755);
  chownForTest(tmp);
  chownForTest(state);
});
after(async () => {
  for (const p of pools) await p.close();
  for (const d of temps) fs.rmSync(d, { recursive: true, force: true });
});

function pool(o: Partial<ConstructorParameters<typeof WorkerPool>[0]> = {}): WorkerPool {
  const p = new WorkerPool({ max: 4, idleMs: 60_000, log: (l) => logs.push(l), ...o });
  pools.push(p);
  return p;
}

/** a spec for a real worker of `testAccount()` over the test tree, with its own index and thumbnail folders */
function spec(key: string, cfgEnv: Record<string, string> = {}): WorkerSpec {
  const account = testAccount();
  const dir = path.join(state, key.replace(/[^a-z0-9]/gi, "_"));
  // the worker's own temporary folder (tsx keeps its cache there when the worker runs from source)
  fs.mkdirSync(path.join(dir, "tmp"), { recursive: true });
  fs.chmodSync(path.join(dir, "tmp"), 0o700); // (a worker checks that its TMPDIR is its own 0700 folder)
  chownForTest(dir);
  const cfg = loadConfig({ FILEDECK_ROOT: tmp, FILEDECK_NODE: "t", ...cfgEnv } as never);
  const init: WorkerInit = {
    cfg: workerConfig(cfg, { thumbs: path.join(dir, "thumbs"), index: path.join(dir, "index") }),
    account: { kind: "sys", name: account.name, uid: account.uid },
    trashFolder: `u${account.uid}`,
  };
  return { key, kind: "sys", name: account.name, epoch: 1, account, init, tmp: path.join(dir, "tmp") };
}

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
const pidOf = (p: WorkerPool, key: string): number => {
  const w = p.list().find((x) => x.key === key);
  assert.ok(w, `no worker for ${key}`);
  return w.pid;
};
const stat = (p: WorkerPool, s: WorkerSpec) => p.fetch(s, new Request("http://agent/api/fs/stat?path=/"));
async function ok(res: Response): Promise<void> {
  const text = await res.text();
  if (res.status !== 200) await new Promise((r) => setTimeout(r, 300)); // the worker's last lines
  assert.equal(res.status, 200, `${text}\n${logs.slice(-20).join("\n")}`);
}

test("reuse", async () => {
  const p = pool();
  const s = spec("sys:reuse");
  await ok(await stat(p, s));
  const pid = pidOf(p, "sys:reuse");
  const res = await stat(p, s);
  assert.equal(res.headers.get("x-filedeck-jobs"), null); // the worker's own report stays in the pool
  await ok(res);
  assert.equal(pidOf(p, "sys:reuse"), pid);
  assert.equal(p.list().length, 1);
});

test("concurrent requests share one start", async () => {
  let starts = 0;
  const p = pool({ start: (s) => (starts++, startWorkerProcess(s)) });
  const s = spec("sys:shared");
  const all = await Promise.all([stat(p, s), stat(p, s), stat(p, s)]);
  for (const r of all) await ok(r);
  assert.equal(starts, 1);
  assert.equal(p.list().length, 1);
});

test("LRU", async () => {
  const p = pool({ max: 2 });
  await ok(await stat(p, spec("sys:lru-a")));
  const a = pidOf(p, "sys:lru-a");
  await ok(await stat(p, spec("sys:lru-b")));
  await ok(await stat(p, spec("sys:lru-c")));
  assert.deepEqual(p.list().map((w) => w.key).sort(), ["sys:lru-b", "sys:lru-c"]);
  assert.ok(await until(() => !alive(a), 8000), "the least recently used worker is still running");
});

test("pool full", async () => {
  const p = pool({ max: 1 });
  const s = spec("sys:full-a");
  const events = await p.fetch(s, new Request("http://agent/api/events?path=/"));
  assert.equal(events.status, 200);
  const reader = events.body!.getReader();
  await reader.read(); // the stream is open
  assert.equal(p.list()[0]!.busy, true);
  await assert.rejects(stat(p, spec("sys:full-b")), PoolFull);
  await reader.cancel();
  // once the stream has ended the worker is idle again and makes room
  assert.ok(await until(() => p.list()[0]?.busy === false, 5000));
  await ok(await stat(p, spec("sys:full-b")));
  assert.deepEqual(p.list().map((w) => w.key), ["sys:full-b"]);
});

test("idle", async () => {
  const p = pool({ idleMs: 200 });
  const s = spec("sys:idle");
  await ok(await stat(p, s));
  const pid = pidOf(p, "sys:idle");
  // stopped after 200 ms without use (checked every 200 ms), and gone within the brief's 1 s
  assert.ok(await until(() => !alive(pid), 1000), "the idle worker is still running");
  assert.equal(p.list().length, 0);
  await ok(await stat(p, s));
  assert.notEqual(pidOf(p, "sys:idle"), pid);
});

test("worker killed mid-request", async () => {
  const p = pool();
  const s = spec("sys:killed");
  const events = await p.fetch(s, new Request("http://agent/api/events?path=/"));
  const reader = events.body!.getReader();
  await reader.read();
  const pid = pidOf(p, "sys:killed");
  // an upload whose body never ends: the worker reads it and answers only at its end, so no head comes before the kill
  let pulled!: () => void;
  const started = new Promise<void>((r) => (pulled = r));
  const body = new ReadableStream<Uint8Array>({
    pull(c) {
      c.enqueue(new TextEncoder().encode("x"));
      pulled();
      return new Promise(() => {});
    },
  });
  const pending = p.fetch(s, new Request("http://agent/api/fs/write?path=/up.txt&create=1", { method: "PUT", body, duplex: "half" } as RequestInit));
  pending.catch(() => {});
  await started;
  await new Promise((r) => setTimeout(r, 200));
  process.kill(pid, "SIGKILL");
  await assert.rejects(pending, WorkerGone);
  await assert.rejects(
    (async () => {
      for (;;) if ((await reader.read()).done) return;
    })(),
  );
  assert.ok(await until(() => p.list().length === 0, 5000), "the dead worker is still listed");
  await ok(await stat(p, s));
  assert.notEqual(pidOf(p, "sys:killed"), pid);
});

/** Reads a worker's /proc file. Root without CAP_SYS_PTRACE (a container build) may not read another user's environ or fdinfo, so
 *  on EACCES the read is done again as the worker's own user, which needs no capability. */
function procRead(pid: number, name: string): string {
  const file = `/proc/${pid}/${name}`;
  try {
    return fs.readFileSync(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EACCES" || process.getuid?.() !== 0) throw e;
    const ids = /^Uid:\s+(\d+)[\s\S]*^Gid:\s+(\d+)/m.exec(fs.readFileSync(`/proc/${pid}/status`, "utf8"));
    assert.ok(ids, `no ids for ${pid}`);
    const r = spawnSync(process.execPath, ["-e", "process.stdout.write(require('fs').readFileSync(process.argv[1]))", file], { uid: Number(ids[1]), gid: Number(ids[2]), encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout;
  }
}

test("no secrets", async () => {
  const saved = { a: process.env.FILEDECK_AGENT_TOKEN, v: process.env.FILEDECK_VAULT_KEY };
  process.env.FILEDECK_AGENT_TOKEN = "t0k3n";
  process.env.FILEDECK_VAULT_KEY = "v4ult";
  try {
    const p = pool();
    const s = spec("sys:secrets", { FILEDECK_AGENT_TOKEN: "t0k3n", FILEDECK_VAULT_KEY: "v4ult" });
    await ok(await stat(p, s));
    const pid = pidOf(p, "sys:secrets");
    const environ = procRead(pid, "environ");
    const cmdline = procRead(pid, "cmdline");
    const init = JSON.stringify(s.init);
    for (const secret of ["t0k3n", "v4ult"]) {
      assert.ok(!environ.includes(secret), `${secret} in the environment`);
      assert.ok(!cmdline.includes(secret), `${secret} in the arguments`);
      assert.ok(!init.includes(secret), `${secret} in the start-up message`);
    }
    // only the names the pool hands on
    const names = environ.split("\0").filter(Boolean).map((l) => l.slice(0, l.indexOf("=")));
    const allowed = new Set(["PATH", "LANG", "TZ", "TMPDIR", "HOME", "UV_THREADPOOL_SIZE", "FILEDECK_SANDBOX", "FILEDECK_SANDBOX_HELPER"]);
    for (const n of names) assert.ok(allowed.has(n), `${n} reaches the worker`);
    assert.match(cmdline, /--max-old-space-size=96/);
  } finally {
    if (saved.a === undefined) delete process.env.FILEDECK_AGENT_TOKEN;
    else process.env.FILEDECK_AGENT_TOKEN = saved.a;
    if (saved.v === undefined) delete process.env.FILEDECK_VAULT_KEY;
    else process.env.FILEDECK_VAULT_KEY = saved.v;
  }
});

test("stopKey and stopAccount", async () => {
  const p = pool();
  await ok(await stat(p, spec("sys:stop-a")));
  await ok(await stat(p, { ...spec("sys:stop-b"), name: "other" }));
  await ok(await stat(p, { ...spec("sys:stop-c"), name: "other" }));
  const a = pidOf(p, "sys:stop-a");
  await p.stopKey("sys:stop-a");
  assert.equal(alive(a), false);
  const b = pidOf(p, "sys:stop-b");
  const c = pidOf(p, "sys:stop-c");
  await p.stopAccount("sys", "other");
  assert.equal(alive(b), false);
  assert.equal(alive(c), false);
  assert.equal(p.list().length, 0);
});

test("a start-up message that is too large is a 503 and the child is stopped", async () => {
  let child: ChildProcess | undefined;
  const p = pool({ start: async (s) => (child = await startWorkerProcess(s)) });
  const s = spec("sys:big-init");
  (s.init as unknown as { pad: string }).pad = "x".repeat(70 * 1024);
  const res = await stat(p, s);
  assert.equal(res.status, 503);
  assert.deepEqual(await res.json(), { error: "worker failed to start" });
  assert.ok(child?.pid);
  assert.ok(await until(() => !alive(child!.pid!), 5000), "the child still runs");
  assert.equal(p.list().length, 0);
});

test("an account with more than 256 groups is refused", async () => {
  let starts = 0;
  const p = pool({ start: (s) => (starts++, startWorkerProcess(s)) });
  const s = spec("sys:groups");
  s.account = { ...s.account, groups: Array.from({ length: 257 }, (_, i) => 1000 + i) };
  const res = await stat(p, s);
  assert.equal(res.status, 503);
  assert.deepEqual(await res.json(), { error: "account has too many groups" });
  assert.equal(starts, 0);
});

test("the worker app reports its live jobs on every answer", async () => {
  const app = createWorkerApp(spec("sys:app").init.cfg);
  try {
    assert.equal((await app.request("/api/fs/stat?path=/")).headers.get("x-filedeck-jobs"), "0");
    assert.equal((await app.request("/api/nothing")).headers.get("x-filedeck-jobs"), "0");
    assert.equal((await app.request("/api/fs/stat?path=/missing")).headers.get("x-filedeck-jobs"), "0");
  } finally {
    await (app as unknown as { close: () => Promise<void> }).close();
  }
});

test("a new start for a key waits until its old process has exited", async () => {
  const seen: boolean[] = [];
  let old = 0;
  const p = pool({ start: (sp) => (seen.push(old !== 0 && alive(old)), startWorkerProcess(sp)) });
  const s = spec("sys:restart");
  await ok(await stat(p, s));
  old = pidOf(p, "sys:restart");
  const stopping = p.stopKey("sys:restart");
  await ok(await stat(p, s));
  await stopping;
  assert.deepEqual(seen, [false, false]); // the second start came only after the first process had gone
  assert.notEqual(pidOf(p, "sys:restart"), old);
});

test("stopKey during a start: the waiting request gets a fresh start", async () => {
  const children: ChildProcess[] = [];
  const p = pool({ start: async (sp) => { const c = await startWorkerProcess(sp); children.push(c); return c; } });
  const s = spec("sys:stop-starting");
  const pending = stat(p, s);
  assert.ok(await until(() => children.length === 1, 5000));
  await p.stopKey("sys:stop-starting");
  assert.ok(!alive(children[0]!.pid!), "the cancelled start's process still runs");
  await ok(await pending);
  assert.equal(children.length, 2);
  assert.equal(pidOf(p, "sys:stop-starting"), children[1]!.pid);
});

test("old epoch: a request waiting in a start when the epoch rises is refused, and the worker that stays has the new epoch", async () => {
  const epochs = new Map<number, number>();
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  let calls = 0;
  const p = pool({
    start: async (s) => {
      if (calls++ === 0) await held; // the first start is held back
      const child = await startWorkerProcess(s);
      epochs.set(child.pid!, s.epoch);
      return child;
    },
  });
  const old = { ...spec("sys:epoch"), name: "epoch", epoch: 1 };
  const first = stat(p, old);
  assert.ok(await until(() => calls === 1, 2000));
  const newer = { ...old, epoch: 2 };
  const stopping = p.stopAccount("sys", "epoch", 2);
  const second = stat(p, newer);
  release();
  await stopping;
  await assert.rejects(first, StaleEpoch);
  await ok(await second);
  assert.equal(epochs.get(pidOf(p, "sys:epoch")), 2);
  // a later request at the old epoch never starts a worker
  await p.stopKey("sys:epoch");
  const before = calls;
  await assert.rejects(stat(p, old), StaleEpoch);
  assert.equal(calls, before);
});

test("old epoch: the limit is checked after the start rules have waited", async () => {
  let calls = 0;
  const p = pool({ start: (s) => (calls++, startWorkerProcess(s)) });
  const old = { ...spec("sys:epoch2"), name: "epoch2", epoch: 1 };
  const r = stat(p, old); // waits in the (async) start rules
  void p.stopAccount("sys", "epoch2", 2);
  await assert.rejects(r, StaleEpoch);
  assert.equal(calls, 0);
  assert.equal(p.list().length, 0);
});

test("the lowest allowed epochs: past the bound only entries raised more than 65 s ago are dropped; a young one is never dropped", async () => {
  let t = 1_000_000;
  const p = pool({ now: () => t });
  const who = (name: string) => ({ key: `sys:${name}`, kind: "sys" as const, name, epoch: 1 });
  const req = () => new Request("http://agent/api/jobs");
  await p.stopAccount("sys", "first", 5);
  for (let i = 0; i < MAX_ACCOUNTS; i++) await p.stopAccount("sys", `n${i}`, 5); // (all within 65 s: the map grows past the bound)
  await assert.rejects(p.fetchLive(who("first"), req()), StaleEpoch, "a young entry is kept");
  t += 66_000;
  await p.stopAccount("sys", "late", 5); // (now the old entries may go)
  assert.equal(await p.fetchLive(who("first"), req()), undefined, "an entry raised more than 65 s ago is dropped past the bound");
  await assert.rejects(p.fetchLive(who("late"), req()), StaleEpoch);
});

test("a start waits for the emptying of its uid's thumbnail cache just before the process starts", async () => {
  let calls = 0;
  let finish = () => {};
  const asked: number[] = [];
  const p = pool({
    start: (s) => (calls++, startWorkerProcess(s)),
    // a slow emptying of the cache, as the agent's `emptied(uid)` gives it
    beforeStart: (s) => (asked.push(s.account.uid), new Promise<void>((res) => (finish = res))),
  });
  const s = spec("sys:emptying");
  const r = stat(p, s);
  await new Promise((res) => setTimeout(res, 200));
  assert.deepEqual(asked, [s.account.uid]);
  assert.equal(calls, 0, "no process while the cache is being emptied");
  finish();
  assert.equal((await r).status, 200);
  assert.equal(calls, 1);
});

test("close during a start: the waiting request gets WorkerGone and nothing is left", async () => {
  const children: ChildProcess[] = [];
  const p = pool({ start: async (sp) => { const c = await startWorkerProcess(sp); children.push(c); return c; } });
  const pending = stat(p, spec("sys:close-starting"));
  pending.catch(() => {});
  assert.ok(await until(() => children.length === 1, 5000));
  await p.close();
  await assert.rejects(pending, WorkerGone);
  assert.ok(!alive(children[0]!.pid!), "the process still runs");
  assert.equal(children.length, 1);
  await assert.rejects(stat(p, spec("sys:close-starting")), WorkerGone);
});

test("a worker that dies soon after READY with nothing open: back-off, then a new pid", async () => {
  let t = 1_000_000;
  const p = pool({ now: () => t });
  const s = spec("sys:dies");
  await ok(await stat(p, s));
  const pid = pidOf(p, "sys:dies");
  process.kill(pid, "SIGKILL");
  assert.ok(await until(() => p.list().length === 0, 5000));
  const r = await stat(p, s);
  assert.equal(r.status, 503);
  assert.deepEqual(await r.json(), { error: "worker failed to start" });
  t += BACKOFF_MS + 1;
  await ok(await stat(p, s));
  assert.notEqual(pidOf(p, "sys:dies"), pid);
});

test("the worker's socket is closed on exec", async () => {
  const p = pool();
  await ok(await stat(p, spec("sys:cloexec")));
  const info = procRead(pidOf(p, "sys:cloexec"), "fdinfo/3");
  const flags = /^flags:\s*([0-7]+)$/m.exec(info)?.[1];
  assert.ok(flags && (parseInt(flags, 8) & 0o2000000) !== 0, info);
});

test("a start the sandbox rules refuse does not stop another worker", async () => {
  const p = pool({ max: 1 });
  await ok(await stat(p, spec("sys:keep")));
  const pid = pidOf(p, "sys:keep");
  const s = spec("sys:refused");
  s.landlock = { readOnly: [], readWrite: [], readExec: [] };
  const saved = process.env.FILEDECK_SANDBOX;
  process.env.FILEDECK_SANDBOX = "off"; // no Landlock: a virtual account's worker is refused
  resetSandbox();
  try {
    const r = await stat(p, s);
    assert.equal(r.status, 503);
    assert.deepEqual(await r.json(), { error: "virtual accounts need Landlock on this machine" });
  } finally {
    if (saved === undefined) delete process.env.FILEDECK_SANDBOX;
    else process.env.FILEDECK_SANDBOX = saved;
    resetSandbox();
  }
  assert.equal(pidOf(p, "sys:keep"), pid);
  assert.ok(alive(pid));
});

test("a worker whose TMPDIR is not its own 0700 folder, or is a link, stops at start with one line", async () => {
  const cases: [string, (dir: string) => string][] = [
    ["mode", (dir) => (fs.chmodSync(path.join(dir, "tmp"), 0o755), path.join(dir, "tmp"))],
    ["link", (dir) => (fs.symlinkSync(path.join(dir, "tmp"), path.join(dir, "tmplink")), path.join(dir, "tmplink"))],
  ];
  for (const [name, make] of cases) {
    const s = spec(`sys:badtmp-${name}`);
    const dir = path.dirname(s.tmp!);
    const lines: string[] = [];
    const p = pool({ log: (l) => lines.push(l) });
    const res = await p.fetch({ ...s, tmp: make(dir) }, new Request("http://agent/api/fs/stat?path=/"));
    assert.equal(res.status, 503, name);
    assert.deepEqual(await res.json(), { error: "worker failed to start" });
    assert.ok(lines.some((l) => /worker: its temporary folder .* is not its own/.test(l)), `${name}\n${lines.join("\n")}`);
    assert.equal(p.list().length, 0);
  }
});

test("settings: empty means the default, nonsense is refused", () => {
  const c = loadConfig({ FILEDECK_MAX_WORKERS: "", FILEDECK_WORKER_IDLE_SECONDS: "" } as never);
  assert.equal(c.maxWorkers, 6);
  assert.equal(c.workerIdleMs, 600_000);
  assert.equal(loadConfig({ FILEDECK_MAX_WORKERS: "3", FILEDECK_WORKER_IDLE_SECONDS: "30" } as never).workerIdleMs, 30_000);
  for (const [k, v] of [["FILEDECK_MAX_WORKERS", "0"], ["FILEDECK_MAX_WORKERS", "x"], ["FILEDECK_MAX_WORKERS", "2.5"], ["FILEDECK_WORKER_IDLE_SECONDS", "-1"], ["FILEDECK_WORKER_IDLE_SECONDS", "soon"]]) {
    assert.throws(() => loadConfig({ [k!]: v } as never), new RegExp(k!));
  }
});

/* ---- with the stand-in worker ---- */

const fakeStart = (counter?: { n: number }): StartWorker => async () => {
  if (counter) counter.n++;
  return spawn(process.execPath, ["--import", "tsx", path.join(here, "fake-worker.ts")], { stdio: ["ignore", "pipe", "pipe", "pipe"] });
};
function fakeSpec(key: string, init: Record<string, unknown> = {}): WorkerSpec {
  return { ...spec(key), init: init as unknown as WorkerInit };
}
const get = (p: WorkerPool, s: WorkerSpec, url: string) => p.fetch(s, new Request(`http://agent${url}`));

test("a worker that fails to start gives 503, then the same 503 for a back-off before it is tried again", async () => {
  let t = 1_000_000;
  const starts = { n: 0 };
  const lines: string[] = [];
  const p = pool({ start: fakeStart(starts), now: () => t, log: (l) => lines.push(l) });
  const s = fakeSpec("sys:fails", { fail: true });
  const r1 = await get(p, s, "/x");
  assert.equal(r1.status, 503);
  assert.deepEqual(await r1.json(), { error: "worker failed to start" });
  assert.equal(starts.n, 1);
  assert.ok(await until(() => lines.some((l) => l === "worker sys:fails: worker: Error: start-up failed on purpose"), 3000), lines.join("\n"));
  t += 1000;
  const r2 = await get(p, s, "/x");
  assert.equal(r2.status, 503);
  assert.deepEqual(await r2.json(), { error: "worker failed to start" });
  assert.equal(starts.n, 1); // within the back-off: not started again
  t += 5000;
  const r3 = await get(p, { ...s, init: {} as unknown as WorkerInit }, "/x");
  assert.equal(r3.status, 404); // tried again, and this time it starts
  assert.equal(starts.n, 2);
});

test("a worker with live jobs is busy until it reports none", async () => {
  const p = pool({ max: 1, idleMs: 300, start: fakeStart() });
  const s = fakeSpec("sys:jobs");
  assert.equal((await get(p, s, "/jobs?n=2")).status, 200);
  const pid = pidOf(p, "sys:jobs");
  assert.equal(p.list()[0]!.busy, true);
  await assert.rejects(get(p, fakeSpec("sys:jobs-other"), "/x"), PoolFull);
  // the jobs are still there after the idle time: the worker stays
  await new Promise((r) => setTimeout(r, 1000));
  assert.equal(pidOf(p, "sys:jobs"), pid);
  // the jobs end: the idle check asks again, and the worker then stops
  assert.equal((await get(p, s, "/jobs?n=0")).status, 200);
  assert.ok(await until(() => !alive(pid), 5000), "the worker without jobs still runs");
});

test("the idle check asks again a worker whose jobs have ended since its last answer", async () => {
  const p = pool({ max: 1, idleMs: 300, start: fakeStart() });
  const s = fakeSpec("sys:jobs-stale");
  // one live job that ends by itself 500 ms later, with no request through the pool after it
  assert.equal((await get(p, s, "/jobs?n=1&ms=500")).status, 200);
  const pid = pidOf(p, "sys:jobs-stale");
  assert.equal(p.list()[0]!.busy, true);
  assert.ok(await until(() => !alive(pid), 5000), "the worker whose job ended still runs");
});

test("worker-to-root requests go to the root handler with the worker's own spec, else 404", async () => {
  const seen: string[] = [];
  const p = pool({
    start: fakeStart(),
    rootHandler: async (s, req) => {
      seen.push(`${s.key} ${new URL(req.url).pathname}`);
      return Response.json({ key: s.key });
    },
  });
  const r = await get(p, fakeSpec("sys:rooted"), "/root?path=/_root/whoami");
  assert.deepEqual(await r.json(), { status: 200, text: JSON.stringify({ key: "sys:rooted" }) });
  assert.deepEqual(seen, ["sys:rooted /_root/whoami"]);
  const q = pool({ start: fakeStart() });
  const r2 = await get(q, fakeSpec("sys:unrooted"), "/root?path=/_root/whoami");
  assert.equal(((await r2.json()) as { status: number }).status, 404);
});

test("the worker's stderr is logged line by line, with limits", async () => {
  const lines: string[] = [];
  const p = pool({ start: fakeStart(), log: (l) => lines.push(l) });
  const s = fakeSpec("sys:noisy");
  assert.equal((await get(p, s, "/stderr?n=3")).status, 200);
  assert.ok(await until(() => lines.length >= 3, 3000));
  assert.deepEqual(lines.slice(0, 3), ["worker sys:noisy: line 0", "worker sys:noisy: line 1", "worker sys:noisy: line 2"]);
  // a flood is cut off (a burst of 50, then about 5 a second), and the count is said once it stops
  assert.equal((await get(p, s, "/stderr?n=5000")).status, 200);
  assert.ok(await until(() => lines.some((l) => /^worker sys:noisy: \(\d+ lines left out\)$/.test(l)), 5000), lines.slice(-3).join("\n"));
  assert.ok(lines.length < 80, `${lines.length} lines logged`);
});

test("worker log: splits, cuts long lines, one budget for both streams, and says what it left out", async () => {
  let t = 0;
  const out: string[] = [];
  const wl = workerLog("k", (s) => out.push(s), { maxLine: 10, burst: 3, perSecond: 1, now: () => t, quietMs: 30 });
  const err = wl.stream();
  const std = wl.stream();
  err.write(Buffer.from("one\ntw"));
  err.write(Buffer.from("o\r\n"));
  assert.deepEqual(out, ["worker k: one", "worker k: two"]);
  t = 1000; // one more line allowed
  err.write(Buffer.from("x".repeat(25) + "\nafter\n")); // a long line is cut; what follows its end is a new line
  assert.deepEqual(out.slice(2), ["worker k: xxxxxxxxxx…", "worker k: after"]);
  // the budget is spent: stdout shares it, so nothing more until it fills again
  t = 2000; // one line
  out.length = 0;
  for (let i = 0; i < 4; i++) std.write(Buffer.from(`o${i}\n`));
  for (let i = 0; i < 4; i++) err.write(Buffer.from(`e${i}\n`));
  assert.deepEqual(out, ["worker k: o0"]);
  // the flood stops: the count is said
  await new Promise((r) => setTimeout(r, 200));
  assert.deepEqual(out, ["worker k: o0", "worker k: (7 lines left out)"]);
  // the count is also said before the next line that fits, and when a stream ends
  out.length = 0;
  err.write(Buffer.from("lost\n"));
  t = 3000;
  err.write(Buffer.from("next\n"));
  assert.deepEqual(out, ["worker k: (1 line left out)", "worker k: next"]);
  out.length = 0;
  err.write(Buffer.from("gone\n"));
  err.end();
  assert.deepEqual(out, ["worker k: (1 line left out)"]);
  // a line without an end is held only up to the limit
  t = 10_000;
  out.length = 0;
  std.write(Buffer.from("y".repeat(100)));
  std.write(Buffer.from("y".repeat(100)));
  std.end();
  assert.deepEqual(out, ["worker k: yyyyyyyyyy…"]);
  wl.flush();
});
