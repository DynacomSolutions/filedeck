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
import { isRootRoute, workerGate, workerKey } from "../src/agent-workers.ts";
import { PoolFull, type StartWorker, type WorkerPool, type WorkerSpec } from "../src/worker-pool.ts";
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
    async stopAccount(kind: string, name: string) {
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
