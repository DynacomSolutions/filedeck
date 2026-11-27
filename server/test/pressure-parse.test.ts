import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { diskRates, parentDisk, parseDiskstats, pickDisks } from "../src/pressure/diskstats.ts";
import { parsePsi } from "../src/pressure/psi.ts";
import { blockMounts, parseMountInfoFull, remoteMounts } from "../src/pressure/mountinfo.ts";
import { parseIoStat } from "../src/pressure/cgroup.ts";
import { parseProcCgroup, parseProcIo, parseStartTime, ProcIoSampler } from "../src/pressure/procio.ts";
import { LabelRules, PodIndex, parseKubeCgroup, parseUnit } from "../src/pressure/labels.ts";
import { PathCounter } from "../src/pressure/pathcount.ts";
import { iotracePath } from "../src/pressure/helper.ts";
import { loadConfig } from "../src/config.ts";

const fx = (n: string) => fs.readFileSync(path.join(import.meta.dirname, "fixtures/pressure", n), "utf8");
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), "pressure-parse-")));
process.on("exit", () => fs.rmSync(tmp, { recursive: true, force: true }));

test("diskstats: the rates of two samples match the iostat arithmetic", () => {
  const a = parseDiskstats(fx("diskstats.a"));
  const b = parseDiskstats(fx("diskstats.b"));
  assert.equal(a.length, 10);
  const r = diskRates(a[0]!, b[0]!, 1000);
  assert.equal(Math.round(r.rIops), 1143);
  assert.equal(Math.round(r.wIops), 2492);
  assert.equal(r.rBps, 27000 * 512);
  assert.equal(r.wBps, 150000 * 512);
  assert.equal(r.util, 0.8);
  assert.equal(Math.round(r.queueDepth * 10) / 10, 10.2);
  assert.equal(Math.round(r.rAwaitMs * 100) / 100, 0.44);
  assert.equal(Math.round(r.wAwaitMs * 100) / 100, 1.24);
  assert.equal(r.inflight, 3);
  // a different interval length scales the rates; util never exceeds 1
  assert.equal(diskRates(a[0]!, b[0]!, 2000).rBps, 27000 * 256);
  assert.equal(diskRates(a[0]!, b[0]!, 100).util, 1);
  // a counter that went down gives zero, not a negative rate
  assert.equal(diskRates(b[0]!, a[0]!, 1000).rIops, 0);
});

test("diskstats: whole disks only; loop, ram, zram and unmounted dm devices are left out", () => {
  const all = parseDiskstats(fx("diskstats.a"));
  const mounted = new Set(["253:0"]);
  const names = (facts = {}) => pickDisks(all, mounted, facts).map((d) => d.name);
  assert.deepEqual(names(), ["nvme0n1", "nvme1n1", "dm-0", "sda"]);
  // with the entries of /sys/block known, they decide what is a whole disk
  assert.deepEqual(names({ wholeDisks: new Set(["nvme0n1", "nvme1n1", "sda", "dm-0", "dm-1", "loop0"]) }), ["nvme0n1", "nvme1n1", "dm-0", "sda"]);
  assert.deepEqual(pickDisks(all, new Set()).map((d) => d.name), ["nvme0n1", "nvme1n1", "sda"]);
  assert.equal(parentDisk("nvme0n1p2"), "nvme0n1");
  assert.equal(parentDisk("sda12"), "sda");
  assert.equal(parentDisk("mmcblk0p1"), "mmcblk0");
  assert.equal(parentDisk("dm-0"), "dm-0");
});

test("psi: some and full lines, and zeros without them", () => {
  assert.deepEqual(parsePsi(fx("pressure-io")), { some: { avg10: 5.3, avg60: 11.7, avg300: 22.9 }, full: { avg10: 0.9, avg60: 4.5, avg300: 7.5 } });
  assert.deepEqual(parsePsi(""), { some: { avg10: 0, avg60: 0, avg300: 0 }, full: { avg10: 0, avg60: 0, avg300: 0 } });
});

test("mountinfo: block mounts with their devices; virtual and network mounts are told apart", () => {
  const all = parseMountInfoFull(fx("mountinfo"));
  assert.equal(all.length, 7);
  assert.deepEqual(all[0], { dev: "259:2", mountpoint: "/", fstype: "ext4", source: "/dev/nvme0n1p2" });
  assert.equal(all[6]!.mountpoint, "/mnt/disk one");
  const block = blockMounts(all).map((m) => m.mountpoint);
  assert.deepEqual(block, ["/", "/boot", "/var/lib/data", "/mnt/disk one"]);
  assert.deepEqual(remoteMounts(all).map((m) => m.mountpoint), ["/srv/share"]);
});

test("io.stat: counters per device", () => {
  const m = parseIoStat(fx("io.stat"));
  assert.deepEqual(m.get("259:0"), { rios: 3, wios: 4, rbytes: 100, wbytes: 200 });
  assert.equal(m.get("8:16")!.wios, 1942081);
  assert.equal(parseIoStat("").size, 0);
});

test("/proc/<pid>/io, stat and cgroup files", () => {
  assert.deepEqual(parseProcIo(fx("proc-io")), { read: 4096, write: 8192 });
  assert.equal(parseProcIo("rchar: 1\n"), undefined);
  // a command name with spaces and brackets does not shift the fields
  assert.equal(parseStartTime(fx("proc-stat")), "987654");
  assert.equal(parseProcCgroup("0::/system.slice/backup.service\n"), "/system.slice/backup.service");
});

test("process sampler: rates from two reads, a reused pid is a new process, vanished ones are forgotten", () => {
  const root = path.join(tmp, "proc");
  const put = (pid: number, read: number, write: number, start: string) => {
    const d = path.join(root, String(pid));
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, "io"), `read_bytes: ${read}\nwrite_bytes: ${write}\n`);
    fs.writeFileSync(path.join(d, "stat"), `${pid} (db) S 1 1 1 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 ${start} 1 1 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0\n`);
    fs.writeFileSync(path.join(d, "comm"), "db\n");
    fs.writeFileSync(path.join(d, "cgroup"), "0::/system.slice/db.service\n");
  };
  let t = 1000;
  const s = new ProcIoSampler({ root, now: () => t, forgetMs: 5000 });
  put(10, 0, 0, "100");
  put(11, 0, 0, "100");
  assert.deepEqual(s.sample([10, 11]), []); // first read: no rate yet
  t += 2000;
  put(10, 4000, 2000, "100");
  const rows = s.sample([10, 11], true);
  assert.equal(rows.length, 1);
  assert.deepEqual({ ...rows[0]! }, { id: "pid:10:100", pid: 10, comm: "db", rBps: 2000, wBps: 1000, cgroup: "/system.slice/db.service" });
  // the same pid with another start time is another process: no rate from the old counters
  t += 1000;
  put(10, 10, 10, "200");
  assert.deepEqual(s.sample([10]), []);
  t += 10_000;
  s.sample([10]);
  assert.equal(s.tracked, 1, "pid 11 was not asked for during forgetMs, and the first pid 10 entry is replaced");
  assert.deepEqual(s.listPids().sort(), [10, 11]);
});

test("kubernetes cgroup paths: systemd and cgroupfs drivers", () => {
  const uid = "55354800-dfd7-40ad-b216-01025937f194";
  const cid = "0fa6746a5a5554afeaa1d753277b679e9459369650bf7e1eb1d6421ec2ecdc09";
  assert.deepEqual(parseKubeCgroup(`/kubepods.slice/kubepods-burstable.slice/kubepods-burstable-pod${uid.replace(/-/g, "_")}.slice/cri-containerd-${cid}.scope`), { uid, containerId: cid });
  assert.deepEqual(parseKubeCgroup(`/kubepods.slice/kubepods-besteffort.slice/kubepods-besteffort-pod${uid.replace(/-/g, "_")}.slice`), { uid });
  assert.deepEqual(parseKubeCgroup(`/kubepods.slice/kubepods-pod${uid.replace(/-/g, "_")}.slice/crio-${cid}.scope`), { uid, containerId: cid });
  assert.deepEqual(parseKubeCgroup(`/kubepods/burstable/pod${uid}/${cid}`), { uid, containerId: cid });
  assert.equal(parseKubeCgroup("/system.slice/backup.service"), undefined);
  assert.equal(parseKubeCgroup("/kubepods.slice/kubepods-burstable.slice"), undefined);
});

test("systemd units from a cgroup path", () => {
  assert.equal(parseUnit("/system.slice/backup.service"), "backup.service");
  assert.equal(parseUnit("/user.slice/user-1000.slice/user@1000.service/app.slice/app-x\\x2dy.scope"), "app-x-y.scope");
  assert.equal(parseUnit("/kubepods"), undefined);
  assert.equal(parseUnit("/"), undefined);
});

test("pod index: names from /var/log/pods folder names and container ids from /var/log/containers, no API call", () => {
  const root = path.join(tmp, "hostroot");
  const uid = "55354800-dfd7-40ad-b216-01025937f194";
  const uid2 = "aaaaaaaa-dfd7-40ad-b216-01025937f194";
  const cid = "0fa6746a5a5554afeaa1d753277b679e9459369650bf7e1eb1d6421ec2ecdc09";
  fs.mkdirSync(path.join(root, `var/log/pods/team_web-1_${uid}/app`), { recursive: true });
  fs.mkdirSync(path.join(root, `var/log/pods/team_web-1_${uid}/sidecar`), { recursive: true });
  fs.mkdirSync(path.join(root, `var/log/pods/db_pg-0_${uid2}/postgres`), { recursive: true });
  fs.mkdirSync(path.join(root, "var/log/containers"), { recursive: true });
  fs.writeFileSync(path.join(root, `var/log/containers/web-1_team_app-${cid}.log`), "");
  fs.writeFileSync(path.join(root, "var/log/pods/not-a-pod"), "");
  let t = 0;
  const idx = new PodIndex({ hostRoot: root, now: () => (t += 10_000) });
  assert.deepEqual(idx.lookup(uid, cid), { namespace: "team", name: "web-1", uid, container: "app" });
  assert.deepEqual(idx.lookup(uid), { namespace: "team", name: "web-1", uid }, "a pod-level cgroup names no container");
  assert.deepEqual(idx.lookup(uid2, "f".repeat(64)), { namespace: "db", name: "pg-0", uid: uid2, container: "postgres" }, "the only container, when its id is not in the links");
  assert.equal(idx.lookup("bbbbbbbb-dfd7-40ad-b216-01025937f194"), undefined);
});

test("label rules: capture groups, named groups, links, first match wins, bad rules are skipped and logged", () => {
  const logs: string[] = [];
  const r = new LabelRules(
    JSON.stringify([
      { match: "^/agents\\.slice/(?<id>[a-f0-9]+)\\.scope$", label: "agent {id}", link: "https://example.test/sessions/{id}" },
      { match: "^/jobs/([^/]+)/(\\d+)", label: "{1} #{2}" },
      { match: "(", label: "bad" },
      { match: "^/x", label: "evil", link: "javascript:alert(1)" },
      { label: "no match" },
    ]),
    (s) => logs.push(s),
  );
  assert.equal(r.size, 3);
  assert.equal(logs.length, 2);
  assert.deepEqual(r.apply("/agents.slice/abc123.scope"), { label: "agent abc123", link: "https://example.test/sessions/abc123" });
  assert.deepEqual(r.apply("/jobs/build/42/x"), { label: "build #42" });
  assert.deepEqual(r.apply("/x"), { label: "evil" }, "a link that is not http, https or a path is dropped");
  assert.equal(r.apply("/other"), undefined);
  const bad: string[] = [];
  assert.equal(new LabelRules("not json", (s) => bad.push(s)).size, 0);
  assert.equal(bad.length, 1);
  assert.equal(new LabelRules("").size, 0);
});

test("path counter: the top folder is the first parts under the longest mount; counts are bounded", () => {
  const c = new PathCounter(3, 3);
  c.setMounts(["/", "/home/data", "/srv/share"]);
  assert.deepEqual(c.topFolder("/srv/projects/x/src/main.ts"), { mount: "/", folder: "/srv/projects/x" });
  assert.deepEqual(c.topFolder("/home/data/Projects/repositories/org/repo/file"), { mount: "/home/data", folder: "/home/data/Projects/repositories/org" });
  assert.deepEqual(c.topFolder("/home/database/x/y/z"), { mount: "/", folder: "/home/database/x" }, "a mount matches whole names only");
  assert.deepEqual(c.topFolder("/a.txt"), { mount: "/", folder: "/" });
  assert.deepEqual(c.topFolder("/srv/share/f.txt"), { mount: "/srv/share", folder: "/srv/share" });
  for (const p of ["/a/b/c/1", "/a/b/c/2", "/a/b/d/1", "/q/r/s/t", "/z/y/x/w", "/n/m/l/k"]) c.add(p);
  const got = c.take();
  assert.equal(got.folders.get("/a/b/c")!.count, 2);
  assert.equal(got.folders.size, 3, "at most `max` folders; the rest is counted as other");
  assert.equal(got.other, 2);
  assert.equal(c.take().folders.size, 0, "take empties the counter");
});

test("iotrace helper lookup: an explicit value is used as given, off disables it, else installed or built", () => {
  const dir = path.join(tmp, "native");
  fs.mkdirSync(dir, { recursive: true });
  assert.equal(iotracePath("off", dir, path.join(dir, "none")), "");
  assert.equal(iotracePath("/x/y", dir, path.join(dir, "none")), "/x/y");
  assert.equal(iotracePath("", dir, path.join(dir, "none")), "");
  fs.writeFileSync(path.join(dir, "filedeck-iotrace"), "#!/bin/sh\n", { mode: 0o755 });
  assert.equal(iotracePath("", dir, path.join(dir, "none")), path.join(dir, "filedeck-iotrace"));
});

test("config: the pressure settings have safe defaults and are clamped", () => {
  const d = loadConfig({} as never);
  assert.equal(d.pressure, false);
  assert.equal(d.pressureIntervalMs, 1000);
  assert.equal(d.pressureCgroupRoot, "/sys/fs/cgroup");
  assert.equal(d.pressureProcRoot, "/proc");
  assert.equal(d.pressurePathDepth, 3);
  const c = loadConfig({ FILEDECK_PRESSURE: "1", FILEDECK_PRESSURE_INTERVAL_MS: "5", FILEDECK_PRESSURE_CGROUP_ROOT: "/host-cgroup/", FILEDECK_PRESSURE_PATH_DEPTH: "99" } as never);
  assert.equal(c.pressure, true);
  assert.equal(c.pressureIntervalMs, 250);
  assert.equal(c.pressureCgroupRoot, "/host-cgroup");
  assert.equal(c.pressurePathDepth, 12);
});
