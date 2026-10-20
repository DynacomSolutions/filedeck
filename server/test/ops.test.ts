import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import { createAgent } from "../src/agent.ts";
import { createHub } from "../src/hub.ts";
import { loadConfig } from "../src/config.ts";
import type { OpView } from "../src/ops-queue.ts";

const srvs: ReturnType<typeof serve>[] = [];
let A: string, B: string, hub: string;
const open = (app: { fetch: never }) => new Promise<ReturnType<typeof serve>>((res) => { const s: ReturnType<typeof serve> = serve({ fetch: app.fetch, port: 0 }, () => res(s)); });
const portOf = (s: ReturnType<typeof serve>) => (s.address() as AddressInfo).port;
const mk = (root: string, rel: string, content: string | Buffer) => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), content);
};
const rd = (root: string, rel: string) => fs.readFileSync(path.join(root, rel), "utf8");
const post = (p: string, body?: unknown) => fetch(hub + p, { method: "POST", headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
const start = async (body: unknown) => {
  const r = await post("/api/ops/jobs", body);
  assert.equal(r.status, 202, await r.clone().text());
  return (await r.json()) as OpView;
};
const get = async (id: string) => (await (await fetch(`${hub}/api/ops/jobs/${id}`)).json()) as OpView;
const until = async (id: string, f: (v: OpView) => boolean, ms = 8000) => {
  const t0 = Date.now();
  for (;;) {
    const v = await get(id);
    if (f(v)) return v;
    if (Date.now() - t0 > ms) assert.fail(`timeout, job is ${v.state} ${JSON.stringify(v.progress)}`);
    await new Promise((r) => setTimeout(r, 25));
  }
};
const finished = (v: OpView) => ["done", "failed", "canceled"].includes(v.state);

before(async () => {
  A = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "filedeck-ops-a-")));
  B = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "filedeck-ops-b-")));
  const sa = await open(createAgent(loadConfig({ FILEDECK_ROOT: A, FILEDECK_NODE: "A" } as never)) as never);
  const sb = await open(createAgent(loadConfig({ FILEDECK_ROOT: B, FILEDECK_NODE: "B" } as never)) as never);
  const sh = await open(createHub(loadConfig({ FILEDECK_MODE: "hub", FILEDECK_STATIC: A, NODES: `A=http://127.0.0.1:${portOf(sa)},B=http://127.0.0.1:${portOf(sb)}` } as never)) as never);
  srvs.push(sa, sb, sh);
  hub = `http://127.0.0.1:${portOf(sh)}`;
});
after(() => {
  for (const s of srvs) s.close();
  for (const d of [A, B]) if (d) fs.rmSync(d, { recursive: true, force: true });
});

test("validation rejects bad specs", async () => {
  assert.equal((await post("/api/ops/jobs", { op: "nope" })).status, 400);
  assert.equal((await post("/api/ops/jobs", { op: "copy", items: [{ node: "A", path: "/x" }], dst: { node: "Z", dir: "/" } })).status, 404);
  assert.equal((await post("/api/ops/jobs", { op: "copy", items: [{ node: "A", path: "rel" }], dst: { node: "B", dir: "/" } })).status, 400);
  assert.equal((await post("/api/ops/jobs", { op: "copy", items: [{ node: "A", path: "/" }], dst: { node: "B", dir: "/" } })).status, 400);
  assert.equal((await post("/api/ops/jobs", { op: "copy", items: [], dst: { node: "B", dir: "/" } })).status, 400);
  assert.equal((await post("/api/ops/jobs", { op: "copy", items: [{ node: "A", path: "/x" }], dst: { node: "B", dir: "/" }, conflict: "maybe" })).status, 400);
  assert.equal((await fetch(`${hub}/api/ops/jobs/nope`)).status, 404);
});

test("cross-node copy of files and a folder tree with progress, then same-node copy and move", async () => {
  mk(A, "c1/a.txt", "alpha");
  mk(A, "c1/sub/b.bin", Buffer.alloc(100_000, 7));
  mk(A, "c1/sub/deep/c.txt", "gamma");
  mk(A, "solo.txt", "solo");
  fs.mkdirSync(path.join(B, "in"));
  const j = await start({ op: "copy", items: [{ node: "A", path: "/c1" }, { node: "A", path: "/solo.txt" }], dst: { node: "B", dir: "/in" }, conflict: "ask" });
  const v = await until(j.id, finished);
  assert.equal(v.state, "done");
  assert.equal(rd(B, "in/c1/a.txt"), "alpha");
  assert.equal(rd(B, "in/c1/sub/deep/c.txt"), "gamma");
  assert.equal(fs.statSync(path.join(B, "in/c1/sub/b.bin")).size, 100_000);
  assert.equal(rd(B, "in/solo.txt"), "solo");
  assert.ok(fs.existsSync(path.join(A, "c1/a.txt")), "copy keeps the source");
  assert.equal(v.progress.totalBytes, 100_000 + 5 + 5 + 4);
  assert.equal(v.progress.bytes, v.progress.totalBytes);
  assert.equal(v.progress.entries, 4);
  assert.equal(v.counts.done, 2);
  assert.deepEqual(v.items?.map((i) => i.state), ["done", "done"]);
  assert.equal(v.items?.[0]?.bytes, 100_010);

  // same node: native copy and move
  fs.mkdirSync(path.join(A, "dest"));
  const c = await until((await start({ op: "copy", items: [{ node: "A", path: "/c1" }], dst: { node: "A", dir: "/dest" }, conflict: "ask" })).id, finished);
  assert.equal(c.state, "done");
  assert.equal(rd(A, "dest/c1/sub/deep/c.txt"), "gamma");
  const m = await until((await start({ op: "move", items: [{ node: "A", path: "/solo.txt" }], dst: { node: "A", dir: "/dest" }, conflict: "ask" })).id, finished);
  assert.equal(m.state, "done");
  assert.ok(!fs.existsSync(path.join(A, "solo.txt")));
  assert.equal(rd(A, "dest/solo.txt"), "solo");
});

test("cross-node move removes the source to the trash", async () => {
  mk(A, "mv/x.txt", "x");
  fs.mkdirSync(path.join(B, "mvto"));
  const v = await until((await start({ op: "move", items: [{ node: "A", path: "/mv" }], dst: { node: "B", dir: "/mvto" }, conflict: "ask" })).id, finished);
  assert.equal(v.state, "done");
  assert.equal(rd(B, "mvto/mv/x.txt"), "x");
  assert.ok(!fs.existsSync(path.join(A, "mv")));
});

test("conflict policies on a cross-node name clash: skip, overwrite, rename, ask", async () => {
  mk(A, "cf/f.txt", "NEW");
  mk(B, "cfd/f.txt", "OLD");
  const item = [{ node: "A", path: "/cf/f.txt" }];
  const dst = { node: "B", dir: "/cfd" };

  let v = await until((await start({ op: "copy", items: item, dst, conflict: "skip" })).id, finished);
  assert.equal(v.counts.skipped, 1);
  assert.equal(rd(B, "cfd/f.txt"), "OLD");

  v = await until((await start({ op: "copy", items: item, dst, conflict: "rename" })).id, finished);
  assert.equal(v.state, "done");
  assert.equal(rd(B, "cfd/f (1).txt"), "NEW");
  assert.equal(rd(B, "cfd/f.txt"), "OLD");
  v = await until((await start({ op: "copy", items: item, dst, conflict: "rename" })).id, finished);
  assert.equal(rd(B, "cfd/f (2).txt"), "NEW");

  v = await until((await start({ op: "copy", items: item, dst, conflict: "overwrite" })).id, finished);
  assert.equal(rd(B, "cfd/f.txt"), "NEW");

  // ask: the job waits, the answer decides
  mk(B, "cfd/f.txt", "OLD");
  const j = await start({ op: "copy", items: item, dst, conflict: "ask" });
  const w = await until(j.id, (x) => x.state === "waiting");
  assert.equal(w.conflict?.name, "f.txt");
  assert.equal(w.conflict?.dstType, "file");
  assert.equal((await post(`/api/ops/jobs/${j.id}/resolve`, { action: "bogus" })).status, 400);
  assert.equal((await post(`/api/ops/jobs/${j.id}/resolve`, { action: "rename" })).status, 200);
  v = await until(j.id, finished);
  assert.equal(v.state, "done");
  assert.equal(rd(B, "cfd/f (3).txt"), "NEW");
  assert.equal(rd(B, "cfd/f.txt"), "OLD");
  assert.equal((await post(`/api/ops/jobs/${j.id}/resolve`, { action: "skip" })).status, 409);
});

test("ask with apply-to-all covers every clash in a merged folder; skip keeps the source on move", async () => {
  mk(A, "m1/a.txt", "A1");
  mk(A, "m1/b.txt", "B1");
  mk(A, "m1/c.txt", "C1");
  mk(B, "mt/m1/a.txt", "A0");
  mk(B, "mt/m1/b.txt", "B0");
  const j = await start({ op: "copy", items: [{ node: "A", path: "/m1" }], dst: { node: "B", dir: "/mt" }, conflict: "ask" });
  // the top-level folder clash is asked first: merge by answering overwrite, all
  const w = await until(j.id, (x) => x.state === "waiting");
  assert.equal(w.conflict?.srcType, "dir");
  await post(`/api/ops/jobs/${j.id}/resolve`, { action: "overwrite", all: true });
  const v = await until(j.id, finished);
  assert.equal(v.state, "done");
  assert.equal(rd(B, "mt/m1/a.txt"), "A1");
  assert.equal(rd(B, "mt/m1/b.txt"), "B1");
  assert.equal(rd(B, "mt/m1/c.txt"), "C1");

  mk(A, "m2/a.txt", "A2");
  mk(A, "m2/n.txt", "N2");
  mk(B, "mt/m2/a.txt", "A0");
  const mv = await until((await start({ op: "move", items: [{ node: "A", path: "/m2" }], dst: { node: "B", dir: "/mt" }, conflict: "skip" })).id, finished);
  assert.equal(mv.counts.skipped, 1);
  assert.equal(rd(B, "mt/m2/a.txt"), "A0"); // skipped
  assert.equal(rd(B, "mt/m2/n.txt"), "N2"); // new file merged in
  assert.ok(fs.existsSync(path.join(A, "m2/a.txt")), "source kept because something was skipped");
});

test("same-node rename policy keeps both for copy and move", async () => {
  mk(A, "sn/f.txt", "1");
  mk(A, "sn/d/f.txt", "2");
  const mv = await until((await start({ op: "move", items: [{ node: "A", path: "/sn/f.txt" }], dst: { node: "A", dir: "/sn/d" }, conflict: "rename" })).id, finished);
  assert.equal(mv.state, "done");
  assert.equal(rd(A, "sn/d/f (1).txt"), "1");
  assert.equal(rd(A, "sn/d/f.txt"), "2");
  mk(A, "sn/g.txt", "g");
  const cp = await until((await start({ op: "copy", items: [{ node: "A", path: "/sn/g.txt" }], dst: { node: "A", dir: "/sn" }, conflict: "rename" })).id, finished);
  assert.equal(cp.state, "done");
  assert.equal(rd(A, "sn/g (1).txt"), "g");
  assert.equal(rd(A, "sn/g.txt"), "g");
  const into = await until((await start({ op: "copy", items: [{ node: "A", path: "/sn/d" }], dst: { node: "A", dir: "/sn/d" }, conflict: "rename" })).id, finished);
  assert.equal(into.state, "failed");
});

test("trash and delete jobs report per-item results", async () => {
  mk(A, "rm/a.txt", "a");
  mk(A, "rm/b.txt", "b");
  mk(B, "rm2/c.txt", "c");
  const t = await until((await start({ op: "trash", items: [{ node: "A", path: "/rm/a.txt" }, { node: "A", path: "/rm/missing" }] })).id, finished);
  assert.equal(t.state, "done");
  assert.deepEqual(t.items?.map((i) => i.state), ["done", "failed"]);
  assert.equal(t.counts.failed, 1);
  assert.ok(!fs.existsSync(path.join(A, "rm/a.txt")));
  const d = await until((await start({ op: "delete", items: [{ node: "A", path: "/rm/b.txt" }, { node: "B", path: "/rm2" }] })).id, finished);
  assert.equal(d.state, "done");
  assert.ok(!fs.existsSync(path.join(A, "rm/b.txt")) && !fs.existsSync(path.join(B, "rm2")));
});

test("pause holds a job, resume continues, cancel mid-transfer leaves no partial files", async () => {
  const big = Buffer.alloc(40 * 1024 * 1024, 1);
  mk(A, "big/one.bin", big);
  mk(A, "big/two.bin", big);
  fs.mkdirSync(path.join(B, "bigto"));
  const item = [{ node: "A", path: "/big" }];
  const dst = { node: "B", dir: "/bigto" };

  // paused before it starts: nothing moves
  const j = await start({ op: "copy", items: item, dst, conflict: "ask" });
  await post(`/api/ops/jobs/${j.id}/pause`);
  assert.equal((await get(j.id)).state, "paused");
  await new Promise((r) => setTimeout(r, 200));
  assert.ok(!fs.existsSync(path.join(B, "bigto/big")));
  await post(`/api/ops/jobs/${j.id}/resume`);
  // cancel while bytes are flowing
  await until(j.id, (v) => v.progress.bytes > 0 || finished(v));
  await post(`/api/ops/jobs/${j.id}/cancel`);
  const v = await until(j.id, finished, 15000);
  assert.ok(v.state === "canceled" || v.state === "done");
  if (v.state === "canceled") {
    const parts = () => {
      const left: string[] = [];
      const walk = (d: string) => {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
          if (e.name.endsWith(".part")) left.push(path.join(d, e.name));
          if (e.isDirectory()) walk(path.join(d, e.name));
        }
      };
      walk(B);
      return left;
    };
    // the agent drops its temp file as soon as it sees the aborted request
    for (let i = 0; i < 80 && parts().length; i++) await new Promise((r) => setTimeout(r, 25));
    assert.deepEqual(parts(), []);
  }
  assert.equal((await post(`/api/ops/jobs/${j.id}/pause`)).status, 200);
  assert.equal((await fetch(`${hub}/api/ops/jobs/${j.id}`, { method: "DELETE" })).status, 200);
});

test("pause mid-transfer stops the byte counter and resume finishes", async () => {
  mk(A, "pz/p.bin", Buffer.alloc(60 * 1024 * 1024, 2));
  fs.mkdirSync(path.join(B, "pzto"));
  const j = await start({ op: "copy", items: [{ node: "A", path: "/pz/p.bin" }], dst: { node: "B", dir: "/pzto" }, conflict: "ask" });
  await until(j.id, (v) => v.progress.bytes > 0 || finished(v));
  await post(`/api/ops/jobs/${j.id}/pause`);
  await new Promise((r) => setTimeout(r, 150));
  const a = (await get(j.id)).progress.bytes;
  await new Promise((r) => setTimeout(r, 250));
  const b = await get(j.id);
  if (b.state === "paused") {
    assert.equal(b.progress.bytes, a, "no progress while paused");
    assert.equal(b.speed, 0);
  }
  await post(`/api/ops/jobs/${j.id}/resume`);
  const v = await until(j.id, finished, 20000);
  assert.equal(v.state, "done");
  assert.equal(fs.statSync(path.join(B, "pzto/p.bin")).size, 60 * 1024 * 1024);
});

test("sync job: mkdir, copy with overwrite and preserved mtime, trash", async () => {
  mk(A, "sy/new.txt", "fresh");
  mk(A, "sy/old.txt", "left");
  mk(B, "sy2/old.txt", "right");
  mk(B, "sy2/gone.txt", "bye");
  const t = Math.floor(Date.now() / 1000 - 5000) * 1000;
  fs.utimesSync(path.join(A, "sy/old.txt"), new Date(t), new Date(t));
  const v = await until(
    (
      await start({
        op: "sync",
        title: "Sync A:/sy to B:/sy2",
        steps: [
          { kind: "mkdir", node: "B", path: "/sy2/sub" },
          { kind: "copy", src: { node: "A", path: "/sy/new.txt" }, dst: { node: "B", dir: "/sy2/sub" }, bytes: 5 },
          { kind: "copy", src: { node: "A", path: "/sy/old.txt" }, dst: { node: "B", dir: "/sy2" }, bytes: 4 },
          { kind: "trash", node: "B", path: "/sy2/gone.txt" },
        ],
      })
    ).id,
    finished,
  );
  assert.equal(v.state, "done");
  assert.equal(v.title, "Sync A:/sy to B:/sy2");
  assert.equal(rd(B, "sy2/sub/new.txt"), "fresh");
  assert.equal(rd(B, "sy2/old.txt"), "left");
  assert.equal(Math.floor(fs.statSync(path.join(B, "sy2/old.txt")).mtimeMs), t);
  assert.ok(!fs.existsSync(path.join(B, "sy2/gone.txt")));
  assert.equal(v.counts.done, 4);
  assert.equal(v.progress.bytes, 9);
});

test("job list and dismiss", async () => {
  const l = (await (await fetch(`${hub}/api/ops/jobs`)).json()) as { jobs: OpView[] };
  assert.ok(l.jobs.length > 3);
  assert.ok(l.jobs.every((x) => x.items === undefined));
  const done = l.jobs.find((x) => x.state === "done")!;
  assert.equal((await fetch(`${hub}/api/ops/jobs/${done.id}`, { method: "DELETE" })).status, 200);
  assert.equal((await fetch(`${hub}/api/ops/jobs/${done.id}`)).status, 404);
});

// ---------------------------------------------------------------- durable jobs (two hubs on one store)

import { OpQueue, type OpSpec } from "../src/ops-queue.ts";
import type { Target } from "../src/hub.ts";
import { JobStore } from "../src/job-store.ts";

const SECRET = "s3cret-agent-token";
const nap = (ms: number) => new Promise((r) => setTimeout(r, ms));
const jobsDb = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "filedeck-ops-jobs-")), "jobs.sqlite");
const mkq = (f: string, agents: Map<string, Target>, leaseMs = 40) => new OpQueue({ agents, isSource: () => false, shared: { store: new JobStore(f), leaseMs, tickMs: 3_600_000 } });

/** A fake node that counts calls. `hook` may return a promise to hold a call. */
function fake(hook?: (op: string, p: string, n: number) => Promise<void> | void) {
  const calls: string[] = [];
  const seen = new Map<string, number>();
  const t: Target = {
    async fetch(rest, init) {
      const u = new URL("http://x" + rest);
      const p = u.pathname === "/api/fs/stat" ? u.searchParams.get("path")! : "";
      if (u.pathname === "/api/fs/stat") return p.startsWith("/dst/") ? new Response("{}", { status: 404 }) : Response.json({ type: "file", size: 10 });
      const body = JSON.parse((init?.body as string) ?? "{}") as { paths?: string[]; from?: string[]; path?: string };
      const target = body.paths?.[0] ?? body.from?.[0] ?? body.path ?? "";
      const key = u.pathname.split("/").pop() + " " + target;
      calls.push(key);
      const n = (seen.get(key) ?? 0) + 1;
      seen.set(key, n);
      await hook?.(u.pathname.split("/").pop()!, target, n);
      return Response.json({ ok: true });
    },
  };
  return { t, calls };
}
const rm = (n: number): OpSpec => ({ op: "delete", items: Array.from({ length: n }, (_, i) => ({ node: "N", path: `/f${i + 1}` })) });
const done = async (q: OpQueue, id: string, ms = 3000) => {
  for (const t0 = Date.now(); !finished(q.get(id)!); ) {
    if (Date.now() - t0 > ms) assert.fail(`timeout: ${JSON.stringify(q.get(id))}`);
    await nap(10);
  }
  return q.get(id)!;
};

test("delete interrupted after item 2 of 4 resumes at item 3 without re-sending earlier items", async () => {
  const f = jobsDb();
  let q1!: OpQueue;
  const n = fake((_o, p) => void (p === "/f2" && void q1.interrupt()));
  q1 = mkq(f, new Map([["N", n.t]]));
  const id = q1.create(rm(4)).id;
  await nap(150);
  assert.deepEqual(n.calls, ["delete /f1", "delete /f2"]);
  assert.equal(q1.get(id)!.state, "running"); // never recorded as canceled
  const q2 = mkq(f, new Map([["N", n.t]]));
  q2.tick(); // beat is 0: adopted at once
  const v = await done(q2, id);
  assert.equal(v.state, "done");
  assert.deepEqual(n.calls, ["delete /f1", "delete /f2", "delete /f3", "delete /f4"]);
  assert.deepEqual(v.counts, { total: 4, done: 4, skipped: 0, failed: 0 });
  assert.equal(v.items![0]!.label, "N:/f1");
});

test("an in-flight copy is failed, never retried, and the next items still copy; a stale owner stops at its next checkpoint", async () => {
  const f = jobsDb();
  let release!: () => void;
  const hold = new Promise<void>((r) => (release = r));
  const n = fake((o, p, c) => (o === "copy" && p === "/s2" && c === 1 ? hold : undefined));
  const a = mkq(f, new Map([["N", n.t]]));
  const id = a.create({ op: "copy", items: ["/s1", "/s2", "/s3", "/s4"].map((p) => ({ node: "N", path: p })), dst: { node: "N", dir: "/dst" }, conflict: "overwrite" }).id;
  for (const t0 = Date.now(); !n.calls.includes("copy /s2"); ) if (Date.now() - t0 > 3000) assert.fail("no copy"); else await nap(10);
  await nap(60); // a's lease (40 ms) runs out without a tick
  const b = mkq(f, new Map([["N", n.t]]));
  b.tick();
  const v = await done(b, id);
  assert.deepEqual(v.items!.map((i) => i.state), ["done", "failed", "done", "done"]);
  assert.match(v.items![1]!.error!, /Interrupted by a restart; the destination may be incomplete/);
  assert.equal(n.calls.filter((c) => c === "copy /s2").length, 1);
  assert.equal(v.state, "done");
  // the old owner wakes up: it learns it lost the job and sends nothing more
  a.tick();
  release();
  await nap(60);
  assert.equal(n.calls.filter((c) => c === "copy /s3").length, 1);
  assert.equal(a.get(id)!.state, "done"); // read through to the adopter's row
});

test("a sync step in flight at a restart is retried; a trash step that is already gone counts as done", async () => {
  const f = jobsDb();
  let release!: () => void;
  const hold = new Promise<void>((r) => (release = r));
  const n = fake((o, p, c) => (o === "mkdir" && p === "/m" && c === 1 ? hold : o === "trash" && c === 2 ? Promise.reject(new Error("never")) : undefined));
  const spec: OpSpec = { op: "sync", steps: [{ kind: "trash", node: "N", path: "/t" }, { kind: "mkdir", node: "N", path: "/m" }, { kind: "mkdir", node: "N", path: "/m2" }] };
  const a = mkq(f, new Map([["N", n.t]]));
  const id = a.create(spec).id;
  for (const t0 = Date.now(); !n.calls.includes("mkdir /m"); ) if (Date.now() - t0 > 3000) assert.fail("no mkdir"); else await nap(10);
  await nap(60);
  const b = mkq(f, new Map([["N", n.t]]));
  b.tick();
  const v = await done(b, id);
  assert.equal(v.state, "done");
  assert.deepEqual(n.calls, ["trash /t", "mkdir /m", "mkdir /m", "mkdir /m2"]);
  release();
});

test("paused stays paused after adoption; the other hub can resume it", async () => {
  const f = jobsDb();
  const n = fake();
  const a = mkq(f, new Map([["N", n.t]]));
  const id = a.create(rm(2)).id;
  a.pause(id);
  await a.interrupt();
  const b = mkq(f, new Map([["N", n.t]]));
  b.tick();
  await nap(60);
  assert.equal(b.get(id)!.state, "paused");
  assert.equal(n.calls.length, 0);
  b.resume(id);
  assert.equal((await done(b, id)).state, "done");
  assert.equal(n.calls.length, 2);
});

test("the other hub reads, pauses and cancels a job it does not own; the database holds no tokens", async () => {
  const f = jobsDb();
  let release!: () => void;
  const hold = new Promise<void>((r) => (release = r));
  const n = fake((_o, p) => (p === "/f1" ? hold : undefined));
  const a = new OpQueue({ agents: new Map([["N", { fetch: (r, i) => n.t.fetch(r, { ...i, headers: { authorization: `Bearer ${SECRET}` } }) }]]), isSource: () => false, shared: { store: new JobStore(f), leaseMs: 10_000, tickMs: 3_600_000 } });
  const b = mkq(f, new Map([["N", n.t]]), 10_000);
  const id = a.create(rm(3)).id;
  await nap(30);
  assert.equal(b.get(id)!.items!.length, 3);
  assert.deepEqual(b.list().map((j) => j.id), [id]);
  b.pause(id);
  a.tick();
  assert.equal(a.get(id)!.state, "paused");
  b.cancel(id);
  a.tick();
  release();
  assert.equal((await done(a, id)).state, "canceled");
  assert.equal(b.get(id)!.state, "canceled");
  for (const x of fs.readdirSync(path.dirname(f))) assert.ok(!fs.readFileSync(path.join(path.dirname(f), x)).includes(SECRET), x);
});
