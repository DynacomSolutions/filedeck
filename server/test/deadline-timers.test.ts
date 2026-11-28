import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Deadline } from "../src/deadline.ts";
import { IndexCache } from "../src/index-cache.ts";
import { PushStore } from "../src/push/store.ts";
import { PushWatch, type SourcedJob } from "../src/push/watch.ts";
import { CompareSession } from "../src/cmp-engine.ts";
import { DEFAULT_OPTIONS, localSource } from "../src/folderdiff.ts";
import { createAgent } from "../src/agent.ts";
import { loadConfig } from "../src/config.ts";
import * as ops from "../src/fsops.ts";
import { TRASH_DIR } from "../src/paths.ts";
import { withoutReadOnly } from "../src/pinwalk.ts";
import { trackTimers } from "./timer-probe.ts";

const work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "filedeck-deadline-")));
after(() => fs.rmSync(work, { recursive: true, force: true }));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (f: () => boolean, ms = 5000) => {
  for (const t0 = Date.now(); !f() && Date.now() - t0 < ms; ) await sleep(10);
};

test("deadline: one timer for the earliest time, none once it has fired or been cleared", async () => {
  const probe = trackTimers();
  try {
    let fired = 0;
    const d = new Deadline(() => fired++);
    assert.equal(probe.active(), 0);
    d.arm(Date.now() + 10_000);
    d.arm(Date.now() + 20_000);
    assert.equal(probe.active(), 1, "a later time does not add a timer");
    d.arm(Date.now() + 30);
    assert.equal(probe.active(), 1, "an earlier time replaces the timer");
    await until(() => fired === 1);
    assert.equal(fired, 1);
    assert.equal(probe.active(), 0, "fired: nothing pending");
    assert.equal(d.due, undefined);
    d.set(Date.now() + 10_000);
    assert.equal(probe.active(), 1);
    d.set(undefined);
    assert.equal(probe.active(), 0, "no item left: no timer");
    d.set(Date.now() + 10_000);
    d.clear();
    assert.equal(probe.active(), 0);
    assert.equal(fired, 1);
  } finally {
    probe.restore();
  }
});

test("trash retention: a timer waits for the oldest item's age limit and is gone when the trash is empty", async () => {
  const root = path.join(work, "trash-root");
  fs.mkdirSync(root);
  const app = createAgent(loadConfig({ FILEDECK_ROOT: root, FILEDECK_NODE: "t", FILEDECK_TRASH_MAX_AGE_DAYS: "7", FILEDECK_TRASH_SWEEP_MS: "50" } as never));
  const sweep = (app as unknown as { sweepTrash: () => Promise<void> }).sweepTrash;
  const probe = trackTimers();
  try {
    await sleep(150); // (the first sweep timer made before the probe started has fired by now)
    await sweep();
    const base = probe.active();
    fs.writeFileSync(path.join(root, "a.txt"), "x");
    const a = await withoutReadOnly(() => ops.trash(root, "/a.txt"));
    assert.equal(probe.active(), base + 1, "an item in the trash arms one timer for its age limit");
    fs.writeFileSync(path.join(root, "b.txt"), "x");
    await withoutReadOnly(() => ops.trash(root, "/b.txt"));
    assert.equal(probe.active(), base + 1, "a second item shares it");
    // the first item is 8 days old: the sweep removes it, and the timer moves to the second item
    const meta = path.join(root, TRASH_DIR, a.id, "meta.json");
    fs.writeFileSync(meta, JSON.stringify({ ...JSON.parse(fs.readFileSync(meta, "utf8")), deletedAt: Date.now() - 8 * 86_400_000 }));
    await sweep();
    assert.equal(fs.existsSync(path.join(root, TRASH_DIR, a.id)), false, "the old item was purged");
    assert.equal(probe.active(), base + 1, "one item is left: one timer");
    for (const d of fs.readdirSync(path.join(root, TRASH_DIR))) fs.rmSync(path.join(root, TRASH_DIR, d), { recursive: true, force: true });
    await sweep();
    assert.equal(probe.active(), base, "the trash is empty: no timer");
  } finally {
    await (app as unknown as { close: () => Promise<void> }).close();
    probe.restore();
  }
});

test("index cache: no timer for an empty index, a write arms the trim, close clears everything", async () => {
  const probe = trackTimers();
  try {
    const dir = path.join(work, "ix");
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, "a.txt"), "a");
    const ix = new IndexCache(":memory:", {
      readDir: async (d: string) => fs.readdirSync(d, { withFileTypes: true }).map((e) => ({ n: e.name, t: e.isDirectory() ? "dir" : "file", s: 1, m: 1, i: 1 }) as never),
      statDir: async (d: string) => ({ ino: fs.statSync(d).ino, mtime: fs.statSync(d).mtimeMs }),
    } as never);
    assert.equal(probe.active(), 0, "an empty index holds no timer");
    await ix.list(dir);
    assert.equal(probe.active(), 1, "the first rows arm one trim timer");
    ix.close();
    assert.equal(probe.active(), 0);
  } finally {
    probe.restore();
  }
});

test("push watch: no timer while no job runs; a job event starts passes that stop when the job ends", async () => {
  const probe = trackTimers();
  try {
    const store = new PushStore(":memory:");
    store.add({ endpoint: "https://fcm.googleapis.com/fcm/send/e1", p256dh: "p", auth: "a", owner: "", session: null });
    let jobs: SourcedJob[] = [];
    let listed = 0;
    const w = new PushWatch({ store, subject: "https://example.test", signIn: false, identityOf: () => undefined, listJobs: async () => (listed++, jobs), send: async () => 201, log: () => undefined });
    w.start(30);
    await until(() => listed === 1);
    await until(() => probe.active() === 0);
    assert.equal(probe.active(), 0, "the start pass saw no running job: no timer");
    jobs = [{ source: "ops", id: "j", title: "Copy", state: "running" }];
    w.poke();
    await until(() => listed >= 4);
    assert.ok(listed >= 4, "it keeps looking while a job runs");
    assert.equal(probe.active() > 0, true);
    jobs = [{ source: "ops", id: "j", title: "Copy", state: "done", finishedAt: Date.now() }];
    await until(() => probe.active() === 0);
    assert.equal(probe.active(), 0, "the job ended: the watch stopped");
    const n = listed;
    await sleep(120);
    assert.equal(listed, n, "and it stays still");
    await w.stop();
    store.close();
  } finally {
    probe.restore();
  }
});

test("compare live: a source that holds its answers is followed with no poll timer, and a change still arrives at once", async () => {
  const probe = trackTimers();
  const root = path.join(work, "cmp");
  for (const side of ["L", "R"]) {
    fs.mkdirSync(path.join(root, side), { recursive: true });
    fs.writeFileSync(path.join(root, side, "f.txt"), "same");
  }
  let wake: (() => void) | undefined;
  let seq = 0;
  const dirs: string[] = [];
  let polls = 0;
  const held = (src: ReturnType<typeof localSource>, feeds: boolean) => ({
    ...src,
    changes: (since: number, signal: AbortSignal, holdMs?: number) =>
      new Promise<{ seq: number; dirs: string[]; reset: boolean; held: boolean }>((resolve) => {
        polls++;
        const done = () => resolve({ seq: ++seq, dirs: feeds ? dirs.splice(0) : [], reset: false, held: true });
        if (!holdMs || (feeds && dirs.length)) return done();
        if (feeds) wake = done;
        signal.addEventListener("abort", () => resolve({ seq, dirs: [], reset: false, held: true }), { once: true });
      }),
  });
  const sess = new CompareSession(held(localSource(path.join(root, "L"), "/"), true), held(localSource(path.join(root, "R"), "/"), false), { ...DEFAULT_OPTIONS, mode: "content" });
  try {
    await sess.run(new AbortController().signal);
    const before = probe.active();
    sess.startLive(30, 60_000);
    await until(() => polls >= 4); // both baselines, then one held request for each side
    await sleep(100);
    const parked = polls;
    assert.equal(probe.active(), before, "two held requests wait and no poll timer exists");
    await sleep(150);
    assert.equal(polls, parked, "nothing asks again while nothing changes");
    dirs.push("");
    wake?.();
    await until(() => polls > parked);
    assert.ok(polls > parked, "a change ended the hold and the next request went out at once");
  } finally {
    sess.close();
    probe.restore();
  }
});

test("diff hub: an idle compare has one deadline timer, and none after it was dismissed", async () => {
  const { Hono } = await import("hono");
  const { registerHubDiff } = await import("../src/diff-hub.ts");
  const probe = trackTimers();
  const app = new Hono();
  const agent = {
    fetch: async (rest: string) => (rest.startsWith("/api/fs/lsdir") ? Response.json({ entries: [] }) : Response.json({ seq: 1, dirs: [], reset: false })),
  };
  const jobs = registerHubDiff(app, new Map([["n", agent]]) as never, "", { graceMs: 200 });
  try {
    assert.equal(probe.active(), 0, "no compare: no timer");
    const r = await app.request("/api/diff/jobs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ left: { node: "n", path: "/a" }, right: { node: "n", path: "/b" } }) });
    assert.equal(r.status, 202, await r.clone().text());
    assert.equal(probe.active() > 0, true, "a compare arms the deadline");
    await until(() => jobs.list().length === 0, 4000);
    assert.equal(jobs.list().length, 0, "nobody read it: dismissed after the grace time");
    const sess = probe.active();
    await sleep(100);
    assert.equal(probe.active(), sess);
  } finally {
    probe.restore();
  }
});

test("agent index-changes: with wait= the answer is held until a watched folder changes, and says held", async () => {
  const root = path.join(work, "held");
  fs.mkdirSync(path.join(root, "d"), { recursive: true });
  const app = createAgent(loadConfig({ FILEDECK_ROOT: root, FILEDECK_NODE: "t" } as never));
  try {
    const lsdir = await app.request("/api/fs/lsdir?path=/d"); // the index watches the folder from now on
    assert.equal(lsdir.status, 200);
    const base = (await (await app.request("/api/fs/index-changes?since=0")).json()) as { seq: number; held?: boolean };
    assert.equal(base.held, undefined, "no wait asked: answered at once, not held");
    const t0 = Date.now();
    const held = app.request(`/api/fs/index-changes?since=${base.seq}&wait=10`);
    await sleep(100);
    fs.writeFileSync(path.join(root, "d", "new.txt"), "x");
    const j = (await (await held).json()) as { dirs: string[]; held?: boolean };
    assert.ok(Date.now() - t0 < 5000, "ended by the change, not by the wait");
    assert.equal(j.held, true);
    assert.deepEqual(j.dirs, ["/d"]);
  } finally {
    await (app as unknown as { close: () => Promise<void> }).close();
  }
});
