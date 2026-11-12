import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { loadConfig } from "../src/config.ts";
import { createAgent, SizeStore, tmp, at, sleep, mk, rows, agrees, makeTreeA } from "./size-store-support.ts";

before(() => makeTreeA());

// ---- review fixes ----

test("du sees a change deep in the tree at once (no stale shortcut)", async () => {
  fs.mkdirSync(at("d1/sub/deep"), { recursive: true });
  fs.writeFileSync(at("d1/sub/deep/f"), "1");
  const app = createAgent(loadConfig({ FILEDECK_ROOT: tmp, FILEDECK_NODE: "t" } as never));
  type Du = { cached: boolean; entries: { bytes: number }[] };
  const du = async (q = "") => (await (await app.request("/api/du?path=/d1&depth=0" + q)).json()) as Du;
  assert.equal((await du()).entries[0]!.bytes, 1);
  assert.equal((await du()).cached, true);
  await sleep(30);
  fs.writeFileSync(at("d1/sub/deep/big"), "x".repeat(100_000));
  const after = await du();
  assert.equal(after.entries[0]!.bytes, 100_001);
  assert.equal(after.cached, false);
  // in place edit: no folder mtime changes, so only the exact size job sees it
  fs.appendFileSync(at("d1/sub/deep/f"), "22");
  const size = async () => {
    let j = (await (await app.request("/api/jobs/size", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: "/d1", fresh: true }) })).json()) as { id: string; state: string; result?: { bytes: number } };
    for (let i = 0; i < 200 && (j.state === "queued" || j.state === "running"); i++) {
      await sleep(20);
      j = (await (await app.request(`/api/jobs/${j.id}`)).json()) as typeof j;
    }
    return j.result!.bytes;
  };
  assert.equal(await size(), 100_003);
});

test("a long scan answers 202 with a job id, which keeps running; repeating the request answers from the store", async () => {
  const app = createAgent(loadConfig({ FILEDECK_ROOT: tmp, FILEDECK_NODE: "t", FILEDECK_DU_WAIT_MS: "0" } as never));
  const r = await app.request("/api/du?path=/d1&depth=0");
  assert.equal(r.status, 202);
  const { jobId } = (await r.json()) as { jobId: string };
  let j = (await (await app.request(`/api/jobs/${jobId}`)).json()) as { state: string };
  for (let i = 0; i < 200 && j.state !== "done"; i++) {
    await sleep(20);
    j = (await (await app.request(`/api/jobs/${jobId}`)).json()) as { state: string };
  }
  assert.equal(j.state, "done");
  const again = await app.request("/api/du?path=/d1&depth=0");
  assert.equal(again.status, 200);
  assert.equal(((await again.json()) as { cached: boolean }).cached, true);
});

test("a mount point scanned on its own does not leak into its parent's totals or get deleted by a parent scan", async () => {
  fs.mkdirSync(at("m/mnt/d/x"), { recursive: true });
  fs.writeFileSync(at("m/mnt/top"), "12");
  fs.writeFileSync(at("m/mnt/d/x/f"), "1".repeat(100));
  const mroot = at("m");
  const [l, st] = [fsp.lstat, fsp.stat];
  const fake = (fn: (...a: never[]) => Promise<fs.Stats>) => async (p: string, ...a: never[]) => {
    const s = await fn(p as never, ...a);
    if (String(p).startsWith(mroot + "/mnt/d")) Object.defineProperty(s, "dev", { value: s.dev + 1 });
    return s;
  };
  (fsp as { lstat: unknown }).lstat = fake(l as never);
  (fsp as { stat: unknown }).stat = fake(st as never);
  try {
    const s = new SizeStore(":memory:", { root: mroot, ttlMs: 60_000, maxEntries: 100_000 });
    await s.scan("/mnt");
    await s.scan("/mnt/d");
    await sleep(30);
    fs.writeFileSync(at("m/mnt/d/x/g"), "1".repeat(5000));
    await s.scan("/mnt/d", undefined, true);
    const top = (await s.tree("/mnt", 1, false)).entries;
    assert.deepEqual(top.map((e) => `${e.path}=${e.bytes}`), ["/mnt=2"]);
    assert.equal((await s.tree("/mnt/d", 0, false)).entries[0]!.bytes, 5100);
    await s.scan("/mnt", undefined, true);
    assert.equal((await s.tree("/mnt/d", 0, false)).entries.length, 1);
    assert.equal((await s.tree("/mnt", 0, false)).entries[0]!.bytes, 2);
    s.close();
  } finally {
    (fsp as { lstat: unknown }).lstat = l;
    (fsp as { stat: unknown }).stat = st;
  }
});

test("inode numbers above 2^53 are stored and a second scan works", async () => {
  fs.mkdirSync(at("ino/s"), { recursive: true });
  const [l, st] = [fsp.lstat, fsp.stat];
  const big = (fn: (...a: never[]) => Promise<fs.Stats>) => async (p: string, ...a: never[]) => {
    const s = await fn(p as never, ...a);
    if (String(p).startsWith(at("ino"))) Object.defineProperty(s, "ino", { value: Number(2n ** 62n) });
    return s;
  };
  (fsp as { lstat: unknown }).lstat = big(l as never);
  (fsp as { stat: unknown }).stat = big(st as never);
  try {
    const s = mk();
    await s.scan("/ino");
    assert.equal((await s.scanRead("/ino")).read, 0);
    s.close();
  } finally {
    (fsp as { lstat: unknown }).lstat = l;
    (fsp as { stat: unknown }).stat = st;
  }
});

test("a folder with 150k stored children can be listed", async () => {
  const s = mk(60_000, 1_000_000);
  const db = s as unknown as { put(r: unknown): void; db: { exec(q: string): void } };
  const own = { bytes: 0, disk: 0, files: 0, symlinks: 0, other: 0, dirs: 0, mounts: 0, errors: 0 };
  const row = (p: string, parent: string) => ({ path: p, parent, ino: 1, dev: 1, mtime_ms: 1, scanned_at: 1, seen_at: 1, ver: 1, own, tot: own });
  db.db.exec("BEGIN");
  db.put(row("/big", "/"));
  for (let i = 0; i < 150_000; i++) db.put(row(`/big/${i}`, "/big"));
  db.db.exec("COMMIT");
  assert.equal((await s.tree("/big", 1, false)).entries.length, 150_001);
  s.close();
});

test("scans of unrelated folders do not wait for each other, overlapping ones do", async () => {
  const s = mk();
  const rel = await s.lock("/x/a");
  const order: string[] = [];
  const other = s.lock("/x/b").then((r) => (order.push("b"), r()));
  const inner = s.lock("/x/a/c").then((r) => (order.push("c"), r()));
  const whole = s.lock("/").then((r) => (order.push("root"), r()));
  await other;
  assert.deepEqual(order, ["b"]);
  rel();
  await Promise.all([inner, whole]);
  assert.deepEqual(order.slice(0, 2).sort(), ["b", "c"].sort());
  assert.equal(order[2], "root");
  s.close();
});

test("overlapping locks are granted in arrival order, so repeated child locks cannot starve a parent", async () => {
  const s = mk();
  let rel = await s.lock("/x/a");
  let got = false;
  const parent = s.lock("/x").then((r) => ((got = true), r()));
  rel();
  let n = 0;
  for (; n < 20 && !got; n++) {
    rel = await s.lock("/x/a"); // the watcher takes the child lock again right away
    rel();
  }
  assert.ok(got && n <= 1, `parent granted only after ${n} child locks`);
  await parent;
  s.close();
});

test("aborting a waiting lock lets later waiters proceed", async () => {
  const s = mk();
  const rel = await s.lock("/x/a");
  const ac = new AbortController();
  const mid = s.lock("/x", ac.signal);
  const last = s.lock("/x/a/b");
  ac.abort();
  await assert.rejects(mid, /canceled/);
  rel();
  (await last)();
  assert.equal((s as any).held.length, 0);
  s.close();
});

test("a job canceled while queued runs its onDrop", async () => {
  const { Jobs } = await import("../src/jobs.ts");
  const jobs = new Jobs(1);
  let gate!: () => void;
  jobs.create("t", "blocker", () => new Promise<void>((r) => (gate = r)));
  let dropped = 0;
  const q = jobs.create("t", "queued", async () => undefined, () => dropped++);
  jobs.cancel(q.id);
  assert.equal(dropped, 1);
  gate();
});

test("applyChanged: a folder deleted and recreated under the same name is not trusted", async () => {
  fs.mkdirSync(at("rc/x/y"), { recursive: true });
  fs.writeFileSync(at("rc/x/y/f"), "1".repeat(1000));
  const s = mk();
  await s.scan("/rc");
  // built beside the old one so it gets another inode (a freed inode number may be handed out again)
  fs.mkdirSync(at("rc/x2"));
  fs.writeFileSync(at("rc/x2/g"), "2");
  fs.rmSync(at("rc/x"), { recursive: true });
  fs.renameSync(at("rc/x2"), at("rc/x"));
  await s.applyChanged("/rc");
  assert.equal((await s.tree("/rc", 0, false)).entries[0]!.bytes, 1);
  await agrees(s, "/rc");
  s.close();
});

test("scan of a folder that was removed trims its rows and its parent", async () => {
  fs.mkdirSync(at("gone/p/q"), { recursive: true });
  fs.writeFileSync(at("gone/p/q/f"), "1234");
  const s = mk();
  await s.scan("/gone");
  await s.scan("/gone/p/q", undefined, true);
  fs.rmSync(at("gone/p/q"), { recursive: true });
  await assert.rejects(() => s.scan("/gone/p/q"));
  // the trim runs after the scan ended, climbing one locked level at a time; wait for it
  for (let i = 0; i < 100 && (await s.tree("/gone", 0, false)).entries[0]!.dirs !== 1; i++) {
    (await s.lock("/"))();
    await sleep(10);
  }
  assert.equal((await s.tree("/gone/p/q", 0, false)).entries.length, 0);
  assert.equal((await s.tree("/gone", 0, false)).entries[0]!.bytes, 0);
  assert.equal((await s.tree("/gone", 0, false)).entries[0]!.dirs, 1);
  await agrees(s, "/gone");
  s.close();
});

test("a scan stored in small chunks gives the same totals, and reports live progress", async () => {
  const s = mk(60_000, 100_000, 2);
  const ctl = { signal: new AbortController().signal, progress: { bytes: 0, totalBytes: 0, entries: 0, totalEntries: 0, current: "" } };
  const r = await s.scan("/a", ctl, true);
  assert.equal(ctl.progress.bytes, r.bytes);
  assert.ok(ctl.progress.entries > 0);
  await agrees(s, "/a");
  fs.writeFileSync(at("a/sub/chunk"), "abc");
  await s.applyChanged("/a/sub");
  await agrees(s, "/a");
  s.close();
});
