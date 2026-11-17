import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import { createAgent } from "../src/agent.ts";
import { createHub } from "../src/hub.ts";
import { loadConfig } from "../src/config.ts";
import { USER_HEADER, verifyClaim, type NodeAccess, type UserClaim } from "../src/auth/identity.ts";
import { withAgentToken, canUseNode, NoAccessError } from "../src/agent-auth.ts";
import { runAs } from "../src/auth/context.ts";
import { ownerFrom } from "../src/auth/job-owner.ts";

const T = "agent-secret-forwarding";
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "filedeck-authfwd-")));
fs.writeFileSync(path.join(tmp, "index.html"), "<!doctype html><title>t</title>");

type Server = ReturnType<typeof serve>;
const servers: Server[] = [];
const hubs: { close(): Promise<void> }[] = [];
after(async () => {
  for (const h of hubs) await h.close().catch(() => {});
  for (const s of servers) {
    s.close();
    (s as unknown as { closeAllConnections?(): void }).closeAllConnections?.();
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});

interface Rec {
  path: string;
  user: string | null;
  cookie: string | null;
  password: string | null;
}
interface Agent {
  root: string;
  url: string;
  recs: Rec[];
  /** runs before the agent answers, for slowing chosen requests down */
  hook?: (req: Request) => Promise<void>;
  /** answers in place of the agent when it returns a response */
  reply?: (req: Request) => Response | undefined;
}

/** A real agent behind a wrapper that records the user header of every request it gets. */
async function agent(node: string): Promise<Agent> {
  const root = path.join(tmp, `agent-${node}`);
  fs.mkdirSync(root);
  const app = createAgent(loadConfig({ FILEDECK_ROOT: root, FILEDECK_NODE: node, FILEDECK_AGENT_TOKEN: T } as never));
  const a: Agent = { root, url: "", recs: [] };
  const srv = await new Promise<Server>((res) => {
    const s: Server = serve(
      {
        fetch: async (req: Request, env: unknown) => {
          a.recs.push({ path: new URL(req.url).pathname, user: req.headers.get(USER_HEADER), cookie: req.headers.get("cookie"), password: req.headers.get("x-filedeck-password") });
          if (a.hook) await a.hook(req);
          const r = a.reply?.(req);
          if (r) return r;
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

const A = await agent("A");
const B = await agent("B");

const ACCESS_A: Record<string, NodeAccess> = { A: { runAs: "guest", grants: [{ path: "/", write: true }] } };

type Hub = ReturnType<typeof createHub>;
function makeHub(env: Record<string, string> = {}): Hub {
  const h = createHub(loadConfig({ FILEDECK_MODE: "hub", FILEDECK_AUTH: "on", FILEDECK_AGENT_TOKEN: T, FILEDECK_STATIC: tmp, NODES: `A=${A.url},B=${B.url}`, FILEDECK_DIFF_DIR: path.join(tmp, `diff-${hubs.length}`), ...env } as never), undefined, () => {});
  hubs.push(h);
  return h;
}

/** A session cookie for a virtual account, made straight in the store. */
function signIn(h: Hub, name: string, nodes: Record<string, NodeAccess> = ACCESS_A, admin = false): string {
  if (!h.auth!.accounts.get(name)) h.auth!.accounts.create({ name, password: `pw-${name}-123`, admin, nodes });
  return `__Host-filedeck=${h.auth!.sessions.create("virt", name)}`;
}

const peer = { incoming: { socket: { remoteAddress: "127.0.0.1", encrypted: false } } };
const call = (h: Hub, p: string, cookie: string, init: RequestInit = {}) =>
  h.request("http://localhost" + p, { ...init, headers: { ...(init.body ? { "content-type": "application/json" } : {}), ...(init.headers as Record<string, string>), cookie } }, peer as never);
const postJson = (h: Hub, p: string, cookie: string, body: unknown) => call(h, p, cookie, { method: "POST", body: JSON.stringify(body) });

const claimOf = (r: Rec): UserClaim | null => (r.user ? verifyClaim(r.user, T, Date.now()) : null);
/** Requests other than the open probes, which carry no identity. */
const real = (recs: Rec[]) => recs.filter((r) => r.path !== "/healthz" && r.path !== "/metrics");

async function until<T>(fn: () => Promise<T>, ok: (v: T) => boolean, ms = 10_000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (ok(v)) return v;
    if (Date.now() - t0 > ms) assert.fail(`timeout: ${JSON.stringify(v)}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

const hub = makeHub();

test("header per node: a virtual account sees only its nodes, and the agent gets a signed claim for that node", async () => {
  const guest = signIn(hub, "guest1");
  const nodes = (await (await call(hub, "/api/nodes", guest)).json()) as { nodes: { name: string }[] };
  assert.deepEqual(
    nodes.nodes.map((n) => n.name),
    ["A"],
  );
  A.recs.length = 0;
  const r = await call(hub, "/api/nodes/A/api/fs/stat?path=/", guest);
  assert.equal(r.status, 200);
  const got = real(A.recs);
  assert.equal(got.length, 1);
  const c = claimOf(got[0]!);
  assert.ok(c, "the agent gets a header that verifies");
  assert.equal(c.kind, "virt");
  assert.equal(c.name, "guest1");
  assert.equal(c.runAs, "guest");
  assert.deepEqual(c.grants, [{ path: "/", write: true }]);
});

test("no grant, no forwarding: the proxy, transfer, ops and diff refuse a node without access", async () => {
  const guest = signIn(hub, "guest1");
  fs.writeFileSync(path.join(A.root, "nogrant.txt"), "x");
  B.recs.length = 0;
  const want = { error: "no access to this machine" };
  const p = await call(hub, "/api/nodes/B/api/fs/stat?path=/", guest);
  assert.equal(p.status, 403);
  assert.deepEqual(await p.json(), want);
  const t = await postJson(hub, "/api/transfer", guest, { src: { node: "A", path: "/nogrant.txt" }, dst: { node: "B", dir: "/" }, op: "copy" });
  assert.equal(t.status, 403);
  assert.deepEqual(await t.json(), want);
  const t2 = await postJson(hub, "/api/transfer", guest, { src: { node: "B", path: "/x" }, dst: { node: "A", dir: "/" }, op: "copy" });
  assert.equal(t2.status, 403);
  const o = await postJson(hub, "/api/ops/jobs", guest, { op: "copy", items: [{ node: "A", path: "/nogrant.txt" }], dst: { node: "B", dir: "/" } });
  assert.equal(o.status, 403);
  assert.deepEqual(await o.json(), want);
  const o2 = await postJson(hub, "/api/ops/jobs", guest, { op: "trash", items: [{ node: "B", path: "/x" }] });
  assert.equal(o2.status, 403);
  const d = await postJson(hub, "/api/diff/jobs", guest, { left: { node: "A", path: "/" }, right: { node: "B", path: "/" } });
  assert.equal(d.status, 403);
  assert.deepEqual(await d.json(), want);
  assert.deepEqual(real(B.recs), [], "agent B got no request");
});

test("client copy dropped: a forged user header and the session cookie never reach the agent", async () => {
  const guest = signIn(hub, "guest1");
  A.recs.length = 0;
  const r = await call(hub, "/api/nodes/A/api/fs/stat?path=/", guest, { headers: { [USER_HEADER]: "forged" } });
  assert.equal(r.status, 200);
  const got = real(A.recs);
  assert.equal(got.length, 1);
  assert.notEqual(got[0]!.user, "forged");
  assert.equal(claimOf(got[0]!)?.name, "guest1");
  assert.equal(got[0]!.cookie, null, "the agent gets no cookie");
  // the vault path (a password route) and a transfer copy no client header either
  fs.writeFileSync(path.join(A.root, "ck.txt"), "x");
  A.recs.length = 0;
  await call(hub, "/api/nodes/A/api/archive/list?path=/ck.txt", guest);
  const t = await postJson(hub, "/api/transfer", guest, { src: { node: "A", path: "/ck.txt" }, dst: { node: "A", dir: "/ckdst" }, op: "copy" });
  assert.ok(t.status < 500);
  assert.ok(real(A.recs).length >= 2);
  for (const x of real(A.recs)) assert.equal(x.cookie, null, `${x.path} gets no cookie`);
});

test("job owner: every agent call of a job carries its owner, and other accounts do not see it", async () => {
  const guest = signIn(hub, "guest1");
  const other = signIn(hub, "guest2");
  const boss = signIn(hub, "boss", {}, true);
  fs.mkdirSync(path.join(A.root, "jsrc"));
  for (let i = 0; i < 3; i++) fs.writeFileSync(path.join(A.root, "jsrc", `f${i}.txt`), `file ${i}`);
  fs.mkdirSync(path.join(A.root, "jdst"));
  A.recs.length = 0;
  const res = await postJson(hub, "/api/ops/jobs", guest, { op: "copy", items: [{ node: "A", path: "/jsrc" }], dst: { node: "A", dir: "/jdst" }, conflict: "overwrite" });
  assert.equal(res.status, 202);
  const { id } = (await res.json()) as { id: string };
  // polled as an admin: the job must still run as its owner, never as whoever asks
  const v = await until(
    async () => (await (await call(hub, `/api/ops/jobs/${id}`, boss)).json()) as { state: string },
    (x) => ["done", "failed", "canceled"].includes(x.state),
  );
  assert.equal(v.state, "done");
  assert.equal(fs.readFileSync(path.join(A.root, "jdst/jsrc/f2.txt"), "utf8"), "file 2");
  const got = real(A.recs);
  assert.ok(got.length >= 4, `the job called the agent (${got.length} calls)`);
  for (const r of got) assert.equal(claimOf(r)?.name, "guest1", `${r.path} carries the owner`);
  const listed = (await (await call(hub, "/api/ops/jobs", other)).json()) as { jobs: { id: string }[] };
  assert.ok(!listed.jobs.some((j) => j.id === id), "another account does not see the job");
  assert.equal((await call(hub, `/api/ops/jobs/${id}`, other)).status, 404);
  assert.equal((await call(hub, `/api/ops/jobs/${id}/cancel`, other, { method: "POST" })).status, 404);
  assert.equal((await call(hub, `/api/ops/jobs/${id}`, other, { method: "DELETE" })).status, 404);
  const mine = (await (await call(hub, "/api/ops/jobs", guest)).json()) as { jobs: { id: string }[] };
  assert.ok(mine.jobs.some((j) => j.id === id), "the owner sees it");
  const all = (await (await call(hub, "/api/ops/jobs", boss)).json()) as { jobs: { id: string }[] };
  assert.ok(all.jobs.some((j) => j.id === id), "an admin sees it");
});

test("diff job owner: the compare runs as its owner and is listed only to it and admins", async () => {
  const guest = signIn(hub, "guest1");
  const other = signIn(hub, "guest2");
  fs.mkdirSync(path.join(A.root, "dl/s"), { recursive: true });
  fs.writeFileSync(path.join(A.root, "dl/s/x.txt"), "left");
  fs.mkdirSync(path.join(A.root, "dr/s"), { recursive: true });
  fs.writeFileSync(path.join(A.root, "dr/s/x.txt"), "right");
  A.recs.length = 0;
  const res = await postJson(hub, "/api/diff/jobs", guest, { left: { node: "A", path: "/dl" }, right: { node: "A", path: "/dr" }, options: {} });
  assert.equal(res.status, 202);
  const { id } = (await res.json()) as { id: string };
  const v = await until(
    async () => (await (await call(hub, `/api/diff/jobs/${id}`, guest)).json()) as { state: string },
    (x) => ["done", "failed", "canceled"].includes(x.state),
  );
  assert.equal(v.state, "done");
  const got = real(A.recs);
  assert.ok(got.length >= 2);
  for (const r of got) assert.equal(claimOf(r)?.name, "guest1", `${r.path} carries the owner`);
  const listed = (await (await call(hub, "/api/diff/jobs", other)).json()) as { jobs: { id: string }[] };
  assert.ok(!listed.jobs.some((j) => j.id === id));
  assert.equal((await call(hub, `/api/diff/jobs/${id}`, other)).status, 404);
  assert.equal((await call(hub, `/api/diff/jobs/${id}/rows?rel=`, other)).status, 404);
  await call(hub, `/api/diff/jobs/${id}`, guest, { method: "DELETE" });
});

test("resumed job keeps its owner: a job carried on by a new hub still runs as the account that started it", async () => {
  const jobsFile = path.join(tmp, "jobs.sqlite");
  const h1 = makeHub({ FILEDECK_JOBS_FILE: jobsFile });
  const guest = signIn(h1, "guest1");
  fs.mkdirSync(path.join(A.root, "rsrc"));
  for (let i = 0; i < 4; i++) fs.writeFileSync(path.join(A.root, "rsrc", `f${i}.txt`), `file ${i}`);
  fs.mkdirSync(path.join(A.root, "rdst"));
  let uploads = 0;
  let firstUpload!: () => void;
  const started = new Promise<void>((r) => (firstUpload = r));
  A.hook = async (req) => {
    if (new URL(req.url).pathname !== "/api/fs/copy") return;
    uploads++;
    firstUpload();
    await new Promise((r) => setTimeout(r, 150));
  };
  try {
    const items = [0, 1, 2, 3].map((i) => ({ node: "A", path: `/rsrc/f${i}.txt` }));
    const res = await postJson(h1, "/api/ops/jobs", guest, { op: "copy", items, dst: { node: "A", dir: "/rdst" }, conflict: "overwrite" });
    assert.equal(res.status, 202);
    const { id } = (await res.json()) as { id: string };
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([started, new Promise((_, rej) => (timer = setTimeout(() => rej(new Error("the job never reached a copy")), 10_000)))]).finally(() => clearTimeout(timer));
    await h1.close(); // stops at the next item boundary and hands the job over
    hubs.splice(hubs.indexOf(h1), 1);
    assert.ok(uploads < 4, "the job was stopped mid-way");
    A.recs.length = 0;
    // the new hub knows guest1 with other grants: the job must still carry the claim it started with
    const h2 = makeHub({ FILEDECK_JOBS_FILE: jobsFile });
    signIn(h2, "guest1", { A: { runAs: "guest", grants: [{ path: "/elsewhere", write: false }] } });
    const boss = signIn(h2, "boss", {}, true);
    const v = await until(
      async () => (await (await call(h2, `/api/ops/jobs/${id}`, boss)).json()) as { state: string },
      (x) => ["done", "failed", "canceled"].includes(x.state),
      15_000,
    );
    assert.equal(v.state, "done");
    const got = real(A.recs).filter((r) => r.path.startsWith("/api/fs/"));
    assert.ok(got.some((r) => r.path === "/api/fs/copy"), "the new hub carried on the copy");
    for (const r of got) {
      const c = claimOf(r);
      assert.equal(c?.name, "guest1", `${r.path} carries the original owner`);
      assert.deepEqual(c?.grants, [{ path: "/", write: true }], "the stored identity, not the current one");
    }
  } finally {
    A.hook = undefined;
  }
});

test("hidden node names: a node without access and a node that does not exist get the same 403; auth off keeps 404", async () => {
  const guest = signIn(hub, "guest1");
  fs.writeFileSync(path.join(A.root, "hidden.txt"), "x");
  const want = { error: "no access to this machine" };
  for (const node of ["B", "nosuch"]) {
    const p = await call(hub, `/api/nodes/${node}/api/fs/stat?path=/`, guest);
    assert.equal(p.status, 403, `proxy ${node}`);
    assert.deepEqual(await p.json(), want);
    const t = await postJson(hub, "/api/transfer", guest, { src: { node: "A", path: "/hidden.txt" }, dst: { node, dir: "/" }, op: "copy" });
    assert.equal(t.status, 403, `transfer to ${node}`);
    assert.deepEqual(await t.json(), want);
    const t2 = await postJson(hub, "/api/transfer", guest, { src: { node, path: "/x" }, dst: { node: "A", dir: "/" }, op: "copy" });
    assert.equal(t2.status, 403, `transfer from ${node}`);
    const o = await postJson(hub, "/api/ops/jobs", guest, { op: "trash", items: [{ node, path: "/x" }] });
    assert.equal(o.status, 403, `ops ${node}`);
    assert.deepEqual(await o.json(), want);
    const d = await postJson(hub, "/api/diff/jobs", guest, { left: { node: "A", path: "/" }, right: { node, path: "/" } });
    assert.equal(d.status, 403, `diff ${node}`);
    assert.deepEqual(await d.json(), want);
  }
  const off = makeHub({ FILEDECK_AUTH: "off" });
  const u = await off.request("http://localhost/api/nodes/nosuch/api/fs/stat?path=/", {}, peer as never);
  assert.equal(u.status, 404, "auth off: an unknown node is still 404");
  const ut = await off.request("http://localhost/api/transfer", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ src: { node: "A", path: "/hidden.txt" }, dst: { node: "nosuch", dir: "/" } }) }, peer as never);
  assert.equal(ut.status, 404);
});

test("vault per account: each account lists, forgets and uses only its own saved passwords", async () => {
  const h = makeHub();
  const one = signIn(h, "vone");
  const two = signIn(h, "vtwo");
  const boss = signIn(h, "vboss", ACCESS_A, true);
  const v = h.vault;
  const e1 = v.put("A", "/v/x.pdf", "pw-one", { owner: "virt:vone" });
  const e2 = v.put("A", "/v/x.pdf", "pw-two", { owner: "virt:vtwo" });
  v.put("A", "/v/x.pdf", "pw-nobody"); // saved with auth off
  v.put("A", "/v/y.pdf", "pw-nobody");
  type List = { entries: { id: string }[] };
  const list = async (ck: string) => ((await (await call(h, "/api/vault", ck)).json()) as List).entries.map((e) => e.id);
  assert.deepEqual(await list(one), [e1.id]);
  assert.deepEqual(await list(two), [e2.id]);
  assert.deepEqual(await list(boss), [], "an admin sees no one else's passwords");
  const b64 = (x: string) => Buffer.from(x).toString("base64");
  // the proxy hands the agent the caller's own password, and nobody's ownerless one
  for (const [ck, want] of [[one, b64("pw-one")], [two, b64("pw-two")], [boss, null]] as const) {
    A.recs.length = 0;
    await call(h, "/api/nodes/A/api/pdf/status?path=/v/x.pdf", ck);
    const got = real(A.recs).filter((r) => r.path === "/api/pdf/status");
    assert.equal(got.length >= 1, true);
    assert.equal(got[0]!.password, want);
  }
  A.recs.length = 0;
  await call(h, "/api/nodes/A/api/pdf/status?path=/v/y.pdf", one);
  assert.deepEqual(real(A.recs).filter((r) => r.path === "/api/pdf/status").map((r) => r.password), [null], "an ownerless entry is not used");
  // forgetting by id, by path or all touches only the caller's own
  assert.equal((await call(h, `/api/vault/${e1.id}`, two, { method: "DELETE" })).status, 404);
  assert.equal((await call(h, `/api/vault/${e1.id}/extend`, two, { method: "POST" })).status, 404);
  assert.equal(((await (await postJson(h, "/api/vault/forget", two, { node: "A", path: "/v" })).json()) as { removed: number }).removed, 1);
  assert.deepEqual(await list(one), [e1.id], "the other account's entry is still there");
  assert.equal(((await (await call(h, "/api/vault", boss, { method: "DELETE" })).json()) as { removed: number }).removed, 0);
  assert.deepEqual(await list(one), [e1.id]);
  assert.equal(((await (await call(h, "/api/vault", one, { method: "DELETE" })).json()) as { removed: number }).removed, 1);
  assert.equal(v.list().length, 2, "the ownerless entries are left alone");
});

test("vault per account: a password typed through the proxy is saved for the caller only", async () => {
  const h = makeHub();
  const one = signIn(h, "sone");
  signIn(h, "stwo");
  // the agent says the typed password was needed and right
  A.reply = (req) => (new URL(req.url).pathname === "/api/pdf/status" ? new Response("{}", { headers: { "content-type": "application/json", "x-filedeck-pw": "ok" } }) : undefined);
  try {
    const r = await call(h, "/api/nodes/A/api/pdf/status?path=/s/z.pdf", one, { headers: { "x-filedeck-password": Buffer.from("typed").toString("base64") } });
    assert.equal(r.status, 200);
  } finally {
    A.reply = undefined;
  }
  assert.equal(h.vault.list("virt:sone").length, 1, "saved for the caller");
  assert.equal(h.vault.list("virt:stwo").length, 0);
  assert.equal(h.vault.get("A", "/s/z.pdf", undefined, false, "virt:stwo"), undefined, "another account cannot use it");
  assert.equal(h.vault.get("A", "/s/z.pdf", undefined, false, "virt:sone")?.password, "typed");
});

test("vault: a hidden or unknown node in a vault route is refused like elsewhere", async () => {
  const h = makeHub();
  const guest = signIn(h, "vguest");
  const want = { error: "no access to this machine" };
  for (const node of ["B", "nosuch"]) {
    const r = await postJson(h, "/api/vault/forget", guest, { node, path: "/x" });
    assert.equal(r.status, 403, `forget on ${node}`);
    assert.deepEqual(await r.json(), want);
    const p = await call(h, `/api/nodes/${node}/api/pdf/status?path=/x.pdf`, guest);
    assert.equal(p.status, 403, `vault proxy on ${node}`);
    assert.deepEqual(await p.json(), want);
  }
  // an entry the account saved for a node it has since lost is not listed (the name stays hidden)
  h.vault.put("B", "/lost.pdf", "pw", { owner: "virt:vguest" });
  const listed = (await (await call(h, "/api/vault", guest)).json()) as { entries: { node: string }[] };
  assert.deepEqual(listed.entries.map((e) => e.node), []);
  const off = makeHub({ FILEDECK_AUTH: "off" });
  const u = await off.request("http://localhost/api/vault/forget", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ node: "nosuch", path: "/x" }) }, peer as never);
  assert.equal(u.status, 400, "auth off: unchanged");
});

test("ownerless job resumed with auth on: it fails with no identity and sends nothing to the agent", async () => {
  const jobsFile = path.join(tmp, "jobs-ownerless.sqlite");
  const h1 = makeHub({ FILEDECK_JOBS_FILE: jobsFile, FILEDECK_AUTH: "off" });
  fs.mkdirSync(path.join(A.root, "osrc"));
  for (let i = 0; i < 4; i++) fs.writeFileSync(path.join(A.root, "osrc", `f${i}.txt`), `file ${i}`);
  fs.mkdirSync(path.join(A.root, "odst"));
  let firstCopy!: () => void;
  const started = new Promise<void>((r) => (firstCopy = r));
  A.hook = async (req) => {
    if (new URL(req.url).pathname !== "/api/fs/copy") return;
    firstCopy();
    await new Promise((r) => setTimeout(r, 150));
  };
  try {
    const items = [0, 1, 2, 3].map((i) => ({ node: "A", path: `/osrc/f${i}.txt` }));
    const res = await h1.request("http://localhost/api/ops/jobs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ op: "copy", items, dst: { node: "A", dir: "/odst" }, conflict: "overwrite" }) }, peer as never);
    assert.equal(res.status, 202);
    const { id } = (await res.json()) as { id: string };
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([started, new Promise((_, rej) => (timer = setTimeout(() => rej(new Error("the job never reached a copy")), 10_000)))]).finally(() => clearTimeout(timer));
    await h1.close();
    hubs.splice(hubs.indexOf(h1), 1);
    A.recs.length = 0;
    const h2 = makeHub({ FILEDECK_JOBS_FILE: jobsFile });
    const boss = signIn(h2, "boss", {}, true);
    const v = await until(
      async () => (await (await call(h2, `/api/ops/jobs/${id}`, boss)).json()) as { state: string; error?: string; items?: { state: string; error?: string }[] },
      (x) => ["done", "failed", "canceled"].includes(x.state),
      15_000,
    );
    const errors = [v.error, ...(v.items ?? []).map((i) => i.error)];
    assert.ok(errors.includes("agent call without an identity"), `the job says why: ${JSON.stringify(v)}`);
    assert.ok(!(v.items ?? []).some((i, n) => n > 0 && i.state === "done"), "no item after the restart was carried out");
    assert.deepEqual(real(A.recs), [], "the agent got nothing from the new hub");
    const guest = signIn(h2, "guest1");
    assert.equal((await call(h2, `/api/ops/jobs/${id}`, guest)).status, 404, "an ownerless job is shown to admins only");
  } finally {
    A.hook = undefined;
  }
});

test("ownerFrom: only a well-formed stored identity reads back", () => {
  const virt = { kind: "virt", name: "g", admin: false, epoch: 1, nodes: ACCESS_A };
  assert.deepEqual(ownerFrom(JSON.stringify(virt)), virt);
  assert.deepEqual(ownerFrom(JSON.stringify({ kind: "sys", name: "alice", admin: true, epoch: 0 })), { kind: "sys", name: "alice", admin: true, epoch: 0 });
  assert.equal(ownerFrom(null), undefined);
  assert.equal(ownerFrom("not json"), undefined);
  assert.equal(ownerFrom(JSON.stringify({ ...virt, nodes: null })), undefined);
  assert.equal(ownerFrom(JSON.stringify({ ...virt, nodes: [] })), undefined);
  assert.equal(ownerFrom(JSON.stringify({ ...virt, nodes: "A" })), undefined);
  const { nodes: _n, ...noNodes } = virt;
  assert.equal(ownerFrom(JSON.stringify(noNodes)), undefined);
  assert.equal(ownerFrom(JSON.stringify({ kind: "root", name: "x", admin: true, epoch: 0 })), undefined);
  assert.equal(ownerFrom(JSON.stringify({ kind: "sys", name: 5, admin: true, epoch: 0 })), undefined);
  assert.equal(ownerFrom(JSON.stringify([virt])), undefined);
});

test("withAgentToken: no identity with auth on fails loudly; a node without access is refused", () => {
  assert.throws(() => withAgentToken(undefined, T, "A", true), /agent call without an identity/);
  assert.equal(withAgentToken(undefined, T, "A", false)?.headers instanceof Headers, true);
  const guest = { kind: "virt" as const, name: "g", admin: false, epoch: 1, nodes: ACCESS_A };
  assert.throws(() => runAs(guest, () => withAgentToken(undefined, T, "B", true)), NoAccessError);
  const h = runAs(guest, () => withAgentToken({ headers: { [USER_HEADER]: "forged" } }, T, "A", true))!.headers as Headers;
  assert.equal(verifyClaim(h.get(USER_HEADER)!, T, Date.now())?.name, "g");
  // auth off and no token: the request is left as it was
  const init = { method: "GET" };
  assert.equal(withAgentToken(init, undefined, "A"), init);
});

test("canUseNode: system accounts everywhere, virtual ones only where they have access", () => {
  assert.equal(canUseNode({ kind: "sys", name: "alice", admin: false, epoch: 0 }, "B"), true);
  const guest = { kind: "virt" as const, name: "g", admin: false, epoch: 1, nodes: ACCESS_A };
  assert.equal(canUseNode(guest, "A"), true);
  assert.equal(canUseNode(guest, "B"), false);
  assert.equal(canUseNode(guest, "constructor"), false);
});
