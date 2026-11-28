import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { EventBus } from "../src/events/bus.ts";
import { Filter } from "../src/events/filter.ts";
import { DEFAULT_THRESHOLDS, PressureWatcher, levelOf, parseLevels, registerFsPressureRoutes, type PressureLevelsConfig } from "../src/events/pressure.ts";
import { apiTokenAuth } from "../src/api-token.ts";
import { trackTimers } from "./timer-probe.ts";

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), "fs-pressure-")));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (f: () => boolean, ms = 5000) => {
  for (const t0 = Date.now(); !f() && Date.now() - t0 < ms; ) await sleep(5);
};

const GB = 1024 ** 3;

/** A machine with two filesystems: `/` (id 1) and `/data` (id 2). The free space of each is a number the test sets. */
function machine(levels = `{"default":{"reserveFreePercent":20,"criticalFreePercent":10},"filesystems":[{"path":"/data","growthBytes":${5 * GB},"growthWindowSec":600}]}`) {
  const root = fs.mkdtempSync(path.join(tmp, "m-"));
  fs.mkdirSync(path.join(root, "data"));
  const mounts = path.join(root, "mounts");
  fs.writeFileSync(mounts, "/dev/sda1 / ext4 rw 0 0\n/dev/sdb1 /data ext4 rw 0 0\n/dev/sdc1 /data/sub ext4 rw 0 0\nproc /proc proc rw 0 0\nserver:/x /mnt/nfs nfs rw 0 0\n");
  const free = new Map<string, number>([["/", 50 * GB], ["/data", 50 * GB]]);
  const calls: string[] = [];
  const clock = { t: 1_000_000 };
  const published: Record<string, unknown>[] = [];
  const handlers = new Set<(e: never) => void>();
  const bus = {
    ready: true,
    listen: (f: (e: never) => void) => (handlers.add(f), () => void handlers.delete(f)),
    publish: (e: Record<string, unknown>) => void published.push(e),
  };
  const w = new PressureWatcher({
    root,
    procMounts: mounts,
    config: parseLevels(levels)!,
    bus: bus as never,
    minGapMs: 40,
    mountsMs: 60_000,
    now: () => clock.t,
    statfs: async (p) => {
      const key = path.relative(root, p) ? "/" + path.relative(root, p) : "/";
      calls.push(key);
      return { blocks: 100 * GB / 4096, bsize: 4096, bavail: (free.get(key) ?? 0) / 4096 };
    },
    devOf: async (p) => (p.endsWith("/data") ? 2 : p.endsWith("/sub") ? 2 : 1),
  });
  const emit = (kind: string, p: string, extra: Record<string, unknown> = {}) => {
    for (const h of handlers) h({ kind, path: p, dir: false, ...extra } as never);
  };
  return { root, free, calls, clock, published, w, emit, handlers };
}

test("levelOf: reserve and critical by percent or bytes, with a 1% margin before the level goes down", () => {
  const t = { ...DEFAULT_THRESHOLDS, reserveFreePercent: 20, criticalFreePercent: 10 };
  const size = 100 * GB;
  assert.equal(levelOf(50 * GB, size, t), "ok");
  assert.equal(levelOf(20 * GB, size, t), "reserve");
  assert.equal(levelOf(10 * GB, size, t), "critical");
  assert.equal(levelOf(10.5 * GB, size, t, "critical"), "critical", "inside the margin: stays");
  assert.equal(levelOf(11.5 * GB, size, t, "critical"), "reserve");
  assert.equal(levelOf(20.5 * GB, size, t, "reserve"), "reserve");
  assert.equal(levelOf(21.5 * GB, size, t, "reserve"), "ok");
  const bytes = { ...DEFAULT_THRESHOLDS, reserveFreePercent: 0, criticalFreePercent: 0, reserveFreeBytes: 30 * GB, criticalFreeBytes: 5 * GB };
  assert.equal(levelOf(29 * GB, size, bytes), "reserve");
  assert.equal(levelOf(4 * GB, size, bytes), "critical");
});

test("parseLevels: empty is off, bad JSON throws, a path outside / is dropped", () => {
  assert.equal(parseLevels(""), undefined);
  assert.throws(() => parseLevels("{nope"));
  const c = parseLevels('{"filesystems":[{"path":"data"},{"path":"/x/","criticalFreePercent":3}]}') as PressureLevelsConfig;
  assert.equal(c.filesystems.length, 1);
  assert.equal(c.filesystems[0]!.path, "/x");
  assert.equal(c.filesystems[0]!.criticalFreePercent, 3);
  assert.equal(c.filesystems[0]!.reserveFreePercent, DEFAULT_THRESHOLDS.reserveFreePercent);
});

test("pressure: no event flow means no timer, no statfs and no event", async () => {
  const probe = trackTimers();
  try {
    const m = machine();
    await sleep(120);
    assert.equal(probe.active(), 0, "idle: no timer");
    assert.equal(m.calls.length, 0, "idle: no statfs");
    assert.equal(m.published.length, 0);
    // a change, then quiet: one sample, one trailing sample at most, then nothing
    m.emit("modify", "/data/a");
    await until(() => m.calls.length >= 1);
    await sleep(150);
    assert.equal(probe.active(), 0, "after the sample: no timer left");
    const n = m.calls.length;
    await sleep(150);
    assert.equal(m.calls.length, n);
    assert.equal(m.published.length, 0, "the level did not change: no event");
    m.w.close();
  } finally {
    probe.restore();
  }
});

test("pressure: a burst of changes is one statfs and one trailing statfs per filesystem", async () => {
  const m = machine();
  m.emit("create", "/data/x"); // loads the mount table, then places the change
  await until(() => m.calls.length === 1);
  assert.deepEqual(m.calls, ["/data"], "the path goes to the longest mount point; the nested mount has the same device and is one filesystem");
  for (let i = 0; i < 200; i++) m.emit("modify", `/data/f${i}`);
  m.emit("close_write", "/other"); // another filesystem: its own first sample
  await until(() => m.calls.length >= 3, 3000);
  await sleep(150);
  assert.deepEqual(m.calls.sort(), ["/", "/data", "/data"], "one first sample for /, one first and one trailing for /data");
  m.w.close();
});

test("pressure: a level change publishes one event with the numbers, a repeat of the same level none", async () => {
  const m = machine();
  const step = async (avail: number, n: number) => {
    m.free.set("/", avail * GB);
    m.clock.t += 100;
    m.emit("delete", "/etc/x");
    await sleep(60);
    await until(() => m.calls.filter((c) => c === "/").length >= n);
    await sleep(10);
  };
  m.emit("delete", "/etc/y");
  await until(() => m.calls.length >= 1);
  await sleep(10);
  assert.equal(m.published.length, 0, "ok at the start: nothing to say");
  await step(18, 2);
  assert.equal(m.published.length, 1);
  assert.deepEqual({ kind: m.published[0]!.kind, path: m.published[0]!.path, level: m.published[0]!.level, availBytes: m.published[0]!.availBytes, sizeBytes: m.published[0]!.sizeBytes }, { kind: "pressure", path: "/", level: "reserve", availBytes: 18 * GB, sizeBytes: 100 * GB });
  await step(17, 3);
  assert.equal(m.published.length, 1, "still reserve: no new event");
  await step(8, 4);
  assert.equal(m.published.length, 2);
  assert.equal(m.published[1]!.level, "critical");
  await step(60, 5);
  assert.equal(m.published.length, 3);
  assert.equal(m.published[2]!.level, "ok");
  m.w.close();
});

test("pressure: a growth breach publishes once, with the loss of the last hour", async () => {
  const m = machine();
  m.emit("create", "/data/a");
  await until(() => m.calls.length >= 1);
  assert.equal(m.published.length, 0);
  m.free.set("/data", 40 * GB); // 10 GB lost, over the 5 GB limit of /data, level still ok
  m.clock.t += 120_000;
  m.emit("modify", "/data/a");
  await until(() => m.published.length >= 1);
  assert.equal(m.published.length, 1);
  const e = m.published[0]!;
  assert.equal(e.level, "ok");
  assert.equal(e.loss1h, 10 * GB);
  assert.match(String(e.reason), /^growth/);
  m.free.set("/data", 39 * GB);
  m.clock.t += 120_000;
  m.emit("modify", "/data/a");
  await sleep(120);
  assert.equal(m.published.length, 1, "the breach goes on: no second event");
  m.w.close();
});

test("pressure: a reset on the bus publishes the current level of every filesystem again", async () => {
  const m = machine();
  m.free.set("/", 15 * GB);
  m.emit("modify", "/x");
  await until(() => m.published.length >= 1);
  await sleep(60);
  const before = m.published.length;
  m.emit("reset", "", { path: undefined });
  await until(() => m.published.length >= before + 2);
  const replayed = m.published.slice(before);
  assert.deepEqual(replayed.map((e) => [e.path, e.level]).sort(), [["/", "reserve"], ["/data", "ok"]]);
  assert.ok(replayed.every((e) => /replayed/.test(String(e.reason))));
  m.w.close();
});

test("pressure: current() reads every filesystem once and keeps no timer", async () => {
  const probe = trackTimers();
  try {
    const m = machine();
    m.free.set("/data", 5 * GB);
    const list = await m.w.current();
    assert.deepEqual(list.map((f) => [f.path, f.level]), [["/", "ok"], ["/data", "critical"]]);
    assert.equal(m.calls.length, 2);
    assert.equal(probe.active(), 0);
    m.w.close();
  } finally {
    probe.restore();
  }
});

test("pressure event on the bus: kind=pressure passes the filter, the line carries the fields, other filters can refuse it", async () => {
  const bus = new EventBus({ node: "n1", journal: { dir: null } });
  try {
    const sub = await bus.subscribe(new Filter({ kind: ["pressure"] }), undefined, "internal");
    const other = await bus.subscribe(new Filter({ kind: ["create"] }), undefined, "internal");
    bus.publish({ kind: "create", path: "/a" });
    bus.publish({ kind: "pressure", dir: true, path: "/data", level: "reserve", availBytes: 1, sizeBytes: 10, loss1h: 2, loss6h: 3, reason: "level reserve" });
    const lines: Record<string, unknown>[] = [];
    for (let i = 0; i < 3 && !lines.some((l) => l.kind === "pressure"); i++) {
      const b = await Promise.race([sub.next(), sleep(2000).then(() => null)]);
      for (const l of b ?? []) lines.push(JSON.parse(l.toString("utf8")));
    }
    const p = lines.find((l) => l.kind === "pressure")!;
    assert.deepEqual({ path: p.path, level: p.level, availBytes: p.availBytes, sizeBytes: p.sizeBytes, loss1h: p.loss1h, loss6h: p.loss6h }, { path: "/data", level: "reserve", availBytes: 1, sizeBytes: 10, loss1h: 2, loss6h: 3 });
    assert.ok(!lines.some((l) => l.kind === "create"), "the kind filter keeps the create event out");
    const o = await Promise.race([other.next(), sleep(500).then(() => null)]);
    assert.ok(!(o ?? []).some((l) => JSON.parse(l.toString("utf8")).kind === "pressure"), "a subscriber for create gets no pressure event");
    sub.close();
    other.close();
  } finally {
    await bus.close();
  }
});

test("GET /api/v1/pressure: the level of each filesystem, one statfs each", async () => {
  const m = machine();
  const app = new Hono();
  registerFsPressureRoutes(app, "n1", m.w);
  m.free.set("/", 12 * GB);
  const res = await app.request("/api/v1/pressure");
  assert.equal(res.status, 200);
  const j = (await res.json()) as { node: string; filesystems: { path: string; level: string; availBytes: number; sizeBytes: number; freePercent: number }[] };
  assert.equal(j.node, "n1");
  assert.deepEqual(j.filesystems.map((f) => [f.path, f.level, f.freePercent]), [["/", "reserve", 12], ["/data", "ok", 50]]);
  m.w.close();
});

test("token scopes: `changes` reads the filesystem levels, `disk-pressure` reads the disk routes, neither reads the other, a ServiceAccount reads neither", async () => {
  const mk = (scopes: string[]) => {
    const a = new Hono();
    a.use("*", apiTokenAuth("tok", undefined, scopes));
    a.all("*", (c) => c.text("ok"));
    return a;
  };
  const get = (a: Hono, p: string) => Promise.resolve(a.request(p, { headers: { "x-filedeck-token": "tok" } })).then((r) => r.status);
  const changes = mk(["changes"]);
  assert.equal(await get(changes, "/api/nodes/a/api/v1/pressure"), 200);
  assert.equal(await get(changes, "/api/nodes/a/api/v1/changes"), 200);
  assert.equal(await get(changes, "/api/nodes/a/api/v1/disk-pressure"), 403);
  assert.equal(await get(changes, "/api/v1/disk-pressure"), 403);
  const dp = mk(["disk-pressure"]);
  for (const p of ["/api/v1/disk-pressure?node=a", "/api/v1/disk-pressure/stream", "/api/v1/disk-pressure/nodes", "/api/nodes/a/api/v1/disk-pressure", "/api/nodes/a/api/v1/disk-pressure/stream"]) assert.equal(await get(dp, p), 200, p);
  assert.equal(await get(dp, "/api/nodes/a/api/v1/pressure"), 403);
  assert.equal(await get(dp, "/api/nodes/a/api/v1/changes"), 403);
  assert.equal(await get(dp, "/api/nodes/a/api/du"), 403);
  assert.equal((await dp.request("/api/v1/disk-pressure", { method: "POST", headers: { "x-filedeck-token": "tok" } })).status, 403, "read only");
  // a ServiceAccount token reads folder sizes only
  const sa = new Hono();
  const jwt = `${Buffer.from("{}").toString("base64url")}.${Buffer.from("{}").toString("base64url")}.x`;
  sa.use("*", apiTokenAuth("tok", undefined, ["du", "changes", "disk-pressure"], { review: async () => ({ ok: true, namespace: "ns", name: "sa" }) as never, sink: () => {} }));
  sa.all("*", (c) => c.text("ok"));
  const asSa = (p: string) => Promise.resolve(sa.request(p, { headers: { "x-filedeck-token": jwt } })).then((r) => r.status);
  assert.equal(await asSa("/api/nodes/a/api/du"), 200);
  assert.equal(await asSa("/api/v1/disk-pressure"), 403);
  assert.equal(await asSa("/api/nodes/a/api/v1/pressure"), 403);
});
