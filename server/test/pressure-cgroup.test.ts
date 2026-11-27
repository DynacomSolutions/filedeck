import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CgroupIoSampler } from "../src/pressure/cgroup.ts";

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), "pressure-cgroup-")));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const DEV = "259:0";
/** Writes (or replaces) the io.stat of a cgroup folder, made when needed. Counters are what the kernel shows: hierarchical. */
function io(root: string, cg: string, c: { r?: number; w?: number; rb?: number; wb?: number }, dev = DEV) {
  const d = path.join(root, cg);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, "io.stat"), `${dev} rbytes=${c.rb ?? 0} wbytes=${c.wb ?? 0} rios=${c.r ?? 0} wios=${c.w ?? 0} dbytes=0 dios=0\n`);
}
const mk = () => fs.mkdtempSync(path.join(tmp, "t-"));

test("cgroup sampler: a cgroup's own IO is its counters minus its children's; leaves are not double counted", () => {
  const root = mk();
  let t = 1_000_000;
  const s = new CgroupIoSampler({ root, now: () => t });
  const set = (k: number) => {
    io(root, "/", { r: 1000 + 165 * k, w: 0, rb: 0 });
    io(root, "/kube.slice", { r: 500 + 115 * k });
    io(root, "/kube.slice/pod-a", { r: 400 + 100 * k, rb: 4096 * 100 * k });
    io(root, "/kube.slice/pod-b", { r: 90 + 10 * k });
    io(root, "/system.slice", { r: 500 + 50 * k });
  };
  set(0);
  const first = s.sample();
  assert.equal(first.baseline, true);
  assert.equal(first.own.size, 0);
  t += 1000;
  set(1);
  const second = s.sample();
  assert.equal(second.baseline, false);
  const rates = (cg: string) => second.own.get(cg)?.get(DEV);
  assert.equal(rates("/kube.slice/pod-a")!.rIops, 100);
  assert.equal(rates("/kube.slice/pod-a")!.rBps, 409600);
  assert.equal(rates("/kube.slice/pod-b")!.rIops, 10);
  assert.equal(rates("/kube.slice")!.rIops, 5, "the parent keeps only what its children do not explain");
  assert.equal(rates("/system.slice")!.rIops, 50);
  assert.equal(second.own.has("/"), false, "the root has nothing of its own");
  // the rates follow the real time between samples
  t += 2000;
  set(3);
  assert.equal(s.sample().own.get("/kube.slice/pod-a")!.get(DEV)!.rIops, 100);
});

test("cgroup sampler: idle subtrees are not read, and the cost stays near the active cgroups", () => {
  const root = mk();
  let t = 0;
  const s = new CgroupIoSampler({ root, now: () => t });
  // 20 idle slices of 20 cgroups each, and one busy slice
  const idle = () => {
    for (let i = 0; i < 20; i++) {
      io(root, `/idle${i}`, { r: 5 });
      for (let j = 0; j < 20; j++) io(root, `/idle${i}/c${j}`, { r: 1 });
    }
  };
  const busy = (k: number) => {
    io(root, "/", { r: 1000 + 10 * k });
    io(root, "/busy", { r: 10 * k });
    io(root, "/busy/a", { r: 10 * k });
  };
  idle();
  busy(0);
  s.sample();
  t += 1000;
  busy(1);
  const x = s.sample();
  assert.equal(x.own.get("/busy/a")!.get(DEV)!.rIops, 10);
  assert.ok(x.reads <= 25, `read ${x.reads} cgroups: the 20 idle slices still have to be looked at, but not their ${400} children`);
  assert.equal(s.nodes > 400, true);
});

test("cgroup sampler: a cold child that becomes busy under a busy parent is found at once", () => {
  const root = mk();
  let t = 0;
  const s = new CgroupIoSampler({ root, now: () => t, coldEvery: 1000, hotTicks: 1 });
  const set = (k: number, cold: number) => {
    io(root, "/", { r: 100 * k + cold });
    io(root, "/p", { r: 100 * k + cold });
    io(root, "/p/hot", { r: 100 * k });
    io(root, "/p/cold", { r: cold });
  };
  set(0, 0);
  s.sample();
  for (let k = 1; k <= 12; k++) {
    t += 1000;
    set(k, 0);
    s.sample(); // the cold child has no activity for a long time
  }
  t += 1000;
  set(13, 77);
  const x = s.sample();
  assert.equal(x.own.get("/p/cold")!.get(DEV)!.rIops > 0, true);
  assert.equal(x.own.has("/p"), false, "its IO is not attributed to the parent");
});

test("cgroup sampler: a cgroup that vanished inside the interval does not make its parent look busy", () => {
  const root = mk();
  let t = 0;
  const s = new CgroupIoSampler({ root, now: () => t });
  io(root, "/", { r: 10 });
  io(root, "/p", { r: 10 });
  io(root, "/p/gone", { r: 10 });
  io(root, "/p/stay", { r: 0 });
  s.sample();
  t += 1000;
  fs.rmSync(path.join(root, "p/gone"), { recursive: true });
  io(root, "/", { r: 60 });
  io(root, "/p", { r: 60 });
  io(root, "/p/stay", { r: 1 });
  const x = s.sample();
  assert.equal(x.own.has("/p"), false);
  assert.equal(x.own.get("/p/stay")!.get(DEV)!.rIops, 1);
});

test("cgroup sampler: a new cgroup is followed, and cgroups without io.stat are skipped", () => {
  const root = mk();
  let t = 0;
  const s = new CgroupIoSampler({ root, now: () => t, relistMs: 0 });
  io(root, "/", { r: 0 });
  io(root, "/p", { r: 0 });
  fs.mkdirSync(path.join(root, "p/noio"), { recursive: true });
  s.sample();
  t += 1000;
  io(root, "/", { r: 30 });
  io(root, "/p", { r: 30 });
  io(root, "/p/new", { r: 30 });
  const x = s.sample();
  assert.equal(x.own.get("/p/new")!.get(DEV)!.rIops > 0, true);
  assert.equal(x.own.has("/p/noio"), false);
});

test("cgroup sampler: io.pressure, cgroup.procs and cgroup ids", () => {
  const root = mk();
  io(root, "/", {});
  io(root, "/a/b", {});
  fs.writeFileSync(path.join(root, "a/b/io.pressure"), "some avg10=1.00 avg60=2.00 avg300=3.00 total=1\nfull avg10=0.50 avg60=0.60 avg300=0.70 total=1\n");
  fs.writeFileSync(path.join(root, "a/b/cgroup.procs"), "100\n200\n");
  const s = new CgroupIoSampler({ root });
  assert.equal(s.pressure("/a/b")!.full.avg10, 0.5);
  assert.equal(s.pressure("/a"), undefined);
  assert.deepEqual(s.pids("/a/b"), [100, 200]);
  assert.deepEqual(s.pids("/a/b", 1), [100]);
  const ids = s.walkIds();
  assert.equal(ids.get(fs.statSync(path.join(root, "a/b")).ino), "/a/b");
  assert.equal(ids.get(fs.statSync(root).ino), "/");
});

test("cgroup sampler: 1,000 fake cgroups stay inside the time bound", () => {
  const root = mk();
  let t = 0;
  const s = new CgroupIoSampler({ root, now: () => t });
  const N_SLICES = 10;
  const PER = 100;
  const fill = (k: number) => {
    io(root, "/", { r: 100 * k });
    for (let i = 0; i < N_SLICES; i++) {
      // slice 0 has 5 busy children, the others are idle
      io(root, `/s${i}`, { r: i === 0 ? 50 * k : 3 });
      for (let j = 0; j < PER; j++) io(root, `/s${i}/c${j}`, { r: i === 0 && j < 5 ? 10 * k : 1 });
    }
  };
  fill(0);
  const t0 = process.hrtime.bigint();
  s.sample();
  const baselineMs = Number(process.hrtime.bigint() - t0) / 1e6;
  const costs: number[] = [];
  for (let k = 1; k <= 8; k++) {
    t += 1000;
    fill(k);
    const a = process.hrtime.bigint();
    const x = s.sample();
    costs.push(Number(process.hrtime.bigint() - a) / 1e6);
    assert.equal(x.own.get("/s0/c0")!.get(DEV)!.rIops, 10);
  }
  assert.ok(s.nodes >= 1000, `${s.nodes} cgroups followed`);
  costs.sort((a, b) => a - b);
  const median = costs[costs.length >> 1]!;
  // generous bounds: the real figure is a few ms; the point is that the work does not grow with the idle cgroups
  assert.ok(baselineMs < 2000, `baseline ${baselineMs} ms`);
  assert.ok(median < 100, `median sample ${median} ms for ${s.nodes} cgroups`);
});
