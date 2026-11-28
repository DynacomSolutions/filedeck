import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { Hono } from "hono";
import type { Config } from "../src/config.ts";
import type { HelperProc } from "../src/fanwatch.ts";
import { Holders, PROVEN_FS, fsReason, mountsUnder, parseCgroup, type HoldersAnswer } from "../src/holders.ts";
import { HF_ERROR, HF_MT, HF_SHARED, HT, encodeRecord, kernelDev } from "../src/holders-proto.ts";
import { registerHolderRoutes } from "../src/holders-routes.ts";
import { agentError } from "../src/agent-routes.ts";

/**
 * The manager and the route with a helper that is a script: the records go in as bytes, the commands that the manager writes are seen, and the answers
 * come from the table. (The real helper is tested in holders-helper.test.ts.)
 */
let tmp: string;
let dev: number;
let inoOf: (p: string) => number;
before(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "filedeck-holders-")));
  fs.mkdirSync(path.join(tmp, "tree/sub/deep"), { recursive: true });
  fs.mkdirSync(path.join(tmp, "other"));
  fs.writeFileSync(path.join(tmp, "tree/sub/deep/file"), "x");
  dev = kernelDev(fs.statSync(tmp, { bigint: true }).dev);
  inoOf = (p) => Number(fs.statSync(path.join(tmp, p), { bigint: true }).ino);
});
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

class Fake extends EventEmitter implements HelperProc {
  stdout = new PassThrough();
  stderr = new PassThrough();
  written: string[] = [];
  killed = false;
  onWrite?: (s: string) => void;
  /** answers `sync N` like the helper: the records that the kernel made before it (see `beforeSync`), then SYNC. false = never answers. */
  autoSync = true;
  /** the records that are in the ring when a `sync` comes (the helper copies them before it answers) */
  beforeSync: Array<Parameters<typeof encodeRecord>[0]> = [];
  stdin = {
    write: (s: string) => {
      this.written.push(s);
      this.onWrite?.(s);
      const m = /^sync (\d+)\n$/.exec(s);
      if (m && this.autoSync) {
        const pending = this.beforeSync;
        this.beforeSync = [];
        this.send(...pending, { type: HT.SYNC, aux: Number(m[1]) });
      }
      return true;
    },
    on: () => this.stdin,
    removeListener: () => this.stdin,
  };
  kill() {
    this.killed = true;
    this.emit("exit", null, "SIGTERM");
    return true;
  }
  send(...recs: Array<Parameters<typeof encodeRecord>[0]>) {
    this.stdout.write(Buffer.concat(recs.map((r) => encodeRecord(r))));
  }
}

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));
async function until(f: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!f()) {
    if (Date.now() > end) assert.fail("the condition did not become true");
    await tick(5);
  }
}

function make(extra: Partial<ConstructorParameters<typeof Holders>[0]> = {}) {
  const helpers: Fake[] = [];
  const h = new Holders({ helper: "/fake/filedeck-holders", root: "/", settleMs: 150, readMs: 400, mapsFreshMs: 60_000, restartMinMs: 5, syncMs: 300, provenFs: "any", foreignMounts: async () => ({ mounts: [], unreadable: 0 }), kernelHolds: async () => ({ mounts: [], unreadable: 0 }), spawn: () => {
    const f = new Fake();
    helpers.push(f);
    return f;
  }, log: () => {}, platform: "linux", untrackedFs: new Map(), ...extra });
  return { h, helpers };
}
/** the chain of a file in `tree/sub/deep`: its folders up to the root of the device (the numbers are real, so that the question's stat finds them) */
const chainOf = (p: string) => {
  const out: number[] = [];
  for (let d = path.dirname(p); ; d = path.dirname(d)) {
    out.push(inoOf(d === "." ? "." : d));
    if (d === "." || d === "/") break;
  }
  return out;
};
async function ready(h: Holders, f: Fake) {
  f.send({ type: HT.HELLO, aux: 0, chain: [16 << 20] }, { type: HT.SEEDEND });
  await until(() => h.state === "ready");
}
const ask = (h: Holders, rel: string): Promise<HoldersAnswer> => h.query(path.join(tmp, rel), "/" + rel);

test("holders api: no holder is proven when the table is seeded and has no gap", async () => {
  const { h, helpers } = make();
  h.start();
  assert.equal(h.state, "starting");
  await ready(h, helpers[0]!);
  const a = await ask(h, "tree");
  assert.equal(a.proven, true);
  assert.equal(a.held, false);
  assert.deepEqual(a.holders, []);
  assert.deepEqual(a.reasons, []);
  assert.equal(a.feature.state, "ready");
  h.close();
});

test("holders api: a holder is found by the folders above its file, with its kinds", async () => {
  const { h, helpers } = make();
  h.start();
  const f = helpers[0]!;
  await ready(h, f);
  f.send(
    { type: HT.FD, pid: 500, aux: 3, dev, ino: inoOf("tree/sub/deep/file"), comm: "tail", chain: chainOf("tree/sub/deep/file") },
    { type: HT.CWD, pid: 500, dev, ino: inoOf("tree/sub"), comm: "tail", chain: chainOf("tree/sub") },
    { type: HT.CWD, pid: 501, dev, ino: inoOf("other"), comm: "sh", chain: chainOf("other") },
  );
  await until(() => h.table.procs.has(501));
  const a = await ask(h, "tree");
  assert.equal(a.proven, true);
  assert.equal(a.held, true);
  assert.deepEqual(a.holders.map((x) => ({ pid: x.pid, comm: x.comm, kinds: x.kinds })), [{ pid: 500, comm: "tail", kinds: ["cwd", "fd"] }]);
  assert.deepEqual((await ask(h, "other")).holders.map((x) => x.pid), [501]);
  assert.deepEqual((await ask(h, "tree/sub/deep")).holders.map((x) => x.kinds), [["fd"]], "a deeper path: only what is below it");
  h.close();
});

test("holders api: before the start-up pass ends the answer is not proven, and says why", async () => {
  const { h, helpers } = make();
  h.start();
  helpers[0]!.send({ type: HT.HELLO, chain: [16 << 20] });
  await tick(30);
  const a = await ask(h, "tree");
  assert.equal(a.proven, false);
  assert.ok(a.reasons.some((r) => /start-up pass/.test(r)), a.reasons.join("; "));
  assert.equal(a.feature.state, "starting");
  h.close();
});

test("holders api: lost events of a pid make the manager ask the helper to read it, and the answer is proven after the read", async () => {
  const { h, helpers } = make();
  h.start();
  const f = helpers[0]!;
  await ready(h, f);
  f.onWrite = (s) => {
    if (s === "snap 600\n")
      f.send(
        { type: HT.SNAPBEG, pid: 600, aux: 600 },
        { type: HT.SFD, pid: 600, aux: 4, dev, ino: inoOf("tree/sub/deep/file"), comm: "node", chain: chainOf("tree/sub/deep/file") },
        { type: HT.SNAPEND, pid: 600, aux: 600 },
      );
  };
  f.send({ type: HT.DIRTY, pid: 600 });
  await until(() => f.written.includes("snap 600\n"));
  const a = await ask(h, "tree");
  assert.equal(a.proven, true, a.reasons.join("; "));
  assert.deepEqual(a.holders.map((x) => x.pid), [600]);
  assert.equal(h.snapshots, 1);
  h.close();
});

test("holders api: a pid that cannot be read keeps the answer unproven", async () => {
  const { h, helpers } = make({ settleMs: 100 });
  h.start();
  const f = helpers[0]!;
  await ready(h, f);
  f.onWrite = (s) => {
    const pid = Number(/snap (\d+)/.exec(s)?.[1]);
    if (pid) f.send({ type: HT.SNAPBEG, pid, aux: pid }, { type: HT.SNAPEND, pid, aux: pid, flags: HF_ERROR });
  };
  f.send({ type: HT.DIRTY, pid: 700 });
  await until(() => h.table.gaps().unreadable.includes(700), 5000);
  const a = await ask(h, "tree");
  assert.equal(a.proven, false);
  assert.ok(a.reasons.some((r) => /could not be read/.test(r)));
  assert.equal(f.written.filter((w) => w === "snap 700\n").length, 3, "three tries, then no more");
  h.close();
});

test("holders api: a read that gets no answer counts as failed, not as done", async () => {
  const { h, helpers } = make({ readMs: 40, settleMs: 60 });
  h.start();
  const f = helpers[0]!;
  await ready(h, f);
  f.send({ type: HT.DIRTY, pid: 710 });
  await until(() => h.snapshotFailures >= 1);
  const a = await ask(h, "tree");
  assert.equal(a.proven, false);
  h.close();
});

test("holders api: a mapping is read again before it is reported", async () => {
  const { h, helpers } = make({ mapsFreshMs: 0 });
  h.start();
  const f = helpers[0]!;
  await ready(h, f);
  f.onWrite = (s) => {
    if (s === "snap 800\n") f.send({ type: HT.SNAPBEG, pid: 800, aux: 800 }, { type: HT.SNAPEND, pid: 800, aux: 800 }); // the mapping was released: nothing is held now
  };
  f.send({ type: HT.MMAP, pid: 800, dev, ino: inoOf("tree/sub/deep/file"), comm: "node", chain: chainOf("tree/sub/deep/file") });
  await until(() => h.table.procs.has(800));
  const a = await ask(h, "tree");
  assert.ok(f.written.includes("snap 800\n"));
  assert.deepEqual(a.holders, []);
  assert.equal(a.proven, true, a.reasons.join("; "));
  h.close();
});

test("holders api: lost events of unknown pids make the manager read everything again", async () => {
  const { h, helpers } = make();
  h.start();
  const f = helpers[0]!;
  await ready(h, f);
  f.send({ type: HT.DIRTY, pid: 0 });
  await until(() => f.written.includes("seed\n"));
  const a = await ask(h, "tree");
  assert.equal(a.proven, false);
  f.send({ type: HT.SEEDEND });
  await until(() => h.table.seeded);
  assert.equal((await ask(h, "tree")).proven, true);
  h.close();
});

test("holders api: a missing hook that can lose a hold makes every answer unproven", async () => {
  const { h, helpers } = make();
  h.start();
  helpers[0]!.send({ type: HT.HELLO, aux: 1, chain: [16 << 20] }, { type: HT.SEEDEND });
  await until(() => h.state === "ready");
  const a = await ask(h, "tree");
  assert.equal(a.proven, false);
  assert.ok(a.reasons.some((r) => /hook is missing/.test(r)));
  h.close();
});

test("holders api: a file opened just before the question is found: the helper's records are read before the answer (sync)", async () => {
  const { h, helpers } = make();
  h.start();
  const f = helpers[0]!;
  await ready(h, f);
  // the record is still in the ring when the question comes; the helper copies it before it answers `sync`
  f.beforeSync = [{ type: HT.FD, pid: 910, aux: 3, dev, ino: inoOf("tree/sub/deep/file"), comm: "late", chain: chainOf("tree/sub/deep/file") }];
  const a = await ask(h, "tree");
  assert.ok(f.written.some((w) => /^sync \d+\n$/.test(w)), "the question sent sync");
  assert.deepEqual(a.holders.map((x) => x.pid), [910]);
  assert.equal(a.proven, true, a.reasons.join("; "));
  h.close();
});

test("holders api: a lost record that the helper reports at the sync (pid 0) makes the answer unproven, and the table is read again", async () => {
  const { h, helpers } = make();
  h.start();
  const f = helpers[0]!;
  await ready(h, f);
  f.beforeSync = [{ type: HT.DIRTY, pid: 0 }]; // a FORK or MOVED record was lost
  const a = await ask(h, "tree");
  assert.equal(a.proven, false);
  assert.ok(f.written.includes("seed\n"), "every process is read again");
  assert.ok(a.reasons.some((r) => /unknown processes were lost|start-up pass/.test(r)), a.reasons.join("; "));
  f.send({ type: HT.SEEDEND });
  await until(() => h.table.seeded && !h.table.globalDirty);
  assert.equal((await ask(h, "tree")).proven, true);
  h.close();
});

test("holders api: no answer to sync is not a proof", async () => {
  const { h, helpers } = make({ syncMs: 60 });
  h.start();
  const f = helpers[0]!;
  await ready(h, f);
  f.autoSync = false;
  const a = await ask(h, "tree");
  assert.equal(a.proven, false);
  assert.ok(a.reasons.some((r) => /sync/.test(r)), a.reasons.join("; "));
  h.close();
});

test("holders api: a filesystem where the device number of a file may not be the kernel's (btrfs) is never proven", async () => {
  const why = fsReason(0x9123683e, "the path");
  assert.match(why!, /btrfs/);
  assert.equal(fsReason(0xef53, "the path"), undefined, "ext4");
  assert.equal(fsReason(0x58465342, "the path"), undefined, "xfs");
  assert.equal(fsReason(0x01021994, "the path"), undefined, "tmpfs");
  assert.match(fsReason(0x794c7630, "the path")!, /overlay.*not tracked/);
  assert.match(fsReason(0x1234, "the path")!, /0x1234/);
  // the question reads the type of the real folder: a list that does not have it gives a reason, and the list "any" does not
  const { h, helpers } = make({ provenFs: new Map([[1, "nothing"]]) });
  h.start();
  await ready(h, helpers[0]!);
  const a = await ask(h, "tree");
  assert.equal(a.proven, false);
  assert.ok(a.reasons.some((r) => /device number of a file/.test(r)), a.reasons.join("; "));
  h.close();
  assert.ok(PROVEN_FS.size >= 4);
});

test("holders api: a process that shares its file table, a fork of a multi-threaded parent and a process with an io_uring each make the answer unproven", async () => {
  const { h, helpers } = make();
  h.start();
  const f = helpers[0]!;
  await ready(h, f);
  f.onWrite = (s) => {
    const pid = Number(/snap (\d+)/.exec(s)?.[1]);
    if (pid) f.send({ type: HT.SNAPBEG, pid, aux: pid }, { type: HT.SNAPEND, pid, aux: pid });
  };
  f.send({ type: HT.FD, pid: 920, aux: 3, dev, ino: inoOf("tree/sub/deep/file"), comm: "parent", chain: chainOf("tree/sub/deep/file") });
  f.send({ type: HT.FORK, pid: 920, aux: 921, flags: HF_SHARED });
  await until(() => h.table.procs.has(921));
  let a = await ask(h, "other");
  assert.equal(a.proven, false);
  assert.ok(a.reasons.some((r) => /share a file table/.test(r)), a.reasons.join("; "));
  f.send({ type: HT.EXIT, pid: 921 });
  await until(() => !h.table.procs.has(921));
  a = await ask(h, "other");
  assert.equal(a.proven, true, a.reasons.join("; "));
  assert.ok(f.written.includes("snap 920\n"), "the survivor was read again");
  // a fork of a multi-threaded parent: read before the answer
  f.send({ type: HT.FORK, pid: 920, aux: 922, flags: HF_MT });
  await until(() => h.table.procs.has(922));
  a = await ask(h, "other");
  assert.ok(f.written.includes("snap 922\n"), "the child was read again");
  assert.equal(a.proven, true, a.reasons.join("; "));
  // an io_uring
  f.send({ type: HT.URING, pid: 923, aux: 1 });
  await until(() => h.table.procs.has(923));
  a = await ask(h, "other");
  assert.equal(a.proven, false);
  assert.ok(a.reasons.some((r) => /io_uring/.test(r)), a.reasons.join("; "));
  h.close();
});

test("holders api: a hook that the kernel lacks is named, for each of them", async () => {
  const names = ["dup3", "dup2", "moves", "pivot_root", "replace_fd", "descriptors in a message", "32-bit dup3", "32-bit dup2", "registered files"];
  for (let i = 0; i < names.length; i++) {
    const { h, helpers } = make();
    h.start();
    helpers[0]!.send({ type: HT.HELLO, aux: 1 << i, chain: [16 << 20] }, { type: HT.SEEDEND });
    await until(() => h.state === "ready");
    const a = await ask(h, "tree");
    assert.equal(a.proven, false, names[i]);
    assert.ok(a.reasons.some((r) => /hook is missing/.test(r) && r.includes(names[i]!.replace("32-bit ", ""))), `${names[i]}: ${a.reasons.join("; ")}`);
    h.close();
  }
});

test("holders api: the loop devices and swap files in the path, and overlays of other mount namespaces that use it as a layer, are reported; a namespace that cannot be read is a reason", async () => {
  const fake = fs.mkdtempSync(path.join(os.tmpdir(), "filedeck-holders-root-"));
  try {
    const put = (rel: string, text: string) => {
      fs.mkdirSync(path.dirname(path.join(fake, rel)), { recursive: true });
      fs.writeFileSync(path.join(fake, rel), text);
    };
    put("sys/block/loop3/loop/backing_file", `${tmp}/tree/disk.img\n`);
    put("sys/block/loop4/size", "0\n"); // a loop device without a file
    put("proc/swaps", `Filename Type Size Used Priority\n${tmp}/tree/swapfile file 1024 0 -2\n/dev/sda2 partition 1 0 -3\n`);
    put("proc/1/mountinfo", "36 25 8:1 / / rw - ext4 /dev/sda1 rw\n");
    fs.mkdirSync(path.join(fake, "proc/1/ns"), { recursive: true });
    fs.symlinkSync("mnt:[1]", path.join(fake, "proc/1/ns/mnt"));
    fs.mkdirSync(path.join(fake, "proc/200/ns"), { recursive: true });
    fs.symlinkSync("mnt:[2]", path.join(fake, "proc/200/ns/mnt"));
    put("proc/200/mountinfo", `50 36 0:50 / /merged rw - overlay overlay rw,lowerdir=${tmp}/tree/layer,upperdir=/x/up,workdir=/x/work\n`);
    const { h, helpers } = make({ root: fake, foreignMounts: undefined, kernelHolds: undefined });
    h.start();
    await ready(h, helpers[0]!);
    const a = await h.query(path.join(tmp, "tree"), `${tmp}/tree`);
    assert.deepEqual(a.mounts.map((m) => `${m.reason}:${m.mountpoint}`).sort(), [`loop device:${tmp}/tree/disk.img`, `overlay layer:/merged`, `swap file:${tmp}/tree/swapfile`].sort());
    assert.equal(a.held, true);
    assert.equal(a.proven, true, a.reasons.join("; "));
    // a process whose namespace cannot be read (here: a link that is a file): the namespace may hold an overlay that is not seen
    fs.mkdirSync(path.join(fake, "proc/300"), { recursive: true });
    fs.mkdirSync(path.join(fake, "proc/300/ns"), { recursive: true });
    fs.writeFileSync(path.join(fake, "proc/300/ns/mnt"), "not a link");
    const b = await h.query(path.join(tmp, "other"), `${tmp}/other`);
    assert.equal(b.proven, false);
    assert.ok(b.reasons.some((r) => /could not be read/.test(r)), b.reasons.join("; "));
    h.close();
  } finally {
    fs.rmSync(fake, { recursive: true, force: true });
  }
});

test("holders api: the helper's refusal makes the feature unavailable, with the reason, and no error", async () => {
  const { h, helpers } = make();
  h.start();
  helpers[0]!.stdout.write('{"ok":false,"error":"not permitted: needs CAP_BPF and CAP_PERFMON"}\n');
  await until(() => h.state === "unavailable");
  const a = await ask(h, "tree");
  assert.equal(a.proven, false);
  assert.equal(a.feature.state, "unavailable");
  assert.match(a.feature.reason!, /CAP_BPF/);
  assert.deepEqual(a.holders, []);
  assert.equal(helpers.length, 1, "no restart after a refusal");
  h.close();
});

test("holders api: an unexpected end of the helper starts it again from an empty table", async () => {
  const { h, helpers } = make();
  h.start();
  await ready(h, helpers[0]!);
  helpers[0]!.send({ type: HT.CWD, pid: 900, dev, ino: inoOf("tree"), chain: chainOf("tree") });
  await until(() => h.table.procs.has(900));
  helpers[0]!.emit("exit", 1, null);
  assert.equal(h.state, "starting");
  assert.equal(h.table.procs.size, 0);
  await until(() => helpers.length === 2);
  assert.equal(h.restarts, 1);
  await ready(h, helpers[1]!);
  assert.deepEqual((await ask(h, "tree")).holders, []);
  h.close();
});

test("holders api: off, and not Linux, are said in the answer", async () => {
  const off = new Holders({ helper: "", root: "/", log: () => {} });
  off.start();
  const a = await off.query(tmp, "/x");
  assert.equal(a.feature.state, "disabled");
  assert.equal(a.proven, false);
  const mac = new Holders({ helper: "/x", root: "/", platform: "darwin", log: () => {} });
  mac.start();
  const b = await mac.query(tmp, "/x");
  assert.equal(b.feature.state, "unavailable");
  assert.match(b.feature.reason!, /Linux/);
});

test("holders api: the route answers 200 with the proof flag, asks for a path and keeps to administrators with sign-in on", async () => {
  const { h, helpers } = make();
  h.start();
  await ready(h, helpers[0]!);
  const open = new Hono();
  open.onError(agentError);
  registerHolderRoutes(open, { root: tmp, auth: false } as unknown as Config, h);
  const ok = await open.request("/api/v1/holders?path=/tree");
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get("cache-control"), "no-store");
  const body = (await ok.json()) as HoldersAnswer;
  assert.equal(body.path, "/tree");
  assert.equal(body.proven, true);
  assert.equal((await open.request("/api/v1/holders")).status, 400);
  const guarded = new Hono();
  guarded.use("*", async (c, next) => {
    c.set("user" as never, { admin: c.req.header("x-admin") === "1" } as never);
    await next();
  });
  registerHolderRoutes(guarded, { root: tmp, auth: true } as unknown as Config, h);
  assert.equal((await guarded.request("/api/v1/holders?path=/tree")).status, 403);
  assert.equal((await guarded.request("/api/v1/holders?path=/tree", { headers: { "x-admin": "1" } })).status, 200);
  h.close();
});

test("holders api: the metrics name the table, the event rate, the ring drops and the unproven pids", async () => {
  const { h, helpers } = make();
  h.start();
  await ready(h, helpers[0]!);
  helpers[0]!.send({ type: HT.STATS, chain: [1000, 3, 16 << 20] });
  await until(() => h.drops === 3);
  const m = h.metrics().join("\n");
  for (const name of ["filedeck_holders_available 1", "filedeck_holders_table_pids", "filedeck_holders_events_total 1000", "filedeck_holders_events_per_second", "filedeck_holders_ring_drops_total 3", "filedeck_holders_unproven_pids 0"])
    assert.ok(m.includes(name), name);
  h.close();
});

test("holders api: container and pod come from the cgroup text", () => {
  const id = "a".repeat(64);
  assert.deepEqual(parseCgroup(`0::/kubepods.slice/kubepods-burstable.slice/kubepods-burstable-pod0f1e2d3c_4b5a_6978_8695_a4b3c2d1e0f9.slice/cri-containerd-${id}.scope\n`), { container: "a".repeat(12), pod: "0f1e2d3c-4b5a-6978-8695-a4b3c2d1e0f9" });
  assert.deepEqual(parseCgroup("0::/user.slice/user-1000.slice/session-3.scope\n"), {});
  assert.deepEqual(parseCgroup(`12:cpu:/docker/${id}\n`), { container: "a".repeat(12) });
});

test("holders api: mounts inside a path and overlay layers that use it are reported", () => {
  const info = [
    "36 25 8:1 / / rw - ext4 /dev/sda1 rw",
    "40 36 8:2 / /data/work/vol rw - ext4 /dev/sdb1 rw",
    "41 36 0:40 / /data/work rw - ext4 /dev/sdb2 rw",
    "50 36 0:50 / /run/containerd/rootfs rw - overlay overlay rw,lowerdir=/data/work/snap/1:/data/work/snap/2,upperdir=/var/x/fs,workdir=/var/x/work",
    "51 36 0:51 / /mnt/space\\040name/sub rw - ext4 /dev/sdc rw",
    "52 36 0:52 / /data/workshop rw - ext4 /dev/sdd rw",
  ].join("\n");
  assert.deepEqual(mountsUnder(info, "/data/work"), [
    { mountpoint: "/data/work/vol", fstype: "ext4", reason: "mount inside" },
    { mountpoint: "/run/containerd/rootfs", fstype: "overlay", reason: "overlay layer" },
  ]);
  assert.deepEqual(mountsUnder(info, "/mnt/space name"), [{ mountpoint: "/mnt/space name/sub", fstype: "ext4", reason: "mount inside" }]);
  assert.deepEqual(mountsUnder(info, "/nowhere"), []);
});
