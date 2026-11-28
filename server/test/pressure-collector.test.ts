import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PressureCollector, trim, type EventSource } from "../src/pressure/collector.ts";
import { pressureMetricLines } from "../src/pressure/metrics.ts";
import { ProcIoSampler } from "../src/pressure/procio.ts";
import { trackTimers } from "./timer-probe.ts";

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), "pressure-collector-")));
const cleanups: (() => void)[] = [];
after(() => {
  for (const c of cleanups.reverse()) c();
  fs.rmSync(tmp, { recursive: true, force: true });
});
const fx = (n: string) => fs.readFileSync(path.join(import.meta.dirname, "fixtures/pressure", n), "utf8");
/** /proc/diskstats k seconds into the fixture's load: nvme0n1 moves like the fixture's two samples (1143 reads, 2492 writes, 80% busy per second). */
const diskstatsAt = (k: number) => {
  const lines = fx("diskstats.a").split("\n");
  lines[0] = ` 259       0 nvme0n1 ${1000 + 1143 * k} 0 ${80000 + 27000 * k} ${500 + 500 * k} ${2000 + 2492 * k} 0 ${160000 + 150000 * k} ${3000 + 3100 * k} ${k ? 3 : 1} ${2000 + 800 * k} ${4000 + 10200 * k} 0 0 0 0 0 0`;
  return lines.join("\n");
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (f: () => boolean, ms = 5000) => {
  for (const t0 = Date.now(); !f() && Date.now() - t0 < ms; ) await sleep(10);
};

const UID = "55354800-dfd7-40ad-b216-01025937f194";
const CID = "0fa6746a5a5554afeaa1d753277b679e9459369650bf7e1eb1d6421ec2ecdc09";
const POD = `/kubepods.slice/kubepods-burstable.slice/kubepods-burstable-pod${UID.replace(/-/g, "_")}.slice`;
const CT = `${POD}/cri-containerd-${CID}.scope`;

/** A machine in a folder: /proc and /sys files, a cgroup tree, a process folder, pod log names. */
function machine() {
  const root = fs.mkdtempSync(path.join(tmp, "m-"));
  const m = {
    root,
    diskstats: path.join(root, "diskstats"),
    psi: path.join(root, "pressure-io"),
    sysBlock: path.join(root, "sys-block"),
    mountinfo: path.join(root, "mountinfo"),
    cg: path.join(root, "cgroup"),
    proc: path.join(root, "proc"),
    host: path.join(root, "host"),
  };
  fs.writeFileSync(m.diskstats, fx("diskstats.a"));
  fs.writeFileSync(m.psi, fx("pressure-io"));
  fs.writeFileSync(m.mountinfo, fx("mountinfo"));
  for (const n of ["nvme0n1", "nvme1n1", "dm-0", "dm-1", "loop0", "sda"]) fs.mkdirSync(path.join(m.sysBlock, n), { recursive: true });
  fs.mkdirSync(path.join(m.host, `var/log/pods/team_web-1_${UID}/app`), { recursive: true });
  fs.mkdirSync(path.join(m.host, "var/log/containers"), { recursive: true });
  fs.writeFileSync(path.join(m.host, `var/log/containers/web-1_team_app-${CID}.log`), "");
  const io = (cg: string, c: { r: number; w: number; rb: number; wb: number }) => {
    const d = path.join(m.cg, cg);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, "io.stat"), `259:0 rbytes=${c.rb} wbytes=${c.wb} rios=${c.r} wios=${c.w} dbytes=0 dios=0\n`);
  };
  const cgState = (k: number) => {
    // k seconds in: the pod's container reads and writes a lot; backup writes a little
    io("/", { r: 1000 * k, w: 2000 * k, rb: 1e6 * k, wb: 2e6 * k });
    io("/kubepods.slice", { r: 900 * k, w: 1800 * k, rb: 9e5 * k, wb: 18e5 * k });
    io("/kubepods.slice/kubepods-burstable.slice", { r: 900 * k, w: 1800 * k, rb: 9e5 * k, wb: 18e5 * k });
    io(POD.replace("/kubepods.slice/kubepods-burstable.slice", "/kubepods.slice/kubepods-burstable.slice"), { r: 900 * k, w: 1800 * k, rb: 9e5 * k, wb: 18e5 * k });
    io(CT, { r: 900 * k, w: 1800 * k, rb: 9e5 * k, wb: 18e5 * k });
    io("/system.slice", { r: 100 * k, w: 200 * k, rb: 1e5 * k, wb: 2e5 * k });
    io("/system.slice/backup.service", { r: 100 * k, w: 200 * k, rb: 1e5 * k, wb: 2e5 * k });
  };
  cgState(0);
  fs.writeFileSync(path.join(m.cg, CT, "cgroup.procs"), "4242\n");
  fs.writeFileSync(path.join(m.cg, CT, "io.pressure"), "some avg10=3.00 avg60=2.00 avg300=1.00 total=1\nfull avg10=2.50 avg60=1.00 avg300=0.50 total=1\n");
  const proc = (pid: number, read: number, write: number) => {
    const d = path.join(m.proc, String(pid));
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, "io"), `read_bytes: ${read}\nwrite_bytes: ${write}\n`);
    fs.writeFileSync(path.join(d, "stat"), `${pid} (postgres) S 1 1 1 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 555 1 1 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0\n`);
    fs.writeFileSync(path.join(d, "comm"), "postgres\n");
  };
  proc(4242, 0, 0);
  return { ...m, cgState, setProc: proc };
}

function collector(m: ReturnType<typeof machine>, o: Partial<ConstructorParameters<typeof PressureCollector>[0]> & { clock?: { t: number } } = {}) {
  const clock = o.clock ?? { t: 1_000_000 };
  const logs: string[] = [];
  const c = new PressureCollector({
    node: "n1", intervalMs: 3_600_000, hostRoot: m.host, cgroupRoot: m.cg, procRoot: m.proc, pathDepth: 3,
    diskstatsFile: m.diskstats, psiFile: m.psi, sysBlock: m.sysBlock, mountinfoFile: m.mountinfo,
    now: () => clock.t, log: (s) => logs.push(s), ...o,
  });
  cleanups.push(() => c.close());
  return { c, clock, logs };
}

test("collector, proc source: disks, mounts, PSI, cgroup and process consumers, labels from pod names", async () => {
  const m = machine();
  const { c, clock } = collector(m);
  await c.sample(); // the first reading is the baseline
  assert.equal(c.latest, undefined);
  for (const k of [1, 2]) {
    clock.t += 1000;
    fs.writeFileSync(m.diskstats, diskstatsAt(k));
    m.cgState(k);
    m.setProc(4242, k === 1 ? 0 : 4096 * 900, k === 1 ? 0 : 4096 * 1800); // a process shows a rate from its second read
    await c.sample();
  }
  const s = c.latest!;
  assert.equal(s.type, "snapshot");
  assert.equal(s.node, "n1");
  assert.equal(s.source, "proc");
  assert.equal(s.at, clock.t);
  assert.deepEqual(s.psi.full, { avg10: 0.9, avg60: 4.5, avg300: 7.5 });
  assert.deepEqual(s.disks.map((d) => d.name), ["dm-0", "nvme0n1", "nvme1n1", "sda"], "partitions, loop and unmounted dm devices are left out");
  const d = s.disks.find((x) => x.name === "nvme0n1")!;
  assert.equal(d.dev, "259:0");
  assert.deepEqual(d.mounts, ["/", "/boot"], "a partition's mounts belong to its disk");
  assert.deepEqual(s.disks.find((x) => x.name === "nvme1n1")!.mounts, ["/mnt/disk one"]);
  assert.equal(d.util, 0.8);
  assert.equal(d.rIops, 1143);
  assert.equal(d.wIops, 2492);
  assert.equal(d.queueDepth, 10.2);
  assert.equal(d.inflight, 3);
  const pod = d.consumers.find((x) => x.kind === "cgroup" && x.cgroup === CT)!;
  assert.equal(pod.label, "team/web-1/app");
  assert.deepEqual(pod.pod, { namespace: "team", name: "web-1", uid: UID, container: "app" });
  assert.equal(pod.rIops, 900);
  assert.equal(pod.wIops, 1800);
  assert.equal(pod.psiFull10, 2.5);
  const unit = d.consumers.find((x) => x.cgroup === "/system.slice/backup.service")!;
  assert.equal(unit.unit, "backup.service");
  assert.equal(unit.label, "backup.service");
  assert.ok(!d.consumers.some((x) => x.cgroup === "/kubepods.slice"), "a parent with nothing of its own is not listed");
  assert.equal(d.consumers[0]!.cgroup, CT, "ranked by IO operations, the busiest first");
  const proc = d.consumers.find((x) => x.kind === "process")!;
  assert.equal(proc.id, "pid:4242:555");
  assert.equal(proc.comm, "postgres");
  assert.equal(proc.cgroup, CT);
  assert.equal(proc.rBps, 4096 * 900);
  assert.equal(proc.pod?.name, "web-1");
  // trimming by disk and top
  assert.equal(trim(s, "nvme0n1", 1).disks.length, 1);
  assert.equal(trim(s, undefined, 0).disks.every((x) => x.consumers.length === 0), true);
  assert.equal(JSON.parse(c.format(s, "nvme1n1", 5)).disks[0].name, "nvme1n1");
  assert.equal(c.format(s, undefined, 20), c.format(s, undefined, 20), "the line is made once per filter");
  assert.ok(c.probeSeconds > 0 && c.probeSeconds < 1);
});

test("collector: path consumers count change events per top folder and rank after the IO consumers", async () => {
  const m = machine();
  const handlers = new Set<(e: { kind: string; path?: string }) => void>();
  const bus: EventSource = { listen: (f) => (handlers.add(f), () => void handlers.delete(f)) };
  const { c, clock } = collector(m, { bus });
  assert.equal(handlers.size, 0, "no listener while nobody watches");
  const off = c.subscribe(() => {});
  await until(() => c.sampleCount >= 1); // the first reading is the baseline
  assert.equal(handlers.size, 1, "the event listener is on while a live view is open");
  const emit = (p: string, n = 1) => { for (let i = 0; i < n; i++) for (const h of handlers) h({ kind: "modify", path: p }); };
  emit("/ignored.txt");
  clock.t += 2000;
  emit("/srv/projects/x/a.ts", 30);
  emit("/srv/projects/x/b.ts", 10);
  emit("/srv/projects/y/c.ts", 4);
  emit("/mnt/disk one/data/set/1/f", 6);
  emit("/srv/share/remote.txt", 99); // a network mount: no local disk
  for (const h of handlers) h({ kind: "ready" });
  fs.writeFileSync(m.diskstats, fx("diskstats.b"));
  await c.sample();
  const s = c.latest!;
  const root = s.disks.find((x) => x.name === "nvme0n1")!;
  const paths = root.consumers.filter((x) => x.kind === "path");
  assert.deepEqual(paths.map((p) => [p.id, p.eventsPerSec]), [["path:/srv/projects/x", 20], ["path:/srv/projects/y", 2], ["path:/", 0.5]]);
  assert.equal(root.consumers.at(-1)!.kind, "path");
  const other = s.disks.find((x) => x.name === "nvme1n1")!;
  assert.deepEqual(other.consumers.map((x) => [x.id, x.eventsPerSec]), [["path:/mnt/disk one/data/set/1", 3]]);
  assert.ok(!s.disks.some((d) => d.consumers.some((x) => x.path?.startsWith("/srv/share"))));
  off();
  assert.equal(handlers.size, 0, "the listener is gone when the last view closes");
  // metrics never name a folder
  assert.ok(!(await pressureMetricLines(c)).join("\n").includes("/srv/projects"));
});

function helper(mode: string, m: ReturnType<typeof machine>) {
  process.env.FAKE_IOTRACE = mode;
  process.env.FAKE_CG = String(fs.statSync(path.join(m.cg, CT)).ino);
  process.env.FAKE_CG2 = String(fs.statSync(path.join(m.cg, "system.slice/backup.service")).ino);
  return path.join(import.meta.dirname, "fake-iotrace.sh");
}

test("collector, eBPF source: rows of the helper replace the io.stat reading; cgroup ids map to paths", async () => {
  const m = machine();
  const { c, clock, logs } = collector(m, { iotrace: helper("ok", m) });
  await c.sample(); // the first reading is the baseline
  clock.t += 1000;
  await c.sample();
  const s = c.latest!;
  assert.equal(s.source, "ebpf");
  const d = s.disks.find((x) => x.name === "nvme0n1")!;
  const cg = d.consumers.find((x) => x.kind === "cgroup" && x.cgroup === CT)!;
  assert.equal(cg.label, "team/web-1/app");
  assert.equal(cg.rIops, 100);
  assert.equal(cg.wIops, 200);
  assert.equal(cg.wBps, 819200);
  const pg = d.consumers.find((x) => x.kind === "process" && x.pid === 4242)!;
  assert.equal(pg.comm, "postgres");
  assert.equal(pg.label, "postgres");
  assert.equal(pg.cgroup, CT);
  assert.equal(pg.rIops, 100);
  assert.equal(pg.id, "pid:4242");
  assert.ok(d.consumers.some((x) => x.comm === "kworker" && x.cgroup === "/system.slice/backup.service"));
  assert.ok(!s.disks.some((x) => x.dev === "9:9"), "a device that is not shown is dropped");
  assert.equal((await pressureMetricLines(c)).includes('filedeck_pressure_source{source="ebpf"} 1'), true);
  assert.deepEqual(logs, []);
});

test("collector: a helper that fails at the start, or later, or stays silent, gives the proc source and one log line", async () => {
  for (const mode of ["fail", "crash", "silent"]) {
    const m = machine();
    const { c, clock, logs } = collector(m, { iotrace: helper(mode, m), iotraceTimeoutMs: 150 });
    await c.sample(); // the helper fails here, the fallback answers (a baseline)
    clock.t += 1000;
    fs.writeFileSync(m.diskstats, fx("diskstats.b"));
    m.cgState(1);
    await c.sample();
    clock.t += 1000;
    m.cgState(2);
    await c.sample();
    assert.equal(c.latest!.source, "proc", mode);
    assert.ok(c.latest!.disks.find((x) => x.name === "nvme0n1")!.consumers.some((x) => x.cgroup === CT), mode);
    assert.equal(logs.length, 1, `${mode}: ${logs.join(" | ")}`);
    assert.match(logs[0]!, /eBPF helper/);
  }
});

test("collector: a missing helper file is one log line and the proc source", async () => {
  const m = machine();
  const { c, logs } = collector(m, { iotrace: path.join(tmp, "no-such-helper") });
  await c.sample(); // the first reading is the baseline
  await c.sample();
  assert.equal(logs.length, 1);
  assert.equal(c.latest, undefined, "the first reading is a baseline");
});

test("collector, no cgroup tree: processes are read from the process folder now and then", async () => {
  const m = machine();
  const { c, clock } = collector(m, { cgroupRoot: path.join(m.root, "no-cgroup") });
  await c.sample(); // the first reading is the baseline
  const d = path.join(m.proc, "4242");
  fs.writeFileSync(path.join(d, "cgroup"), "0::/system.slice/pg.service\n");
  clock.t += 1000;
  fs.writeFileSync(m.diskstats, fx("diskstats.b"));
  await c.sample(); // reads every process once: no rate yet
  clock.t += 6000;
  m.setProc(4242, 8192 * 100, 0);
  fs.writeFileSync(path.join(d, "cgroup"), "0::/system.slice/pg.service\n");
  fs.writeFileSync(m.diskstats, fx("diskstats.b"));
  await c.sample();
  const procs = c.latest!.disks.flatMap((x) => x.consumers).filter((x) => x.kind === "process");
  assert.ok(procs.length > 0);
  assert.equal(procs[0]!.unit, "pg.service");
  assert.equal(procs[0]!.cgroup, "/system.slice/pg.service");
  assert.ok(Math.abs(procs.reduce((a, x) => a + x.rBps, 0) - (8192 * 100) / 6) <= 4, "the process's bytes are shared out over the disks and add up");
});

test("metrics: top 10 consumers per disk, labels cut to 80 characters, probe time and source", async () => {
  const m = machine();
  const { c, clock } = collector(m);
  await c.sample(); // the first reading is the baseline
  clock.t += 1000;
  fs.writeFileSync(m.diskstats, fx("diskstats.b"));
  m.cgState(1);
  // 15 more cgroups with long names that share a prefix
  for (let i = 0; i < 15; i++) {
    const cg = `/system.slice/${"x".repeat(100)}${i}.service`;
    const dir = path.join(m.cg, cg);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "io.stat"), `259:0 rbytes=${1000 * (i + 1)} wbytes=0 rios=${i + 1} wios=0 dbytes=0 dios=0\n`);
  }
  fs.writeFileSync(path.join(m.cg, "system.slice/io.stat"), `259:0 rbytes=${1e5 + 120000} wbytes=${2e5} rios=${100 + 120} wios=200 dbytes=0 dios=0\n`);
  fs.writeFileSync(path.join(m.cg, "io.stat"), `259:0 rbytes=${1e6 + 120000} wbytes=${2e6} rios=${1000 + 120} wios=2000 dbytes=0 dios=0\n`);
  await c.sample();
  const text = (await pressureMetricLines(c)).join("\n");
  const series = (name: string) => text.split("\n").filter((l) => l.startsWith(name + "{"));
  assert.ok(series("filedeck_disk_util_ratio").includes('filedeck_disk_util_ratio{disk="nvme0n1"} 0.8'));
  assert.equal(series("filedeck_disk_iops").length, 8, "read and write for each of 4 disks");
  const consumers = series("filedeck_disk_consumer_iops").filter((l) => l.includes('disk="nvme0n1"') && l.includes('op="read"'));
  assert.ok(consumers.length <= 10 && consumers.length > 0, `${consumers.length} consumers for the disk`);
  for (const l of series("filedeck_disk_consumer_iops")) {
    const v = /consumer="([^"]*)"/.exec(l)![1]!;
    assert.ok(v.length <= 80);
  }
  assert.match(text, /filedeck_io_pressure_ratio\{kind="full",window="avg10"\} 0\.009/);
  assert.match(text, /filedeck_pressure_probe_seconds_total [0-9.]+/);
  assert.match(text, /filedeck_pressure_source\{source="proc"\} 1/);
  assert.match(text, /filedeck_pressure_source\{source="ebpf"\} 0/);
});

test("cost: sampling 1,000 fake cgroups twice a second stays far under 1% of one CPU", async () => {
  const m = machine();
  const { c, clock } = collector(m);
  await c.sample(); // the first reading is the baseline
  const fill = (k: number) => {
    m.cgState(k);
    for (let i = 0; i < 10; i++) {
      for (let j = 0; j < 99; j++) {
        const dir = path.join(m.cg, `/system.slice/s${i}/c${j}`);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, "io.stat"), `259:0 rbytes=0 wbytes=0 rios=${j < 3 ? k * 5 : 1} wios=0 dbytes=0 dios=0\n`);
      }
      fs.writeFileSync(path.join(m.cg, `/system.slice/s${i}/io.stat`), `259:0 rbytes=0 wbytes=0 rios=${15 * 1 * 0 + (i === 0 ? 15 * k : 0) + 96 + 3 * 0} wios=0 dbytes=0 dios=0\n`);
    }
  };
  fill(0);
  clock.t += 1000;
  await c.sample();
  const before = c.probeSeconds;
  const N = 10;
  for (let k = 1; k <= N; k++) {
    clock.t += 1000;
    fill(k);
    const t0 = process.cpuUsage();
    await c.sample();
    const u = process.cpuUsage(t0);
    assert.ok((u.user + u.system) / 1000 < 150, `sample ${k} took ${(u.user + u.system) / 1000} ms of CPU`);
  }
  const perSample = (c.probeSeconds - before) / N;
  assert.ok(perSample < 0.05, `${(perSample * 1000).toFixed(1)} ms of CPU per sample`);
});

test("mounts of a disk: container runtime mounts are left out and the short paths come first", async () => {
  const m = machine();
  fs.writeFileSync(m.mountinfo, fx("mountinfo") + "40 22 259:2 /pv /var/lib/kubelet/pods/abc/volumes/x rw - ext4 /dev/nvme0n1p2 rw\n41 22 259:2 /home/data /srv/data/deep/er rw - ext4 /dev/nvme0n1p2 rw\n");
  const { c, clock } = collector(m);
  await c.sample(); // the first reading is the baseline
  clock.t += 1000;
  fs.writeFileSync(m.diskstats, fx("diskstats.b"));
  await c.sample();
  assert.deepEqual(c.latest!.disks.find((d) => d.name === "nvme0n1")!.mounts, ["/", "/boot", "/srv/data/deep/er"]);
});

test("processes: when /proc/<pid>/io is refused for every process the sampler rests for a minute", async () => {
  const root = path.join(tmp, "denied-proc");
  for (let pid = 1; pid <= 10; pid++) {
    const d = path.join(root, String(pid));
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, "io"), "read_bytes: 1\nwrite_bytes: 1\n");
    fs.chmodSync(path.join(d, "io"), 0);
  }
  if (process.getuid?.() === 0) return; // root reads it all
  let t = 0;
  const s = new ProcIoSampler({ root, now: () => t });
  s.sample([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.equal(s.denied, true);
  fs.chmodSync(path.join(root, "1/io"), 0o644);
  t += 30_000;
  assert.deepEqual(s.sample([1]), [], "no read during the rest");
  t += 31_000;
  s.sample([1]);
  assert.equal(s.denied, false, "tried again after a minute: process 1 is readable now");
});

test("demand: idle there is no timer and no read; a scrape reads once; a live view gets updates and leaves nothing behind", async () => {
  const probe = trackTimers();
  try {
    const m = machine();
    const clock = { t: 1_000_000 };
    const { c } = collector(m, { intervalMs: 20, clock });
    let reads = 0;
    const read = c.sampler.read.bind(c.sampler);
    c.sampler.read = () => (reads++, c.live && (clock.t += 1000), read()); // (a live view moves the fake clock on by a second at each read)
    await sleep(100);
    assert.equal(probe.active(), 0, "idle: no timer");
    assert.equal(reads, 0, "idle: no read");

    // a scrape: the first one has no baseline, so it reads twice and waits one interval; the next one reads exactly once
    await pressureMetricLines(c);
    assert.equal(reads, 2);
    assert.equal(probe.active(), 0, "a scrape leaves no timer");
    clock.t += 15_000;
    fs.writeFileSync(m.diskstats, diskstatsAt(15));
    const text = (await pressureMetricLines(c)).join("\n");
    assert.equal(reads, 3, "one scrape, one read");
    assert.match(text, /filedeck_disk_util_ratio\{disk="nvme0n1"\}/);
    assert.equal(c.live, false);
    await sleep(100);
    assert.equal(reads, 3, "nothing reads between scrapes");

    // two reads at once share one
    clock.t += 15_000;
    await Promise.all([c.read(), c.read(), c.read()]);
    assert.equal(reads, 4);

    // a live view: updates arrive while it is open, and the last close clears the deadline
    clock.t += 1000;
    const got: number[] = [];
    const off1 = c.subscribe((s) => got.push(s.at));
    const off2 = c.subscribe(() => {});
    await until(() => got.length >= 3, 3000);
    assert.ok(got.length >= 3, `got ${got.length} updates`);
    assert.equal(probe.active() > 0, true, "a one-shot deadline is armed while somebody watches");
    off1();
    await sleep(60);
    assert.equal(probe.active() > 0, true, "one watcher is left");
    off2();
    assert.equal(probe.active(), 0, "the last close clears the deadline");
    const n = reads;
    await sleep(100);
    assert.equal(reads, n, "no read after that");
    assert.equal(c.live, false);
  } finally {
    probe.restore();
  }
});
