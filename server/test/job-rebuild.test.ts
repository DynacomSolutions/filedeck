import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createAgent } from "../src/agent.ts";
import { loadConfig } from "../src/config.ts";
import { haveSevenZip } from "../src/sevenzip.ts";
import { JobStore, type JobRow } from "../src/job-store.ts";

let tmp: string;
let n = 0;
before(() => void (tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "filedeck-rebuild-")))));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const SECRET = "Tr0ub4dor&3-correct horse";

type Job = { id: string; origin?: string; state: string; createdAt: number; result?: any; error?: string };
function agent(env: Record<string, string> = {}) {
  const root = path.join(tmp, `root${n}`);
  fs.mkdirSync(path.join(root, "tree/sub"), { recursive: true });
  fs.mkdirSync(path.join(root, "ro"), { recursive: true });
  fs.writeFileSync(path.join(root, "tree/a.txt"), "12345");
  fs.writeFileSync(path.join(root, "tree/sub/b.txt"), "1234567890");
  const jobsFile = path.join(tmp, `jobs${n++}.db`);
  const app = createAgent(loadConfig({ FILEDECK_ROOT: root, FILEDECK_NODE: "t", FILEDECK_JOBS_FILE: jobsFile, ...env } as never));
  return { app, root, jobsFile, close: () => (app as unknown as { close(): Promise<void> }).close() };
}
const post = (a: { app: { request: Function } }, url: string, body: unknown, headers: Record<string, string> = {}) =>
  a.app.request(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) }) as Promise<Response>;
async function done(a: { app: { request: Function } }, id: string): Promise<Job> {
  for (let i = 0; i < 400; i++) {
    const r = (await a.app.request(`/api/jobs/${id}`)) as Response;
    if (r.status === 200) {
      const j = (await r.json()) as Job;
      if (j.state !== "queued" && j.state !== "running") return j;
    }
    await sleep(25);
  }
  throw new Error("job did not finish");
}
/** A row left by an owner that handed over (beat 0): the agent under test adopts it on its next tick. */
function orphan(file: string, kind: string, params: unknown, id = `adopt-${n}`, origin?: string, seenAt?: number): JobRow {
  const createdAt = 1_000_000 + n;
  const view = { id, kind, title: "t", state: "running", ...(origin ? { origin } : {}), ...(seenAt ? { seenAt } : {}), progress: { bytes: 0, totalBytes: 0, entries: 0, totalEntries: 0, current: "" }, createdAt };
  const row = { id, scope: "t", kind, title: "t", params: params === null ? null : JSON.stringify(params), view: JSON.stringify(view), state: "running", owner: "dead", beat: 0, created_at: createdAt, finished_at: null };
  assert.ok(new JobStore(file).put(row));
  return { ...row, cancel: 0 };
}

test("an adopted size job runs again under the same id with the same result", async () => {
  const a = agent();
  const first = await done(a, ((await (await post(a, "/api/jobs/size", { path: "/tree" })).json()) as Job).id);
  const r = orphan(a.jobsFile, "size", { path: "/tree", fresh: true });
  const j = await done(a, r.id);
  assert.equal(j.id, r.id);
  assert.equal(j.createdAt, r.created_at);
  assert.equal(j.state, "done", j.error);
  assert.deepEqual(j.result, first.result);
  await a.close();
});

test("an adopted perms job is planned again: a path that became read-only or left the root is refused", async () => {
  const a = agent({ FILEDECK_READONLY: "/ro" });
  fs.mkdirSync(path.join(a.root, "ro/d"));
  const outside = fs.mkdtempSync(path.join(tmp, "outside-"));
  fs.symlinkSync(outside, path.join(a.root, "tree/escape"));
  fs.mkdirSync(path.join(outside, "x"));
  const ro = await done(a, orphan(a.jobsFile, "perms", { path: "/ro/d", mode: 0o755, recursive: true }, "p-ro").id);
  assert.equal(ro.state, "failed");
  assert.match(ro.error!, /read-only/);
  const out = await done(a, orphan(a.jobsFile, "perms", { path: "/tree/escape/x", mode: 0o755, recursive: true }, "p-out").id);
  assert.equal(out.state, "failed");
  const ok = await done(a, orphan(a.jobsFile, "perms", { path: "/tree", mode: 0o755, recursive: true }, "p-ok").id);
  assert.equal(ok.state, "done", ok.error);
  await a.close();
});

test("passworded compress and extract are failed as interrupted; the password is never stored", async () => {
  const a = agent();
  if (haveSevenZip()) {
    const r = await post(a, "/api/jobs/compress", { dir: "/tree", names: ["a.txt"], format: "zip", name: "pw" }, { "x-filedeck-password": Buffer.from(SECRET).toString("base64") });
    const id = ((await r.json()) as Job).id;
    await done(a, id);
    assert.equal(new JobStore(a.jobsFile).get(id, "t")!.params, null);
  }
  const c = await done(a, orphan(a.jobsFile, "compress", null, "c-pw").id);
  assert.equal(c.state, "failed");
  assert.match(c.error!, /Start it again/);
  const x = await done(a, orphan(a.jobsFile, "extract", null, "x-1").id);
  assert.equal(x.state, "failed");
  await a.close();
  for (const f of [a.jobsFile, a.jobsFile + "-wal"]) if (fs.existsSync(f)) assert.ok(!fs.readFileSync(f).includes(SECRET), f);
});

test("an adopted password-free compress runs again and produces one archive", async () => {
  const a = agent();
  const r = orphan(a.jobsFile, "compress", { dir: "/tree", names: ["a.txt", "sub"], format: "zip", name: "out", exclude: [] }, "c-1");
  const j = await done(a, r.id);
  assert.equal(j.state, "done", j.error);
  assert.deepEqual(fs.readdirSync(path.join(a.root, "tree")).filter((f) => f.startsWith("out") || f.startsWith(".filedeck")), ["out.zip"]);
  await a.close();
});

test("an adopted compress into a volume that became read-only is refused", async () => {
  const a = agent({ FILEDECK_READONLY: "/tree" });
  const j = await done(a, orphan(a.jobsFile, "compress", { dir: "/tree", names: ["a.txt"], format: "zip", exclude: [] }, "c-ro").id);
  assert.equal(j.state, "failed");
  assert.match(j.error!, /read-only/);
  await a.close();
});

test("a size request attaches to a live job only the shared store shows", async () => {
  const a = agent();
  const row = orphan(a.jobsFile, "size", { path: "/tree", fresh: true }, "foreign-1");
  new JobStore(a.jobsFile).put({ ...row, beat: Date.now() }); // fresh heartbeat: still owned by the other pod
  const j = (await (await post(a, "/api/jobs/size", { path: "/tree" })).json()) as Job;
  assert.equal(j.id, "foreign-1");
  await a.close();
});

test("adopted overlapping size jobs never walk together", async () => {
  const a = agent();
  orphan(a.jobsFile, "size", { path: "/tree/sub", fresh: true }, "adopt-desc");
  orphan(a.jobsFile, "size", { path: "/tree", fresh: true }, "adopt-anc");
  const [d, n] = [await done(a, "adopt-desc"), await done(a, "adopt-anc")] as (Job & { startedAt: number; finishedAt: number })[];
  assert.ok(d!.state === "done" && n!.state === "done");
  assert.ok(n!.startedAt >= d!.finishedAt || d!.startedAt >= n!.finishedAt, "walks overlapped");
  await a.close();
});

test("an adopted du job without a rescan reads nothing the first run already stored", async () => {
  const a = agent();
  await done(a, ((await (await post(a, "/api/jobs/size", { path: "/tree" })).json()) as Job).id);
  const cached = await done(a, orphan(a.jobsFile, "du", { path: "/tree", fresh: false }, "adopt-du-cached", undefined, Date.now()).id);
  assert.equal(cached.result.read, 0);
  const rescan = await done(a, orphan(a.jobsFile, "du", { path: "/tree", fresh: true }, "adopt-du-fresh", undefined, Date.now()).id);
  assert.ok(rescan.result.read > 0);
  await a.close();
});

test("a size walk waits for an overlapping walk of another process on the same store, then runs", async () => {
  const root = path.join(tmp, "xpod");
  fs.mkdirSync(path.join(root, "big/sub"), { recursive: true });
  fs.writeFileSync(path.join(root, "big/sub/f"), "x");
  const jobsFile = path.join(tmp, "xpod.db");
  const fsp = (await import("node:fs/promises")).default;
  const orig = fsp.readdir;
  (fsp as { readdir: unknown }).readdir = async (p: string, ...a: unknown[]) => {
    if (String(p) === path.join(root, "big")) await sleep(700);
    return (orig as (...x: unknown[]) => Promise<unknown>)(p, ...a);
  };
  const mk = () => createAgent(loadConfig({ FILEDECK_ROOT: root, FILEDECK_NODE: "t", FILEDECK_JOBS_FILE: jobsFile } as never));
  const old = { app: mk() }, fresh = { app: mk() }; // two processes (an old and a new pod) on one job store
  try {
    const big = (await (await post(old, "/api/jobs/size", { path: "/big" })).json()) as Job;
    await sleep(150);
    const sub = (await (await post(fresh, "/api/jobs/size", { path: "/big/sub" })).json()) as Job;
    await sleep(150);
    const mid = (await (await fresh.app.request(`/api/jobs/${sub.id}`)).json()) as Job;
    assert.equal(mid.state, "queued", "the descendant walk waits for the other process");
    const b = (await done(old, big.id)) as Job & { finishedAt: number };
    const s = (await done(fresh, sub.id)) as Job & { startedAt: number };
    assert.ok(s.state === "done" && b.state === "done");
    assert.ok(s.startedAt >= b.finishedAt, "walks overlapped");
  } finally {
    (fsp as { readdir: unknown }).readdir = orig;
    await (old.app as unknown as { close(): Promise<void> }).close();
    await (fresh.app as unknown as { close(): Promise<void> }).close();
  }
});

test("origin: the UI endpoint starts a ui job, GET /api/du a cli job, and the job list carries it", async () => {
  const a = agent();
  const ui = (await (await post(a, "/api/jobs/size", { path: "/tree" })).json()) as Job;
  assert.equal(ui.origin, "ui");
  assert.equal((await done(a, ui.id)).origin, "ui");
  const r = (await a.app.request("/api/du?path=/tree/sub&fresh=1")) as Response;
  assert.equal(r.status, 200);
  const list = ((await (await a.app.request("/api/jobs")).json()) as { jobs: Job[] }).jobs;
  assert.deepEqual(list.map((j) => j.origin).sort(), ["cli", "ui"]);
  assert.equal(new JobStore(a.jobsFile).get(ui.id, "t") && JSON.parse(new JobStore(a.jobsFile).get(ui.id, "t")!.view).origin, "ui");
  await a.close();
});

test("origin: an adopted job keeps its stored origin; old rows without one default by kind", async () => {
  const a = agent();
  const kept = await done(a, orphan(a.jobsFile, "size", { path: "/tree" }, "o-watch", "watcher").id);
  assert.equal(kept.origin, "watcher");
  const oldDu = await done(a, orphan(a.jobsFile, "du", { path: "/tree", fresh: false }, "o-du", undefined, Date.now()).id);
  assert.equal(oldDu.origin, "cli");
  const oldSize = await done(a, orphan(a.jobsFile, "size", { path: "/tree", fresh: false }, "o-size").id);
  assert.equal(oldSize.origin, "ui");
  assert.equal(JSON.parse(new JobStore(a.jobsFile).get("o-watch", "t")!.view).origin, "watcher");
  await a.close();
});
