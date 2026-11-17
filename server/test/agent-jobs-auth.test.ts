import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createAgent } from "../src/agent.ts";
import { loadConfig } from "../src/config.ts";
import { signClaim, USER_HEADER, type UserClaim } from "../src/auth/identity.ts";
import { Jobs } from "../src/jobs.ts";
import { JobStore } from "../src/job-store.ts";
import { SizeStore } from "../src/size-store.ts";
import { createWorkerApp, JOBS_HEADER } from "../src/worker.ts";
import type { WorkerPool } from "../src/worker-pool.ts";
import { useSandboxOrOff } from "./sandbox-env.ts";
import { chownForTest, fakeResolver, privateTmpdir } from "./worker-env.ts";

/**
 * Sign-in on: the jobs in the root process (folder sizes) belong to the account that started them, and the job list and job routes
 * also reach the account's own worker (archive jobs), without ever starting one.
 */

await useSandboxOrOff();
const HAVE_BSDTAR = spawnSync("bsdtar", ["--version"], { stdio: "ignore" }).status === 0;

const T = "agent-secret-jobs";
let work = "";
let root = "";
let n = 0;
let dropTmp = () => {};
type Agent = ReturnType<typeof createAgent>;
const apps: Agent[] = [];
const holders: SizeStore[] = [];

before(() => {
  dropTmp = privateTmpdir();
  work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "filedeck-jobsauth-")));
  root = path.join(work, "root");
  fs.mkdirSync(path.join(root, "d/e"), { recursive: true });
  fs.writeFileSync(path.join(root, "d/f.txt"), "12345");
  fs.mkdirSync(path.join(root, "arc"));
  fs.writeFileSync(path.join(root, "arc/x.txt"), "to be zipped\n");
  fs.chmodSync(work, 0o755);
  chownForTest(root);
});
after(async () => {
  for (const a of apps) await (a as unknown as { close(): Promise<void> }).close();
  for (const h of holders) h.close();
  fs.rmSync(work, { recursive: true, force: true });
  dropTmp();
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function agent(env: Record<string, string> = {}, first?: (index: string) => void): { app: Agent; index: string; jobsFile: string } {
  const index = path.join(work, `index${n}`);
  const jobsFile = path.join(work, `jobs${n++}.db`);
  fs.mkdirSync(index, { recursive: true });
  first?.(index);
  const app = createAgent(
    loadConfig({ FILEDECK_ROOT: root, FILEDECK_NODE: "t", FILEDECK_AGENT_TOKEN: T, FILEDECK_AUTH: "on", FILEDECK_INDEX_DIR: index, FILEDECK_JOBS_FILE: jobsFile, ...env } as never),
    () => {},
    { accounts: fakeResolver({ alice: {}, bob: {}, carol: {} }) },
  );
  apps.push(app);
  return { app, index, jobsFile };
}
const poolOf = (app: Agent) => (app as unknown as { pool: WorkerPool }).pool;
const sys = (name: string, epoch = 1): UserClaim => ({ kind: "sys", name, epoch, iat: Date.now() });
const headers = (claim: UserClaim, extra: Record<string, string> = {}) => ({ authorization: `Bearer ${T}`, [USER_HEADER]: signClaim({ ...claim, iat: Date.now() }, T), ...extra });
const get = (app: Agent, p: string, who: string) => app.request(p, { headers: headers(sys(who)) });
const post = (app: Agent, p: string, who: string, body?: unknown) =>
  app.request(p, { method: "POST", headers: headers(sys(who), { "content-type": "application/json" }), ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const del = (app: Agent, p: string, who: string) => app.request(p, { method: "DELETE", headers: headers(sys(who)) });
type View = { id: string; kind: string; state: string; progress: { current: string }; queue?: unknown };
const listOf = async (app: Agent, who: string): Promise<View[]> => {
  const r = await get(app, "/api/jobs", who);
  assert.equal(r.status, 200, await r.clone().text());
  return ((await r.json()) as { jobs: View[] }).jobs;
};

/** another process holds the size store's writer lease: a size job of the agent stays queued (it waits for the lease) */
function holdLease(index: string): SizeStore {
  const h = new SizeStore(path.join(index, "sizes-t.db"), { root, ttlMs: 1000, maxEntries: 1000, leaseMs: 60_000 });
  holders.push(h);
  return h;
}

test("a size job belongs to the account that started it", async () => {
  let h!: SizeStore;
  const { app } = agent({}, (index) => (h = holdLease(index)));
  assert.equal(await h.mayScan(), true);
  const s = await post(app, "/api/jobs/size", "alice", { path: "/d" });
  assert.equal(s.status, 202, await s.clone().text());
  const job = (await s.json()) as View;
  assert.equal(job.state, "queued");
  // bob neither sees nor touches it
  assert.ok(!(await listOf(app, "bob")).some((j) => j.id === job.id));
  assert.equal((await get(app, `/api/jobs/${job.id}`, "bob")).status, 404);
  const bc = await post(app, `/api/jobs/${job.id}/cancel`, "bob");
  assert.equal(bc.status, 404);
  assert.deepEqual(await bc.json(), { error: "not found" });
  assert.equal((await del(app, `/api/jobs/${job.id}`, "bob")).status, 404);
  assert.equal((await get(app, `/api/jobs/${job.id}`, "alice")).status, 200, "bob's cancel did nothing");
  assert.equal(((await (await get(app, `/api/jobs/${job.id}`, "alice")).json()) as View).state, "queued");
  // bob asks for the same folder: he joins the live scan and may follow it, but it is not his (not listed, no cancel), and he never sees what it reads
  const b = await post(app, "/api/jobs/size", "bob", { path: "/d" });
  assert.equal(b.status, 202);
  assert.equal(((await b.json()) as View).id, job.id, "one scan per folder");
  const bv = await get(app, `/api/jobs/${job.id}`, "bob");
  assert.equal(bv.status, 200);
  const view = (await bv.json()) as View;
  assert.equal(view.progress.current, "");
  assert.equal(view.queue, undefined);
  assert.ok(!(await listOf(app, "bob")).some((j) => j.id === job.id));
  assert.equal((await post(app, `/api/jobs/${job.id}/cancel`, "bob")).status, 404);
  assert.equal((await get(app, `/api/jobs/${job.id}`, "carol")).status, 404, "a third account still gets 404");
  // alice sees it and cancels it
  assert.ok((await listOf(app, "alice")).some((j) => j.id === job.id));
  const ac = await post(app, `/api/jobs/${job.id}/cancel`, "alice");
  assert.equal(ac.status, 200);
  assert.equal(((await ac.json()) as View).state, "canceled");
  assert.equal((await del(app, `/api/jobs/${job.id}`, "bob")).status, 404);
  assert.equal((await del(app, `/api/jobs/${job.id}`, "alice")).status, 200);
});

test("a queued job shows the jobs ahead of it, but another account's only by state", async () => {
  let h!: SizeStore;
  const { app } = agent({}, (index) => (h = holdLease(index)));
  assert.equal(await h.mayScan(), true);
  const b = await post(app, "/api/jobs/size", "bob", { path: "/d" });
  assert.equal(b.status, 202);
  const bob = (await b.json()) as View & { title: string };
  const a = await post(app, "/api/jobs/size", "alice", { path: "/arc" });
  assert.equal(a.status, 202);
  const answers = [await a.text()];
  const id = (JSON.parse(answers[0]!) as View).id;
  answers.push(await (await get(app, `/api/jobs/${id}`, "alice")).text());
  answers.push(await (await get(app, "/api/jobs", "alice")).text());
  for (const t of answers) {
    assert.ok(!t.includes(bob.id), "no id of bob's job");
    assert.ok(!t.includes("Size of d"), "no title of bob's job");
  }
  const v = JSON.parse(answers[1]!) as { queue?: { position: number; ahead: unknown[] } };
  assert.equal(v.queue?.position, 1);
  assert.deepEqual(v.queue?.ahead, [{ state: "queued" }]);
  // bob's own view of his job is whole
  const bv = (await (await get(app, `/api/jobs/${bob.id}`, "bob")).json()) as View & { title: string };
  assert.equal(bv.title, "Size of d");
  for (const x of [bob.id, id]) await post(app, `/api/jobs/${x}/cancel`, x === id ? "alice" : "bob");
});

test("the job routes never start a worker", async () => {
  const { app } = agent();
  assert.deepEqual(await listOf(app, "carol"), []);
  assert.equal((await get(app, "/api/jobs/00000000-0000-4000-8000-000000000000", "carol")).status, 404);
  assert.equal((await post(app, "/api/jobs/00000000-0000-4000-8000-000000000000/cancel", "carol")).status, 404);
  assert.equal((await del(app, "/api/jobs/00000000-0000-4000-8000-000000000000", "carol")).status, 404);
  assert.equal(poolOf(app).list().length, 0);
});

test("a compress job runs in the account's worker and is followed through the job routes", { skip: HAVE_BSDTAR ? false : "worker helpers: skipped (bsdtar not installed here)" }, async () => {
  const { app } = agent();
  const c = await post(app, "/api/jobs/compress", "alice", { dir: "/arc", names: ["x.txt"], format: "zip", name: "x" });
  assert.equal(c.status, 202, await c.clone().text());
  const job = (await c.json()) as View;
  assert.ok((await listOf(app, "alice")).some((j) => j.id === job.id), "listed to alice (from her worker)");
  let state = "";
  for (let i = 0; i < 400 && !["done", "failed", "canceled"].includes(state); i++) {
    const r = await get(app, `/api/jobs/${job.id}`, "alice");
    assert.equal(r.status, 200, await r.clone().text());
    state = ((await r.json()) as View).state;
    if (state !== "done") await sleep(25);
  }
  assert.equal(state, "done");
  assert.ok(fs.existsSync(path.join(root, "arc/x.zip")));
  // bob: not listed, 404 (his own worker, which runs now, does not know it), and alice's worker is not asked for him
  assert.equal((await get(app, "/api/fs/stat?path=/", "bob")).status, 200);
  assert.ok(!(await listOf(app, "bob")).some((j) => j.id === job.id));
  assert.equal((await get(app, `/api/jobs/${job.id}`, "bob")).status, 404);
  assert.equal((await post(app, `/api/jobs/${job.id}/cancel`, "bob")).status, 404);
  assert.equal((await del(app, `/api/jobs/${job.id}`, "bob")).status, 404);
  assert.equal((await del(app, `/api/jobs/${job.id}`, "alice")).status, 200);
  assert.ok(!(await listOf(app, "alice")).some((j) => j.id === job.id));
});

test("a worker's job count holds its archive jobs (idle exit never stops a worker with a running job)", async () => {
  const cfg = { ...loadConfig({ FILEDECK_ROOT: root, FILEDECK_NODE: "t" } as never), worker: true };
  const w = createWorkerApp(cfg);
  try {
    const r = await w.request("/api/jobs/compress", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ dir: "/arc", names: ["x.txt"], format: "zip", name: "count" }) });
    assert.equal(r.status, 202, await r.clone().text());
    assert.equal(r.headers.get(JOBS_HEADER), "1");
  } finally {
    await (w as unknown as { close(): Promise<void> }).close();
    fs.rmSync(path.join(root, "arc/count.zip"), { force: true });
  }
});

test("a size job kept in the shared job file and adopted by a new agent keeps its owner", async () => {
  // the Jobs level: the owner is part of the stored params, so the process that adopts the job has it
  const file = path.join(work, `adopt${n++}.db`);
  const shared = (store: JobStore) => ({ store, scope: "t", tickMs: 50, leaseMs: 100 });
  const A = new Jobs(2, 100, undefined, undefined, shared(new JobStore(file)));
  const never = (signal: AbortSignal) => new Promise<void>((_, rej) => signal.addEventListener("abort", () => rej(new Error("aborted"))));
  const j = A.create("size", "Size of x", async () => 1, undefined, never, { params: { path: "/x", fresh: false }, owner: "sys:alice" });
  assert.equal(A.ownerOf(j.id), "sys:alice");
  await A.interrupt(10);
  const B = new Jobs(2, 100, undefined, undefined, { ...shared(new JobStore(file)), rebuild: { size: async () => ({ run: async () => 2 }) } });
  for (let i = 0; i < 200 && B.get(j.id)?.state !== "done"; i++) await sleep(25);
  assert.equal(B.get(j.id)?.state, "done", "adopted and run again");
  assert.equal(B.ownerOf(j.id), "sys:alice");
  assert.equal((B.get(j.id) as unknown as Record<string, unknown>).owner, undefined, "the owner is not part of the view");
  await B.interrupt(10);

  // through a new agent: a row left by a process that is gone is adopted, and stays alice's
  const { app, jobsFile } = agent();
  const id = "11111111-1111-4111-8111-111111111111";
  const view = { id, kind: "size", title: "Size of d", state: "running", origin: "ui", progress: { bytes: 0, totalBytes: 0, entries: 0, totalEntries: 0, current: "" }, createdAt: 1_000_000 };
  assert.ok(
    new JobStore(jobsFile).put({ id, scope: "t", kind: "size", title: "Size of d", params: JSON.stringify({ path: "/d", fresh: false, owner: "sys:alice" }), view: JSON.stringify(view), state: "running", owner: "dead", beat: 0, created_at: 1_000_000, finished_at: null }),
  );
  let state = "";
  for (let i = 0; i < 400 && state !== "done"; i++) {
    const r = await get(app, `/api/jobs/${id}`, "alice");
    if (r.status === 200) state = ((await r.json()) as View).state;
    if (state !== "done") await sleep(25);
  }
  assert.equal(state, "done");
  assert.ok((await listOf(app, "alice")).some((x) => x.id === id));
  assert.ok(!(await listOf(app, "bob")).some((x) => x.id === id));
  assert.equal((await get(app, `/api/jobs/${id}`, "bob")).status, 404);
});

test("the worker's own routes are not reachable over HTTP", async () => {
  const { app } = agent();
  for (const p of ["/_worker/can-list", "/%5Fworker/can-list", "//_worker/can-list", "/_root/trash-dir", "/_x"]) {
    const r = await post(app, p, "alice", { paths: ["/"] });
    assert.equal(r.status, 404, p);
    assert.deepEqual(await r.json(), { error: "not found" });
  }
  assert.equal(poolOf(app).list().length, 0, "refused before any worker is asked");
});
