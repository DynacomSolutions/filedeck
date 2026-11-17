import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, workerConfig } from "../src/config.ts";
import { createWorkerApp, type WorkerInit } from "../src/worker.ts";
import { WorkerGone } from "../src/worker-proto.ts";
import { PoolFull, WorkerPool, lineLogger, startWorkerProcess, type StartWorker, type WorkerSpec } from "../src/worker-pool.ts";
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
  // stopped after 200 ms without use (checked every 200 ms); the margin is wide for a slow machine
  assert.ok(await until(() => !alive(pid), 3000), "the idle worker is still running");
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

test("no secrets", async () => {
  const saved = { a: process.env.FILEDECK_AGENT_TOKEN, v: process.env.FILEDECK_VAULT_KEY };
  process.env.FILEDECK_AGENT_TOKEN = "t0k3n";
  process.env.FILEDECK_VAULT_KEY = "v4ult";
  try {
    const p = pool();
    const s = spec("sys:secrets", { FILEDECK_AGENT_TOKEN: "t0k3n", FILEDECK_VAULT_KEY: "v4ult" });
    await ok(await stat(p, s));
    const pid = pidOf(p, "sys:secrets");
    const environ = fs.readFileSync(`/proc/${pid}/environ`, "utf8");
    const cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8");
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
  // a flood is cut off
  assert.equal((await get(p, s, "/stderr?n=5000")).status, 200);
  await new Promise((r) => setTimeout(r, 500));
  assert.ok(lines.length < 500, `${lines.length} lines logged`);
});

test("line logger: splits, cuts long lines and limits the rate", () => {
  let t = 0;
  const out: string[] = [];
  const l = lineLogger("k", (s) => out.push(s), { maxLine: 10, perSecond: 3, now: () => t });
  l.write(Buffer.from("one\ntw"));
  l.write(Buffer.from("o\r\n"));
  assert.deepEqual(out, ["worker k: one", "worker k: two"]);
  t = 1000;
  l.write(Buffer.from("x".repeat(25) + "\nafter\n")); // a long line is cut; what follows its end is a new line
  assert.deepEqual(out.slice(2), ["worker k: xxxxxxxxxx…", "worker k: after"]);
  // the rate: 3 lines per second, the rest counted and said once the next second starts
  t = 2000;
  out.length = 0;
  for (let i = 0; i < 10; i++) l.write(Buffer.from(`l${i}\n`));
  assert.deepEqual(out, ["worker k: l0", "worker k: l1", "worker k: l2"]);
  t = 3000;
  l.write(Buffer.from("next\n"));
  assert.deepEqual(out.slice(3), ["worker k: (7 lines left out)", "worker k: next"]);
  // a line without an end is held only up to the limit
  t = 4000;
  out.length = 0;
  l.write(Buffer.from("y".repeat(100)));
  l.write(Buffer.from("y".repeat(100)));
  l.end();
  assert.deepEqual(out, ["worker k: yyyyyyyyyy…"]);
});
