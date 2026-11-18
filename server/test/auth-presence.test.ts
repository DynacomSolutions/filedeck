import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import { createAgent } from "../src/agent.ts";
import { createHub } from "../src/hub.ts";
import { loadConfig } from "../src/config.ts";
import { HostPam } from "../src/host-pam.ts";
import { canUseNode } from "../src/agent-auth.ts";
import { USER_HEADER, type Identity } from "../src/auth/identity.ts";
import { SysPresence } from "../src/auth/presence.ts";
import type { LocalAccount } from "../src/local-accounts.ts";
import { fakeResolver, privateTmpdir } from "./worker-env.ts";

/**
 * work-item: a system user sees only the machines where the account exists. The hub asks each agent's lookup (agent token only), keeps
 * the answers per name for a while, and every place the hub decides access (`mayUse`) hides a machine whose answer is no.
 */
const T = "agent-secret-auth-presence";
const PW = "correct horse battery staple";
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "filedeck-presence-")));
fs.writeFileSync(path.join(tmp, "index.html"), "<!doctype html><title>t</title>");
const dropTmp = privateTmpdir();

type Server = ReturnType<typeof serve>;
const servers: Server[] = [];
const closers: { close(): Promise<void> }[] = [];
after(async () => {
  for (const h of closers) await h.close().catch(() => {});
  for (const s of servers) {
    s.close();
    (s as unknown as { closeAllConnections?(): void }).closeAllConnections?.();
  }
  fs.rmSync(tmp, { recursive: true, force: true });
  dropTmp();
});

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---- the cache on its own ----

/** A check that answers from a table and counts its calls; `hold` keeps every answer back until `release`. */
function table(t: Record<string, Record<string, boolean | undefined | "throw">>) {
  const calls: string[] = [];
  let gate: Promise<void> = Promise.resolve();
  let open = () => {};
  return {
    calls,
    hold() {
      gate = new Promise((r) => (open = r));
    },
    release: () => open(),
    check: async (node: string, name: string): Promise<boolean | undefined> => {
      calls.push(`${node}:${name}`);
      await gate;
      const v = t[name]?.[node];
      if (v === "throw") throw new Error("down");
      return v;
    },
  };
}

test("presence: answers kept per name and node; undefined and errors are not stored", async () => {
  const c = table({ alice: { a: true, b: false, c: undefined, d: "throw" } });
  const p = new SysPresence({ check: c.check, nodes: ["a", "b", "c", "d"] });
  assert.equal(p.known("alice", "a"), undefined);
  assert.equal(p.due("alice"), true);
  await p.refresh("alice");
  assert.deepEqual(c.calls.sort(), ["a:alice", "b:alice", "c:alice", "d:alice"]);
  assert.equal(p.known("alice", "a"), true);
  assert.equal(p.known("alice", "b"), false);
  assert.equal(p.known("alice", "c"), undefined);
  assert.equal(p.known("alice", "d"), undefined);
  assert.equal(p.known("bob", "a"), undefined);
  // a check that throws at once does not make refresh reject
  const bad = new SysPresence({
    check: () => {
      throw new Error("sync");
    },
    nodes: ["a"],
  });
  await bad.refresh("x");
  assert.equal(bad.known("x", "a"), undefined);
});

test("presence: one refresh per name at a time; callers share it", async () => {
  const c = table({ alice: { a: true, b: true }, bob: { a: false, b: true } });
  const p = new SysPresence({ check: c.check, nodes: ["a", "b"] });
  c.hold();
  const r1 = p.refresh("alice");
  const r2 = p.refresh("alice");
  const r3 = p.refresh("bob");
  assert.equal(p.due("alice"), true, "a running refresh is still due: callers wait for it");
  c.release();
  await Promise.all([r1, r2, r3]);
  assert.deepEqual(c.calls.sort(), ["a:alice", "a:bob", "b:alice", "b:bob"]);
  assert.equal(p.known("bob", "a"), false);
  assert.equal(p.due("alice"), false);
});

test("presence: a refresh with a time limit returns in time and keeps what came; late answers still land", async () => {
  let late: (v: boolean) => void = () => {};
  const p = new SysPresence({
    check: (node) => (node === "a" ? Promise.resolve(true) : new Promise<boolean>((r) => (late = r))),
    nodes: ["a", "b"],
  });
  const t0 = performance.now();
  await p.refresh("alice", 80);
  const ms = performance.now() - t0;
  assert.ok(ms >= 70 && ms < 600, `${ms} ms`);
  assert.equal(p.known("alice", "a"), true);
  assert.equal(p.known("alice", "b"), undefined);
  late(false);
  await wait(10);
  assert.equal(p.known("alice", "b"), false);
});

test("presence: asked again after ttlMs; a node with no answer is retried only after retryMs", async () => {
  let now = 1_000_000;
  const t = { alice: { a: true as boolean | undefined, b: undefined as boolean | undefined } };
  const c = table(t);
  const p = new SysPresence({ check: c.check, nodes: ["a", "b"], ttlMs: 300_000, retryMs: 10_000, now: () => now });
  await p.refresh("alice");
  assert.equal(c.calls.length, 2);
  // b gave no answer: not asked again at once
  now += 5_000;
  assert.equal(p.due("alice"), false);
  now += 6_000;
  assert.equal(p.due("alice"), true);
  t.alice.b = true;
  await p.refresh("alice");
  assert.equal(p.known("alice", "b"), true);
  assert.equal(p.due("alice"), false);
  now += 299_000;
  assert.equal(p.due("alice"), false);
  now += 2_000;
  assert.equal(p.due("alice"), true);
  // the last answer stays until a new one comes
  t.alice.a = undefined;
  assert.equal(p.known("alice", "a"), true);
  await p.refresh("alice");
  assert.equal(p.known("alice", "a"), true);
  assert.equal(c.calls.length, 6);
});

test("presence: at most maxNames names; the oldest is dropped", async () => {
  const c = table({ n1: { a: false }, n2: { a: false }, n3: { a: false }, n4: { a: false } });
  const p = new SysPresence({ check: c.check, nodes: ["a"], maxNames: 3 });
  assert.equal(new SysPresence({ check: c.check, nodes: [] }).maxNames, 4096);
  for (const n of ["n1", "n2", "n3"]) await p.refresh(n);
  await p.refresh("n1"); // asked again: newest now
  await p.refresh("n4");
  assert.equal(p.known("n2", "a"), undefined, "the oldest name is dropped");
  for (const n of ["n1", "n3", "n4"]) assert.equal(p.known(n, "a"), false, n);
});

test("presence: a name dropped while its refresh runs gets its answers back", async () => {
  let open = () => {};
  const gate = new Promise<void>((r) => (open = r));
  const answers: Record<string, boolean> = { n1: false, n2: true, n3: true };
  // n1's ask is held; the others answer at once
  const p = new SysPresence({ check: async (_node, name) => (name === "n1" && (await gate), answers[name]), nodes: ["a"], maxNames: 1 });
  const r1 = p.refresh("n1");
  await p.refresh("n2"); // n1 is dropped from the full cache while its ask runs
  assert.equal(p.known("n2", "a"), true);
  open();
  await r1;
  assert.equal(p.known("n1", "a"), false, "n1 is put back with its answer");
  assert.equal(p.known("n2", "a"), undefined, "still at most maxNames names");
  await p.refresh("n3");
  assert.equal(p.known("n3", "a"), true);
  assert.equal(p.known("n1", "a"), undefined);
});

test("canUseNode: a system account is refused only where the presence says no", () => {
  const sys: Identity = { kind: "sys", name: "alice", admin: false, epoch: 0 };
  const present = (_n: string, node: string) => ({ a: true, b: false } as Record<string, boolean | undefined>)[node];
  assert.equal(canUseNode(sys, "a", present), true);
  assert.equal(canUseNode(sys, "b", present), false);
  assert.equal(canUseNode(sys, "c", present), true, "unknown keeps today's behaviour");
  assert.equal(canUseNode(sys, "b"), true);
  assert.equal(canUseNode(undefined, "b", present), true);
});

// ---- through a real hub and real agents ----

interface Rec {
  node: string;
  path: string;
  headers: Record<string, string>;
  body: string;
}
const seen: Rec[] = [];
const lookups = (node?: string) => seen.filter((r) => r.path === "/api/auth/lookup" && (!node || r.node === node));
/** Requests other than the lookups, the sign-in calls and the open probes. */
const work = (node: string) => seen.filter((r) => r.node === node && !r.path.startsWith("/api/auth/") && r.path !== "/healthz");

interface FakeAgent {
  url: string;
  /** when set, the lookup is held until this promise ends */
  holdLookup?: Promise<void>;
}

async function agent(node: string, accounts: Record<string, Partial<LocalAccount>>): Promise<FakeAgent> {
  const root = path.join(tmp, `agent-${node}`);
  fs.mkdirSync(root);
  const resolver = fakeResolver(accounts);
  const pam = new HostPam({ run: async (_name, stdin) => ({ code: stdin.toString() === PW ? 0 : 1 }), log: () => {} });
  const app = createAgent(loadConfig({ FILEDECK_ROOT: root, FILEDECK_NODE: node, FILEDECK_AGENT_TOKEN: T, FILEDECK_AUTH: "on" } as never), () => {}, { accounts: resolver, pam });
  closers.push(app as unknown as { close(): Promise<void> });
  const a: FakeAgent = { url: "" };
  const srv = await new Promise<Server>((res) => {
    const s: Server = serve(
      {
        fetch: async (req: Request, env: unknown) => {
          const headers: Record<string, string> = {};
          req.headers.forEach((v, k) => (headers[k] = v));
          const p = new URL(req.url).pathname;
          seen.push({ node, path: p, headers, body: await req.clone().text() });
          if (p === "/api/auth/lookup" && a.holdLookup) await a.holdLookup;
          return app.fetch(req, env as never);
        },
        port: 0,
      },
      () => res(s),
    );
  });
  servers.push(srv);
  a.url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  return a;
}

async function deadUrl(): Promise<string> {
  const s = net.createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const port = (s.address() as AddressInfo).port;
  await new Promise<void>((r) => s.close(() => r()));
  return `http://127.0.0.1:${port}`;
}

// alice: only on a. zed: an ordinary account on a, uid 0 on b (b's lookup answers refused). bob: on both.
const A = await agent("a", { alice: {}, zed: {}, bob: {} });
const B = await agent("b", { zed: { uid: 0 }, bob: {} });

type Hub = ReturnType<typeof createHub>;
function makeHub(nodes: string, env: Record<string, string> = {}, now?: () => number, nodesWaitMs?: number): Hub {
  const h = createHub(
    loadConfig({ FILEDECK_MODE: "hub", FILEDECK_AUTH: "on", FILEDECK_AGENT_TOKEN: T, FILEDECK_STATIC: tmp, NODES: nodes, FILEDECK_DIFF_DIR: path.join(tmp, `diff-${closers.length}`), ...env } as never),
    undefined,
    () => {},
    { now, nodesWaitMs },
  );
  closers.push(h);
  return h;
}
const peer = { incoming: { socket: { remoteAddress: "127.0.0.1", encrypted: false } } };
const req = (h: Hub, p: string, init: RequestInit = {}) => h.request("http://localhost" + p, init, peer as never);
const postJson = (h: Hub, p: string, body: unknown, headers: Record<string, string> = {}) =>
  req(h, p, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

async function signIn(h: Hub, name: string, extra: Record<string, string> = {}): Promise<string> {
  const r = await postJson(h, "/api/auth/login", { name, password: PW }, extra);
  assert.equal(r.status, 200, `sign-in ${name}`);
  return (r.headers.get("set-cookie") ?? "").split(";")[0] as string;
}
const nodesOf = async (h: Hub, cookie: string) => {
  const r = await req(h, "/api/nodes", { headers: { cookie } });
  assert.equal(r.status, 200);
  return ((await r.json()) as { nodes: { name: string; online: boolean }[] }).nodes;
};

test("alice exists on a only: b is hidden from /api/nodes and refused everywhere, and b gets nothing", async () => {
  const h = makeHub(`a=${A.url},b=${B.url}`);
  seen.length = 0;
  const cookie = await signIn(h, "alice");
  assert.deepEqual(
    (await nodesOf(h, cookie)).map((n) => n.name),
    ["a"],
  );
  // the sign-in started the refresh and /api/nodes shared it: one lookup per node
  assert.equal(lookups("a").length, 1);
  assert.equal(lookups("b").length, 1);
  const deny = async (r: Response, what: string) => {
    assert.equal(r.status, 403, what);
    assert.deepEqual(await r.json(), { error: "no access to this machine" }, what);
  };
  const H = { cookie };
  await deny(await req(h, "/api/nodes/b/api/fs/list?path=/", { headers: H }), "proxy");
  await deny(await postJson(h, "/api/transfer", { src: { node: "a", path: "/x" }, dst: { node: "b", dir: "/" } }, H), "transfer to b");
  await deny(await postJson(h, "/api/transfer", { src: { node: "b", path: "/x" }, dst: { node: "a", dir: "/" } }, H), "transfer from b");
  await deny(await postJson(h, "/api/ops/jobs", { op: "copy", items: [{ node: "a", path: "/x" }], dst: { node: "b", dir: "/" } }, H), "ops to b");
  await deny(await postJson(h, "/api/ops/jobs", { op: "trash", items: [{ node: "b", path: "/x" }] }, H), "ops on b");
  await deny(await postJson(h, "/api/diff/jobs", { left: { node: "a", path: "/" }, right: { node: "b", path: "/" } }, H), "diff");
  await deny(await postJson(h, "/api/vault/forget", { node: "b", path: "/x" }, H), "vault");
  assert.deepEqual(work("b"), [], "nothing is sent to b");
  // a is still usable: the hub passes the request on (what a then answers depends on the test account's rights, e.g. 403 from a worker
  // that cannot read the test folder when the suite runs as root), and the answer is not the hub's own refusal
  const sentToA = work("a").length;
  const ra = await req(h, "/api/nodes/a/api/fs/list?path=/", { headers: H });
  assert.equal(work("a").length, sentToA + 1, "the request reached a");
  assert.notDeepEqual(await ra.json().catch(() => null), { error: "no access to this machine" });
  // bob exists on both and sees both
  const bob = await signIn(h, "bob");
  assert.deepEqual(
    (await nodesOf(h, bob)).map((n) => n.name),
    ["a", "b"],
  );
});

test("refused (uid 0 on b) hides b like a name that is not there", async () => {
  const h = makeHub(`a=${A.url},b=${B.url}`, { FILEDECK_AUTH_NODES: "a,b" });
  seen.length = 0;
  const cookie = await signIn(h, "zed");
  assert.deepEqual(
    (await nodesOf(h, cookie)).map((n) => n.name),
    ["a"],
  );
  const r = await req(h, "/api/nodes/b/api/fs/list?path=/", { headers: { cookie } });
  assert.equal(r.status, 403);
  assert.deepEqual(work("b"), []);
});

test("b down: b is listed (unknown) and a request to it gives 502 as today", async () => {
  const dead = await deadUrl();
  const h = makeHub(`a=${A.url},b=${dead}`);
  const cookie = await signIn(h, "alice");
  const nodes = await nodesOf(h, cookie);
  assert.deepEqual(nodes, [
    { name: "a", online: true },
    { name: "b", online: false },
  ]);
  const r = await req(h, "/api/nodes/b/api/fs/list?path=/", { headers: { cookie } });
  assert.equal(r.status, 502);
});

test("the presence is asked again after the ttl (injected clock)", async () => {
  let now = Date.now();
  const h = makeHub(`a=${A.url},b=${B.url}`, {}, () => now);
  const cookie = await signIn(h, "alice");
  await nodesOf(h, cookie);
  seen.length = 0;
  await nodesOf(h, cookie);
  assert.equal(lookups().length, 0, "fresh: not asked");
  now += 300_001;
  assert.deepEqual(
    (await nodesOf(h, cookie)).map((n) => n.name),
    ["a"],
  );
  assert.equal(lookups("a").length, 1);
  assert.equal(lookups("b").length, 1);
});

test("the lookups carry the agent token only: no cookie, no client header, no user", async () => {
  const h = makeHub(`a=${A.url},b=${B.url}`);
  seen.length = 0;
  const extra = { "x-forwarded-for": "203.0.113.9", "x-custom": "client-value", [USER_HEADER]: "forged", authorization: "Bearer client" };
  const cookie = await signIn(h, "alice", extra);
  await req(h, "/api/nodes", { headers: { cookie, ...extra } });
  const ls = lookups();
  assert.equal(ls.length, 2);
  for (const l of ls) {
    assert.equal(l.headers.authorization, `Bearer ${T}`);
    assert.equal(l.headers[USER_HEADER], undefined);
    assert.equal(l.headers.cookie, undefined);
    assert.equal(l.headers["x-filedeck-client"], undefined);
    for (const v of Object.values(l.headers)) assert.ok(!v.includes("client-value") && !v.includes("203.0.113.9") && !v.includes("forged"), v);
    assert.deepEqual(JSON.parse(l.body), { name: "alice" });
  }
});

test("sign-in does not wait for the presence; /api/nodes waits at most 2 s; virtual accounts are not looked up", async () => {
  let open = () => {};
  B.holdLookup = new Promise<void>((r) => (open = r));
  try {
    const h = makeHub(`a=${A.url},b=${B.url}`, {}, undefined, 300);
    const t0 = performance.now();
    const cookie = await signIn(h, "alice");
    const ms = performance.now() - t0;
    assert.ok(ms < 1500, `sign-in took ${ms} ms`);
    const t1 = performance.now();
    const names = (await nodesOf(h, cookie)).map((n) => n.name);
    const ns = performance.now() - t1;
    assert.ok(ns >= 250 && ns < 1500, `/api/nodes took ${ns} ms (it waits 300 ms here, 2 s by default)`);
    assert.deepEqual(names, ["a", "b"], "b gave no answer in time: unknown, listed");
  } finally {
    open();
    B.holdLookup = undefined;
  }
  // a virtual account: no lookup at all
  const h = makeHub(`a=${A.url},b=${B.url}`);
  const acc = h.auth?.accounts;
  assert.ok(acc);
  acc.create({ name: "vic", password: PW, admin: false, nodes: { a: { runAs: "guest", grants: [{ path: "/", write: true }] } } });
  seen.length = 0;
  const cookie = await signIn(h, "vic");
  await req(h, "/api/nodes", { headers: { cookie } });
  assert.deepEqual(lookups(), []);
});

test("a name that is not a machine answers 403 like a hidden one (no 404 to tell them apart); 404 with auth off", async () => {
  const h = makeHub(`a=${A.url},b=${B.url}`);
  const cookie = await signIn(h, "alice");
  await nodesOf(h, cookie);
  const H = { cookie };
  const deny = async (r: Response, what: string) => {
    assert.equal(r.status, 403, what);
    assert.deepEqual(await r.json(), { error: "no access to this machine" }, what);
  };
  for (const node of ["nosuch", "b"]) {
    await deny(await req(h, `/api/nodes/${node}/api/fs/list?path=/`, { headers: H }), `proxy ${node}`);
    await deny(await postJson(h, "/api/transfer", { src: { node: "a", path: "/x" }, dst: { node, dir: "/" } }, H), `transfer ${node}`);
    await deny(await postJson(h, "/api/ops/jobs", { op: "copy", items: [{ node: "a", path: "/x" }], dst: { node, dir: "/" } }, H), `ops ${node}`);
    await deny(await postJson(h, "/api/diff/jobs", { left: { node: "a", path: "/" }, right: { node, path: "/" } }, H), `diff ${node}`);
  }
  const off = createHub(loadConfig({ FILEDECK_MODE: "hub", FILEDECK_STATIC: tmp, NODES: `a=${A.url}` } as never), undefined, () => {});
  closers.push(off);
  assert.equal((await req(off, "/api/nodes/nosuch/api/fs/list?path=/")).status, 404);
  assert.equal((await postJson(off, "/api/transfer", { src: { node: "a", path: "/x" }, dst: { node: "nosuch", dir: "/" } })).status, 404);
  assert.equal((await postJson(off, "/api/ops/jobs", { op: "copy", items: [{ node: "a", path: "/x" }], dst: { node: "nosuch", dir: "/" } })).status, 404);
});

test("auth off: nothing changes (both listed, no lookup)", async () => {
  const h = createHub(loadConfig({ FILEDECK_MODE: "hub", FILEDECK_STATIC: tmp, NODES: `a=${A.url},b=${B.url}` } as never), undefined, () => {});
  closers.push(h);
  seen.length = 0;
  const r = await req(h, "/api/nodes");
  assert.deepEqual(
    ((await r.json()) as { nodes: { name: string }[] }).nodes.map((n) => n.name),
    ["a", "b"],
  );
  assert.deepEqual(lookups(), []);
});
