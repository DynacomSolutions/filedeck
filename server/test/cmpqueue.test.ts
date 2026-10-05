import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { getEventListeners } from "node:events";
import type { AddressInfo } from "node:net";
import { Hono } from "hono";
import { Jobs } from "../src/jobs.ts";
import { agentSource, registerHubDiff } from "../src/diff-hub.ts";
import type { Target } from "../src/hub.ts";

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "filedeck-cq-")));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (f: () => boolean | Promise<boolean>, ms = 5000) => {
  const end = Date.now() + ms;
  while (!(await f())) {
    if (Date.now() > end) throw new Error("timed out");
    await wait(10);
  }
};

/** a job that holds its slot until released or cancelled */
const hold = () => {
  let release!: () => void;
  const p = new Promise<void>((r) => (release = r));
  return { release, run: (c: { signal: AbortSignal }) => new Promise<string>((res, rej) => (c.signal.addEventListener("abort", () => rej(new Error("canceled")), { once: true }), void p.then(() => res("ok")))) };
};

test("a small job starts beside long ones once they count as big, and shows what it waits behind", async () => {
  const jobs = new Jobs(2, 20, undefined, { isBig: (j) => j.startedAt !== undefined && Date.now() - j.startedAt > 60, maxTotal: 4, checkMs: 20 });
  const a = hold();
  const b = hold();
  const s = hold();
  const ja = jobs.create("c", "big A", a.run);
  const jb = jobs.create("c", "big B", b.run);
  const js = jobs.create("c", "small", s.run);
  assert.equal(js.state, "queued");
  assert.deepEqual(js.queue?.ahead.map((x) => x.title), ["big A", "big B"]);
  assert.equal(js.queue?.position, 2);
  await until(() => jobs.get(js.id)?.state === "running");
  assert.equal(jobs.get(ja.id)?.state, "running");
  assert.equal(jobs.get(jb.id)?.state, "running");
  assert.equal(jobs.get(js.id)?.queue, undefined);
  s.release();
  await until(() => jobs.get(js.id)?.state === "done");
  a.release();
  b.release();
  await until(() => jobs.active === 0);
});

test("total running jobs stay bounded by maxTotal, and queued ones can be cancelled", async () => {
  const jobs = new Jobs(2, 20, undefined, { isBig: () => true, maxTotal: 3, checkMs: 20 });
  const hs = [hold(), hold(), hold(), hold()];
  const js = hs.map((h, i) => jobs.create("c", `j${i}`, h.run));
  await wait(150);
  assert.equal(jobs.list().filter((j) => j.state === "running").length, 3);
  assert.equal(jobs.get(js[3]!.id)?.state, "queued");
  jobs.cancel(js[3]!.id);
  assert.equal(jobs.get(js[3]!.id)?.state, "canceled");
  hs.forEach((h) => h.release());
  await until(() => jobs.active === 0);
});

test("without lanes the queue stays plain FIFO with the given concurrency", async () => {
  const jobs = new Jobs(1);
  const a = hold();
  const b = hold();
  jobs.create("c", "a", a.run);
  const jb = jobs.create("c", "b", b.run);
  await wait(100);
  assert.equal(jobs.get(jb.id)?.state, "queued");
  a.release();
  await until(() => jobs.get(jb.id)?.state === "running");
  b.release();
  await until(() => jobs.active === 0);
});

test("abort listeners on the job signal stay flat over many agent requests", async () => {
  const srv = http.createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(req.url?.startsWith("/api/fs/hash") ? '{"sha256":"abc"}' : '{"entries":[]}');
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  try {
    const target: Target = { fetch: (rest, init) => fetch(base + rest, init) };
    const src = agentSource(target, "/", "left");
    const job = new AbortController();
    const count = () => getEventListeners(job.signal, "abort").length;
    for (let round = 0; round < 10; round++) {
      await Promise.all(Array.from({ length: 50 }, (_, i) => (i % 2 ? src.hash(`f${i}`, job.signal) : src.list(`d${i}`, job.signal))));
      assert.ok(count() <= 1, `round ${round}: ${count()} listeners`);
    }
    assert.equal(count(), 0); // nothing in flight, nothing left behind
    // cancelling the job still reaches a request in flight
    const slow = http.createServer(() => undefined);
    await new Promise<void>((r) => slow.listen(0, "127.0.0.1", r));
    const hung = agentSource({ fetch: (rest, init) => fetch(`http://127.0.0.1:${(slow.address() as AddressInfo).port}` + rest, init) }, "/", "left");
    const p = hung.hash("x", job.signal);
    await wait(50);
    job.abort();
    await assert.rejects(p);
    slow.closeAllConnections();
    slow.close();
  } finally {
    srv.closeAllConnections();
    srv.close();
  }
});

test("a compare nobody reads is cancelled and its session file removed after the grace period", async () => {
  const diffDir = path.join(tmp, "diff");
  // an agent whose root listing hangs until the request is aborted: the compare stays running
  const hang: Target = {
    fetch: (rest, init) =>
      rest.startsWith("/api/fs/lsdir")
        ? new Promise<Response>((_res, rej) => init?.signal?.addEventListener("abort", () => rej(new DOMException("aborted", "AbortError")), { once: true }))
        : Promise.resolve(Response.json({ seq: 0, dirs: [], reset: false })),
  };
  const quick: Target = { fetch: () => Promise.resolve(Response.json({ entries: [], seq: 0, dirs: [], reset: false })) };
  const app = new Hono();
  registerHubDiff(app, new Map([["hang", hang], ["quick", quick]]), diffDir, { graceMs: 400 });
  const post = async (node: string) =>
    (await (await app.request("/api/diff/jobs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ left: { node, path: "/a" }, right: { node, path: "/b" } }) })).json()) as { id: string };
  const get = (id: string) => app.request(`/api/diff/jobs/${id}`);
  const dbs = () => fs.readdirSync(diffDir).filter((f) => f.endsWith(".db"));

  const stuck = await post("hang");
  const done = await post("quick");
  assert.equal(dbs().length, 2);
  // a client that keeps reading keeps its compare alive well past the grace period
  for (let i = 0; i < 12; i++) {
    assert.equal((await get(done.id)).status, 200);
    await wait(100);
  }
  assert.equal((await get(done.id)).status, 200);
  // the one nobody read is gone, its job cancelled and its file removed
  await until(async () => (await get(stuck.id)).status === 404, 4000);
  await until(() => dbs().length === 1, 2000);
  // stop reading: the other goes too, and a reopened page simply starts a new compare
  await until(async () => (await get(done.id)).status === 404 || false, 4000).catch(() => undefined);
  await until(() => dbs().length === 0, 4000);
  const again = await post("quick");
  assert.notEqual(again.id, done.id);
  assert.equal((await get(again.id)).status, 200);
});
