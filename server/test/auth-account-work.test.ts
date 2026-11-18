import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { createHub, type Target } from "../src/hub.ts";
import { loadConfig } from "../src/config.ts";
import { OpQueue } from "../src/ops-queue.ts";
import { JobStore } from "../src/job-store.ts";
import { cancelAgentJobs } from "../src/auth/account-work.ts";
import { USER_HEADER, verifyClaim, type Identity, type NodeAccess, type UserClaim } from "../src/auth/identity.ts";

/**
 * A changed account loses its sessions, streams and jobs (part 3, Task 3). `accountChanged` raises the epoch (sessions and streams end),
 * cancels the account's hub jobs and compares (also a row another hub holds in the shared store), and asks each machine, as the account
 * at its new epoch, to cancel its live jobs there. A machine that does not answer holds it up for at most about 3 s.
 */

const T = "agent-secret-account-work";
let tmp = "";

interface Rec {
  method: string;
  path: string;
  claim: UserClaim | null;
}
/** A fake agent: it records every request with its claim, lists `jobs`, cancels, serves a change feed, and hangs on paths under /slow. */
interface Fake {
  url: string;
  recs: Rec[];
  jobs: { id: string; state: string }[];
  /** when set, the job list and every cancel answer with this status */
  status?: number;
}
const servers: http.Server[] = [];
const hubs: { close(): Promise<void> }[] = [];

before(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "filedeck-acctwork-")));
  fs.writeFileSync(path.join(tmp, "index.html"), "<!doctype html><title>t</title>");
});
after(async () => {
  for (const h of hubs) await h.close().catch(() => {});
  for (const s of servers) {
    s.close();
    s.closeAllConnections();
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function listen(srv: http.Server): Promise<string> {
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  servers.push(srv);
  return `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
}

async function fakeAgent(): Promise<Fake> {
  const f: Fake = { url: "", recs: [], jobs: [] };
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url ?? "/", "http://x");
    const v = req.headers[USER_HEADER];
    f.recs.push({ method: req.method ?? "GET", path: u.pathname, claim: typeof v === "string" ? verifyClaim(v, T, Date.now()) : null });
    // a request about a path under /slow never answers (a job or compare stays running until the hub cuts it off)
    if ((u.searchParams.get("path") ?? "").startsWith("/slow")) return;
    if (u.pathname === "/api/events") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
      res.write(": open\n\n");
      return;
    }
    res.setHeader("content-type", "application/json");
    const m = /^\/api\/jobs\/([^/]+)\/cancel$/.exec(u.pathname);
    if (f.status && (u.pathname === "/api/jobs" || m)) {
      res.statusCode = f.status;
      return void res.end(JSON.stringify({ error: "broken" }));
    }
    if (u.pathname === "/api/jobs") return void res.end(JSON.stringify({ jobs: f.jobs }));
    if (m && req.method === "POST") return void res.end(JSON.stringify({ id: decodeURIComponent(m[1]!), state: "canceled" }));
    // a compare of empty folders finishes at once; the change feed never reports anything
    if (u.pathname === "/api/fs/lsdir") return void res.end(JSON.stringify({ entries: [] }));
    if (u.pathname === "/api/fs/index-changes") return void res.end(JSON.stringify({ seq: 1, dirs: [], reset: false }));
    // a file under /ask (and its namesake in /d): a copy with conflict "ask" stops at a question
    const p = u.searchParams.get("path") ?? "";
    if (u.pathname === "/api/fs/stat" && (p.startsWith("/ask/") || p.startsWith("/d/"))) return void res.end(JSON.stringify({ type: "file", size: 1, mtime: 1 }));
    res.end("{}");
  });
  f.url = await listen(srv);
  return f;
}

/** A machine that takes the connection and never answers. */
async function silentAgent(): Promise<string> {
  return listen(http.createServer(() => {}));
}

type Hub = ReturnType<typeof createHub>;
const peer = { incoming: { socket: { remoteAddress: "127.0.0.1", encrypted: false } } };
let n = 0;
function makeHub(nodes: Record<string, string>, env: Record<string, string> = {}): Hub {
  n++;
  const h = createHub(
    loadConfig({
      FILEDECK_MODE: "hub",
      FILEDECK_AUTH: "on",
      FILEDECK_AGENT_TOKEN: T,
      FILEDECK_STATIC: tmp,
      NODES: Object.entries(nodes)
        .map(([k, v]) => `${k}=${v}`)
        .join(","),
      FILEDECK_ADMINS: "alice",
      FILEDECK_AUTH_FILE: path.join(tmp, `auth-${n}.db`),
      FILEDECK_DIFF_DIR: path.join(tmp, `diff-${n}`),
      FILEDECK_JOBS_FILE: path.join(tmp, `jobs-${n}.db`),
      ...env,
    } as never),
    undefined,
    () => {},
    { streamCheckMs: 60_000 },
  );
  hubs.push(h);
  return h;
}
const call = (h: Hub, p: string, cookie: string, init: RequestInit = {}) =>
  h.request("http://localhost" + p, { ...init, headers: { ...(init.body ? { "content-type": "application/json" } : {}), ...(init.headers as Record<string, string>), cookie } }, peer as never);
const postJson = (h: Hub, p: string, cookie: string, body: unknown) => call(h, p, cookie, { method: "POST", body: JSON.stringify(body) });

const ALL = (nodes: string[]): Record<string, NodeAccess> => Object.fromEntries(nodes.map((x) => [x, { runAs: "guest", grants: [{ path: "/", write: true }] }]));
/** A virtual account (made straight in the store) and a cookie for it. */
function virt(h: Hub, name: string, nodes: string[], admin = false): string {
  if (!h.auth!.accounts.get(name)) h.auth!.accounts.create({ name, password: `pw-${name}-123`, admin, nodes: ALL(nodes) });
  return `__Host-filedeck=${h.auth!.sessions.create("virt", name)}`;
}
const identity = (h: Hub, name: string) => h.auth!.accounts.identity("virt", name) as Identity;

async function waitFor(fn: () => boolean | Promise<boolean>, ms = 3000, what = "condition") {
  const t0 = Date.now();
  while (!(await fn())) {
    if (Date.now() - t0 > ms) assert.fail(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

const copy = (from: string) => ({ op: "copy", items: [{ node: "F", path: from }], dst: { node: "G", dir: "/d" }, conflict: "overwrite" });
async function startCopy(h: Hub, cookie: string, from: string): Promise<string> {
  const r = await postJson(h, "/api/ops/jobs", cookie, copy(from));
  assert.equal(r.status, 202, await r.clone().text());
  return ((await r.json()) as { id: string }).id;
}
const opState = async (h: Hub, admin: string, id: string) => ((await (await call(h, `/api/ops/jobs/${id}`, admin)).json()) as { state: string }).state;
const accountChanged = (h: Hub) => (h as unknown as { accountChanged(before: Identity): Promise<void> }).accountChanged;

test("sessions and streams end: the old cookie gets 401 with the signed-out header, and an open change feed ends within 1 s", async () => {
  const F = await fakeAgent();
  const G = await fakeAgent();
  const h = makeHub({ F: F.url, G: G.url });
  const guest = virt(h, "guest", ["F", "G"]);
  assert.equal((await call(h, "/api/auth/me", guest)).status, 200);
  const r = await call(h, "/api/nodes/F/api/events?path=/", guest, { headers: { accept: "text/event-stream" } });
  assert.equal(r.status, 200);
  const reader = r.body!.getReader();
  assert.equal((await reader.read()).done, false);
  const end = (async () => {
    for (;;) {
      const x = await reader.read().catch(() => ({ done: true }));
      if (x.done) return true;
    }
  })();
  const epoch = h.auth!.accounts.epochOf("virt", "guest");
  await accountChanged(h)(identity(h, "guest"));
  assert.equal(h.auth!.accounts.epochOf("virt", "guest"), epoch + 1);
  const me = await call(h, "/api/auth/me", guest);
  assert.equal(me.status, 401);
  assert.equal(me.headers.get("x-filedeck-auth"), "signed-out");
  assert.equal(await Promise.race([end, new Promise<boolean>((res) => setTimeout(() => res(false), 1000))]), true, "the stream ended");
});

test("hub jobs end: a running copy and a queued one of the account end as canceled; another account's job keeps running", async () => {
  const F = await fakeAgent();
  const G = await fakeAgent();
  const h = makeHub({ F: F.url, G: G.url });
  const guest = virt(h, "guest", ["F", "G"]);
  const other = virt(h, "other", ["F", "G"]);
  const boss = virt(h, "boss", ["F", "G"], true);
  // two slots: guest's first copy and other's copy take them, guest's second waits in the queue
  const running = await startCopy(h, guest, "/slow/a");
  const theirs = await startCopy(h, other, "/slow/b");
  const queued = await startCopy(h, guest, "/slow/c");
  await waitFor(async () => (await opState(h, boss, running)) === "running" && (await opState(h, boss, theirs)) === "running", 3000, "both running");
  assert.equal(await opState(h, boss, queued), "queued");
  const before = identity(h, "guest");
  await accountChanged(h)(before);
  await waitFor(async () => (await opState(h, boss, running)) === "canceled", 3000, "the running job canceled");
  assert.equal(await opState(h, boss, queued), "canceled");
  assert.equal(await opState(h, boss, theirs), "running");
  // (clean-up)
  assert.equal((await call(h, `/api/ops/jobs/${theirs}/cancel`, boss, { method: "POST" })).status, 200);
});

test("stored and paused jobs: a paused job ends as canceled; a queued row another hub holds gets the cancel flag and that hub cancels it", async () => {
  const F = await fakeAgent();
  const G = await fakeAgent();
  const h = makeHub({ F: F.url, G: G.url });
  const guest = virt(h, "guest", ["F", "G"]);
  const boss = virt(h, "boss", ["F", "G"], true);
  // a paused one that has started, and a paused one still in the queue
  const started = await startCopy(h, guest, "/slow/a");
  await waitFor(async () => (await opState(h, boss, started)) === "running", 3000, "running");
  assert.equal((await call(h, `/api/ops/jobs/${started}/pause`, boss, { method: "POST" })).status, 200);
  const waiting = await startCopy(h, guest, "/slow/b");
  assert.equal((await call(h, `/api/ops/jobs/${waiting}/pause`, boss, { method: "POST" })).status, 200);
  assert.equal(await opState(h, boss, started), "paused");
  assert.equal(await opState(h, boss, waiting), "paused");
  // the other hub of a rollout, on the same store: its job never gets a slot, so it stays queued until told otherwise
  const store = new JobStore(path.join(tmp, `jobs-${n}.db`));
  const q2 = new OpQueue({ agents: h.nodeTargets as Map<string, Target>, isSource: () => false, concurrency: 0, shared: { store, tickMs: 30 } });
  const held = q2.create(copy("/slow/c") as never, identity(h, "guest")).id;
  const keep = q2.create(copy("/slow/d") as never, identity(h, "boss")).id;
  assert.equal(await opState(h, boss, held), "queued");

  await accountChanged(h)(identity(h, "guest"));
  await waitFor(async () => (await opState(h, boss, started)) === "canceled", 3000, "the started paused job canceled");
  assert.equal(await opState(h, boss, waiting), "canceled");
  assert.equal(store.get(held, "ops")?.cancel, 1, "the held row has the cancel flag");
  await waitFor(() => q2.get(held)?.state === "canceled", 3000, "the other hub canceled it");
  assert.equal(q2.get(keep)?.state, "queued", "another account's row is left alone");
  await waitFor(async () => (await opState(h, boss, held)) === "canceled", 3000, "this hub shows it canceled");
  q2.cancel(keep);
});

test("stored jobs: a row of the account whose hub went away, flagged before this hub adopts it, is adopted as canceled and never runs", async () => {
  const F = await fakeAgent();
  const G = await fakeAgent();
  const h = makeHub({ F: F.url, G: G.url });
  virt(h, "guest", ["F", "G"]);
  const boss = virt(h, "boss", ["F", "G"], true);
  const store = new JobStore(path.join(tmp, `jobs-${n}.db`));
  const q2 = new OpQueue({ agents: h.nodeTargets as Map<string, Target>, isSource: () => false, concurrency: 0, shared: { store, tickMs: 60_000 } });
  const id = q2.create(copy("/slow/orphan") as never, identity(h, "guest")).id;
  // the flag is set while the other hub still holds the row; it goes away before its next tick and hands its jobs over (beat 0), so
  // this hub adopts the row with the flag on it
  await accountChanged(h)(identity(h, "guest"));
  assert.equal(store.get(id, "ops")?.cancel, 1);
  await q2.interrupt(0);
  await waitFor(async () => (await opState(h, boss, id)) === "canceled", 3000, "adopted as canceled");
  assert.equal(F.recs.filter((r) => r.path === "/api/fs/stat").length, 0, "the job never ran");
});

test("compares end: every compare of the account, running or finished, is closed and dismissed; its live follow stops polling", async () => {
  const F = await fakeAgent();
  const G = await fakeAgent();
  const h = makeHub({ F: F.url, G: G.url });
  const guest = virt(h, "guest", ["F", "G"]);
  const boss = virt(h, "boss", ["F", "G"], true);
  const start = async (l: string, r: string) => {
    const res = await postJson(h, "/api/diff/jobs", guest, { left: { node: "F", path: l }, right: { node: "G", path: r } });
    assert.equal(res.status, 202, await res.clone().text());
    return ((await res.json()) as { id: string }).id;
  };
  const running = await start("/slow/l", "/slow/r");
  const done = await start("/e", "/e");
  const state = async (id: string) => ((await (await call(h, `/api/diff/jobs/${id}`, boss)).json()) as { state: string }).state;
  await waitFor(async () => (await state(running)) === "running" && (await state(done)) === "done", 3000, "one compare running, one done");
  const polls = () => [F, G].reduce((k, a) => k + a.recs.filter((r) => r.path === "/api/fs/index-changes").length, 0);
  // both follow the change feeds every 2 s
  await waitFor(() => polls() >= 4, 4000, "the live follow polling");

  await accountChanged(h)(identity(h, "guest"));
  const after = polls();
  await new Promise((r) => setTimeout(r, 3000));
  assert.equal(polls() - after, 0, "no change-feed call after the change");
  // the account's new session no longer sees them, nor does an administrator once they have settled
  const again = virt(h, "guest", ["F", "G"]);
  assert.deepEqual(((await (await call(h, "/api/diff/jobs", again)).json()) as { jobs: unknown[] }).jobs, []);
  for (const id of [running, done]) {
    assert.equal((await call(h, `/api/diff/jobs/${id}`, again)).status, 404);
    assert.equal((await call(h, `/api/diff/jobs/${id}/rows?rel=`, again)).status, 404);
    await waitFor(async () => (await call(h, `/api/diff/jobs/${id}`, boss)).status === 404, 3000, "dismissed");
  }
});

test("waiting jobs: a copy waiting on a conflict question ends as canceled", async () => {
  const F = await fakeAgent();
  const G = await fakeAgent();
  const h = makeHub({ F: F.url, G: G.url });
  const guest = virt(h, "guest", ["F", "G"]);
  const boss = virt(h, "boss", ["F", "G"], true);
  const r = await postJson(h, "/api/ops/jobs", guest, { op: "copy", items: [{ node: "F", path: "/ask/f.txt" }], dst: { node: "G", dir: "/d" }, conflict: "ask" });
  assert.equal(r.status, 202);
  const id = ((await r.json()) as { id: string }).id;
  await waitFor(async () => (await opState(h, boss, id)) === "waiting", 3000, "the question");
  await accountChanged(h)(identity(h, "guest"));
  await waitFor(async () => (await opState(h, boss, id)) === "canceled", 3000, "canceled");
});

test("busy store: a cancel flag the store could not take is written at a later tick", async () => {
  const F = await fakeAgent();
  const G = await fakeAgent();
  const h = makeHub({ F: F.url, G: G.url });
  virt(h, "guest", ["F", "G"]);
  const file = path.join(tmp, `busy-${n}.db`);
  const store = new JobStore(file);
  const agents = h.nodeTargets as Map<string, Target>;
  // the other hub holds a queued job of guest; this queue only flags it
  const q2 = new OpQueue({ agents, isSource: () => false, concurrency: 0, shared: { store, tickMs: 60_000 } });
  const id = q2.create(copy("/slow/c") as never, identity(h, "guest")).id;
  const q1 = new OpQueue({ agents, isSource: () => false, concurrency: 0, shared: { store: new JobStore(file), tickMs: 60_000 } });
  const { DatabaseSync } = await import("node:sqlite");
  const lock = new DatabaseSync(file);
  const lines: string[] = [];
  const orig = console.error;
  console.error = (...a: unknown[]) => void lines.push(a.map(String).join(" "));
  try {
    lock.exec("BEGIN IMMEDIATE");
    q1.cancelOwner("virt", "guest");
    q1.tick(); // still busy: nothing is written, nothing is lost
    lock.exec("COMMIT");
    assert.equal(store.get(id, "ops")?.cancel, 0);
    q1.tick();
  } finally {
    console.error = orig;
    lock.close();
  }
  assert.equal(store.get(id, "ops")?.cancel, 1, "flagged after the store was free again");
  assert.equal(lines.length, 1, lines.join("\n"));
  q2.tick();
  assert.equal(q2.get(id)?.state, "canceled");
});

test("adoption: a flag set between the orphan list and the claim is still honoured", async () => {
  const F = await fakeAgent();
  const G = await fakeAgent();
  const h = makeHub({ F: F.url, G: G.url });
  virt(h, "guest", ["F", "G"]);
  const file = path.join(tmp, `adopt-${n}.db`);
  const agents = h.nodeTargets as Map<string, Target>;
  const q2 = new OpQueue({ agents, isSource: () => false, concurrency: 0, shared: { store: new JobStore(file), tickMs: 60_000 } });
  const id = q2.create(copy("/slow/c") as never, identity(h, "guest")).id;
  await q2.interrupt(0);
  const store3 = new JobStore(file);
  const claim = store3.claim.bind(store3);
  store3.claim = (...a: Parameters<JobStore["claim"]>) => {
    store3.setCancel(a[0], "ops"); // flagged by another hub just after this one listed the orphans
    return claim(...a);
  };
  const q3 = new OpQueue({ agents, isSource: () => false, concurrency: 0, shared: { store: store3, tickMs: 60_000 } });
  q3.tick();
  assert.equal(q3.get(id)?.state, "canceled");
});

test("agent errors: a list or cancel answered with neither OK nor 401 gives a log line naming the machine and the status", async () => {
  const F = await fakeAgent();
  const G = await fakeAgent();
  F.status = 500;
  G.jobs = [{ id: "live-1", state: "running" }];
  const h = makeHub({ F: F.url, G: G.url });
  virt(h, "guest", ["F", "G"]);
  const lines: string[] = [];
  const orig = console.error;
  console.error = (...a: unknown[]) => void lines.push(a.map(String).join(" "));
  try {
    await accountChanged(h)(identity(h, "guest"));
  } finally {
    console.error = orig;
  }
  assert.equal(lines.length, 1, lines.join("\n"));
  assert.match(lines[0]!, /\bF\b/);
  assert.match(lines[0]!, /500/);
  // a 401 (the agent refuses the claim) is not logged
  F.status = 401;
  lines.length = 0;
  console.error = (...a: unknown[]) => void lines.push(a.map(String).join(" "));
  try {
    await accountChanged(h)(identity(h, "guest"));
  } finally {
    console.error = orig;
  }
  assert.deepEqual(lines, []);
});

test("agent jobs end at the new epoch: only the live job is cancelled, on every machine, also one the change took away", async () => {
  const F = await fakeAgent();
  const G = await fakeAgent();
  for (const a of [F, G])
    a.jobs = [
      { id: "live-1", state: "queued" },
      { id: "done-1", state: "done" },
    ];
  const h = makeHub({ F: F.url, G: G.url });
  virt(h, "guest", ["F", "G"]);
  const before = identity(h, "guest");
  // the change takes G away
  h.auth!.accounts.update("guest", { nodes: ALL(["F"]) });
  await accountChanged(h)(before);
  const epoch = h.auth!.accounts.epochOf("virt", "guest");
  assert.equal(epoch, before.epoch + 1);
  for (const a of [F, G]) {
    const cancels = a.recs.filter((r) => r.method === "POST" && r.path.endsWith("/cancel"));
    assert.deepEqual(
      cancels.map((r) => r.path),
      ["/api/jobs/live-1/cancel"],
    );
    for (const r of a.recs.filter((x) => x.path.startsWith("/api/jobs"))) {
      assert.equal(r.claim?.name, "guest");
      assert.equal(r.claim?.epoch, epoch, `${r.method} ${r.path} at the raised epoch`);
    }
  }

  // a system account is asked on every machine
  const sysBefore: Identity = { kind: "sys", name: "carol", admin: false, epoch: h.auth!.accounts.epochOf("sys", "carol") };
  for (const a of [F, G]) a.recs.length = 0;
  await accountChanged(h)(sysBefore);
  for (const a of [F, G]) {
    assert.deepEqual(
      a.recs.filter((r) => r.method === "POST").map((r) => r.path),
      ["/api/jobs/live-1/cancel"],
    );
    assert.equal(a.recs[0]?.claim?.epoch, sysBefore.epoch + 1);
  }
});

test("machine down: one machine that does not answer; accountChanged settles within 8.5 s and logs one line naming it", async () => {
  const F = await fakeAgent();
  F.jobs = [{ id: "live-1", state: "running" }];
  const silent = await silentAgent();
  const h = makeHub({ F: F.url, Quiet: silent });
  virt(h, "guest", ["F", "Quiet"]);
  const lines: string[] = [];
  const orig = console.error;
  console.error = (...a: unknown[]) => void lines.push(a.map(String).join(" "));
  let ms = 0;
  try {
    const t0 = performance.now();
    await accountChanged(h)(identity(h, "guest"));
    ms = performance.now() - t0;
  } finally {
    console.error = orig;
  }
  // (the agents get 8 s: one that answers waits up to 3 s for the account's worker to stop first)
  assert.ok(ms >= 7900 && ms < 8500, `${ms} ms`);
  assert.equal(lines.length, 1, lines.join("\n"));
  assert.match(lines[0]!, /Quiet/);
  assert.doesNotMatch(lines[0]!, /\bF\b/);
  assert.deepEqual(
    F.recs.filter((r) => r.method === "POST").map((r) => r.path),
    ["/api/jobs/live-1/cancel"],
  );
});

test("cancelAgentJobs: only cancels answered OK count; other statuses but 401 are reported with the machine", async () => {
  const seen: string[] = [];
  const answers: Record<string, number> = { "/api/jobs/a/cancel": 200, "/api/jobs/b/cancel": 500, "/api/jobs/c/cancel": 401 };
  const out = await cancelAgentJobs({
    call: async (node, rest) =>
      rest === "/api/jobs"
        ? Response.json({ jobs: [{ id: "a", state: "running" }, { id: "b", state: "queued" }, { id: "c", state: "queued" }] })
        : new Response("{}", { status: answers[rest] ?? 404 }),
    nodes: ["M"],
    pick: () => true,
    signal: AbortSignal.timeout(1000),
    log: () => assert.fail("not unreachable"),
    onStatus: (node, status, what) => void seen.push(`${node} ${status} ${what}`),
  });
  assert.deepEqual(out, { M: 1 });
  assert.equal(seen.length, 1);
  assert.match(seen[0]!, /^M 500 /);
});
