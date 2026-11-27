import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import { createAdaptorServer } from "@hono/node-server";
import { Hono } from "hono";
import { agentAuth, agentUser, DISK_VERIFY_PATH } from "../src/agent-auth.ts";
import { signClaim, USER_HEADER } from "../src/auth/identity.ts";
import { loadConfig } from "../src/config.ts";
import { createHub } from "../src/hub.ts";
import { DiskDevices, diskIdentity, inventoryMetadata, requireSafeDisk, validateSmart, type GuardEvidence, type Pin } from "../src/disk-verify-device.ts";
import { compareSmart, DiskVerify, registerDiskVerify, requireResume, selfTestEvidence, VerifyStore } from "../src/disk-verify.ts";

const safe: GuardEvidence = {
  name: "sdb", target: "/dev/sdb", pinnedDevice: "8:16", sysDevice: "8:16", pinnedSequence: "19", sysSequence: "19",
  partitions: [], holders: [], mounted: ["8:1"], swap: [], slaves: [], bootBacked: true, readOnly: "0", removable: "0",
  serial: "SYNTHETIC-A", smartSerial: "SYNTHETIC-A", copies: 1,
};

test("the destructive guard requires complete host and device evidence", async (t) => {
  assert.doesNotThrow(() => requireSafeDisk(safe));
  const cases: [string, Partial<GuardEvidence>, RegExp][] = [
    ["missing by-id target", { target: "" }, /by-id/],
    ["ambiguous alias", { target: "/dev/sdc" }, /by-id/],
    ["raw mapper node", { name: "dm-0", target: "/dev/dm-0" }, /by-id/],
    ["partition", { partitions: ["sdb1"] }, /partitions/],
    ["root or boot mount", { mounted: ["8:16"] }, /mount/],
    ["unresolved boot backing", { bootBacked: false }, /root backing/],
    ["active swap", { swap: ["8:16"] }, /swap/],
    ["md RAID", { holders: ["md0"] }, /storage stack/],
    ["LVM", { holders: ["dm-0"] }, /storage stack/],
    ["ZFS holder", { holders: ["zvol0"] }, /storage stack/],
    ["device mapper", { slaves: ["sda"] }, /storage stack/],
    ["missing sysfs information", { sysDevice: "" }, /changed/],
    ["hotplug with reused name and device number", { sysSequence: "20" }, /changed/],
    ["device race", { sysDevice: "8:32" }, /changed/],
    ["missing read-only evidence", { readOnly: "" }, /read-only/],
    ["removable drive", { removable: "1" }, /removable/],
    ["missing unique serial", { serial: "" }, /serial/],
    ["duplicate serial", { copies: 2 }, /serial/],
    ["wrong firmware serial", { smartSerial: "REPLACEMENT" }, /serial/],
  ];
  for (const [name, change, expected] of cases) {
    await t.test(name, () => assert.throws(() => requireSafeDisk({ ...safe, ...change }), expected));
  }
});

const disk = { name: "sdb", model: "Fixture", serial: safe.serial, transport: "sata", size: 64 * 1024, byId: "ata-fixture", majorMinor: "8:16", discard: 4096 };
const identity = { disk, sequence: "19", boot: "fixture-boot", sector: 512 };

test("inventory uses host udev metadata when lsblk cannot access the device", () => {
  const data = "S:disk/by-id/ata-fixture-part1\nS:disk/by-id/ata-fixture\nE:ID_MODEL=Fixture\nE:ID_SERIAL_SHORT=SYNTHETIC-A\nE:ID_BUS=ata\nE:ID_ATA_SATA=1";
  const { byId, ...row } = disk;
  assert.deepEqual(inventoryMetadata({ ...row, model: "", serial: "", transport: "" }, data), {
    disk: row, aliases: [byId],
  });
  assert.equal(inventoryMetadata({ ...row, serial: "kernel" }, data).disk.serial, "kernel");
});

test("resume checks physical drive identity, namespace sequence and host boot", () => {
  const saved = diskIdentity(identity);
  assert.doesNotThrow(() => requireResume(saved, identity));
  assert.throws(() => requireResume(saved, { ...identity, sequence: "20" }), /different device/);
  assert.throws(() => requireResume(saved, { ...identity, boot: "rebooted" }), /different device/);
  for (const change of [{ serial: "OTHER" }, { byId: "ata-other" }, { size: 128 * 1024 }, { majorMinor: "8:32" }])
    assert.throws(() => requireResume(saved, { ...identity, disk: { ...disk, ...change } }), /different device/);
});

const smart = (serial = safe.serial) => validateSmart(0, {
  serial_number: serial, device: { protocol: "ATA" },
  smart_status: { passed: true },
  ata_smart_attributes: { table: [{ name: "SSD_Life_Left", value: 90 }, { name: "Reallocated_Sector_Ct", raw: { value: 0 } }] },
  ata_smart_data: { self_test: { status: { value: 0 } } },
  ata_smart_self_test_log: { standard: { count: 0 } },
}, serial);

test("SMART identity and health require positive evidence and preserve SMART warnings", () => {
  const baseline = smart();
  assert.throws(() => validateSmart(4, baseline.data, safe.serial), /missing or mismatched/);
  assert.throws(() => validateSmart(0, baseline.data, "wrong serial"), /missing or mismatched/);
  assert.throws(() => compareSmart(baseline, { exit: 0, data: {} }), /health evidence/);
  const fail = compareSmart(baseline, { exit: 8, data: { ...baseline.data, smart_status: { passed: false } } });
  assert.equal(fail.fail, true);
  assert.deepEqual(compareSmart(baseline, baseline), { fail: false, findings: [] });
  assert.ok(compareSmart(baseline, { ...baseline, exit: 64 }).findings.length);
  const nvme = selfTestEvidence({ exit: 0, data: { device: { protocol: "NVMe" },
    nvme_self_test_log: { current_self_test_operation: { value: 0 } } } });
  assert.deepEqual([nvme.supported, nvme.running], [true, false]);
  const scsi = selfTestEvidence({ exit: 0, data: { device: { protocol: "SCSI" },
    scsi_self_test_0: { result: { value: 0 }, code: { value: 2 } } } });
  assert.deepEqual([scsi.supported, scsi.running, scsi.code, scsi.kind], [true, false, 0, 2]);
  const scsiData = { device: { protocol: "SCSI" } };
  assert.equal(selfTestEvidence({ exit: 0, data: scsiData }).supported, false);
  const empty = selfTestEvidence({ exit: 0, data: { ...scsiData, smartctl: { output: ["No Self-tests have been logged"] } } });
  assert.deepEqual([empty.supported, empty.running], [true, false]);
  const progress = selfTestEvidence({ exit: 0, data: { ...scsiData,
    scsi_self_test_0: { result: { value: 15 }, code: { value: 2 }, self_test_in_progress: true },
    smartctl: { output: ["Self-test execution status:\t\t40% of test remaining"] } } });
  assert.deepEqual([progress.supported, progress.running, progress.complete], [true, true, 60]);
});

class Fixture extends DiskDevices {
  pinned = new Set<string>();
  trace: string[] = [];
  waitAt?: string;
  failGuardAt?: number;
  probes = 0;
  constructor() { super(new Set(), ""); }

  override async pin(byId: string, serial: string): Promise<Pin> {
    if (this.pinned.has(serial)) throw new Error("Device already claimed");
    this.pinned.add(serial);
    return { ...identity, disk: { ...disk, byId, serial },
      file: { close: async () => { this.pinned.delete(serial); } } as Pin["file"] };
  }

  override async guard(pin: Pin) {
    this.trace.push(`${pin.disk.serial}:guard`);
    if (++this.probes === this.failGuardAt) throw new Error("Disk has a storage membership signature");
  }

  override async smart(pin: Pin) { return smart(pin.disk.serial); }

  override async command(pin: Pin, operation: string, args: string[], signal?: AbortSignal) {
    this.trace.push(`${pin.disk.serial}:${operation}`);
    if (this.waitAt === operation) await sleep(60_000, undefined, { signal });
    return args[1] ? `${args[1]} 0.004` : "";
  }
}

function verifier() {
  const fixture = new Fixture();
  const db = new DatabaseSync(":memory:");
  const store = new VerifyStore(db);
  return { fixture, db, store, verify: new DiskVerify(fixture, store, true) };
}

const full = { byId: disk.byId, serial: disk.serial, kind: "full" as const, actor: "sys:fixture", epoch: 4, fingerprint: diskIdentity(identity) };
async function terminal(verify: DiskVerify, id: string) {
  for (let i = 0; i < 100; i++) {
    const data = verify.job(id);
    if (data && data.state !== "running") return data;
    await sleep(10);
  }
  throw new Error("Fixture job did not complete");
}

test("a full run probes before every media command and stores its per-serial outcome", async () => {
  const { fixture, verify, db } = verifier();
  try {
    const run = await verify.start(full);
    const done = await terminal(verify, run.id);
    assert.equal(done.state, "pass");
    assert.equal(done.details.fill?.bytes, disk.size);
    assert.equal(done.details.verify?.bytes, disk.size);
    assert.equal(done.details["random-read"]?.bytes, disk.size);
    const prefix = disk.serial + ":";
    for (const [i, entry] of fixture.trace.entries()) {
      if (!entry.endsWith(":guard")) assert.equal(fixture.trace[i - 1], prefix + "guard");
    }
    assert.ok(fixture.trace.includes(prefix + "discard"));
    assert.ok(fixture.trace.includes(prefix + "wipefs"));
    assert.equal(verify.list(disk.serial)[0]?.id, run.id);
    assert.deepEqual(verify.list("absent"), []);
  } finally {
    await verify.close();
    db.close();
  }
});

test("late signature, stale inventory, opt-in and revocation all fail closed", async () => {
  const { fixture, verify, store, db } = verifier();
  try {
    await assert.rejects(new DiskVerify(fixture, store, false).start(full), /configured native/);
    await assert.rejects(verify.start({ ...full, fingerprint: "stale" }), /changed after inventory/);
    fixture.failGuardAt = 3;
    const job = await verify.start(full);
    const done = await terminal(verify, job.id);
    assert.equal(done.state, "fail");
    assert.match(done.error!, /signature/);
    assert.ok(!fixture.trace.includes(disk.serial + ":capacity-read"));
    verify.revoke(full.actor, full.epoch + 1);
    await assert.rejects(verify.start(full), /credentials changed/);
  } finally {
    await verify.close();
    db.close();
  }
});

test("same disk is exclusive, distinct disks can run, cancel checkpoints and a new runner resumes", async () => {
  const { fixture, verify, store, db } = verifier();
  const replacement = new DiskVerify(fixture, store, true);
  try {
    fixture.waitAt = "verify";
    const a = await verify.start(full);
    await assert.rejects(replacement.start(full), /already claimed/);
    const bDisk = { ...disk, byId: "ata-fixture-b", serial: "SYNTHETIC-B" };
    const b = await verify.start({ ...full, ...bDisk, fingerprint: diskIdentity({ ...identity, disk: bDisk }) });
    assert.equal(verify.activeCount(), 2);
    for (let i = 0; i < 100 && !fixture.trace.includes(disk.serial + ":verify"); i++) await sleep(10);
    assert.ok(fixture.trace.includes(disk.serial + ":verify"));
    verify.cancel(a.id);
    const paused = await terminal(verify, a.id);
    assert.equal(paused.state, "paused");
    assert.equal(paused.phase, "verify");
    fixture.waitAt = undefined;
    fixture.trace = [];
    await replacement.start({ ...full, resume: a.id });
    assert.equal((await terminal(replacement, a.id)).state, "pass");
    assert.ok(!fixture.trace.includes(disk.serial + ":capacity-write"));
    verify.cancel(b.id);
    assert.equal((await terminal(verify, b.id)).state, "paused");
  } finally {
    await Promise.all([verify.close(), replacement.close()]);
    db.close();
  }
});

test("a SMART self-test requires a fresh passing result of the requested type", async () => {
  const { fixture, verify, db } = verifier();
  const head = smart();
  fixture.smart = async () => fixture.trace.includes(disk.serial + ":smart") ? {
    ...head, data: { ...head.data, ata_smart_self_test_log: { standard: { count: 1,
      table: [{ status: { value: 0 }, type: { value: 1 }, lifetime_hours: 10 }],
    } } },
  } : head;
  try {
    const run = await verify.start({ ...full, kind: "short" });
    for (let i = 0; i < 500 && verify.job(run.id)?.state === "running"; i++) await sleep(10);
    const completed = verify.job(run.id);
    assert.equal(completed?.state, "pass");
    assert.equal(completed?.offset, 100);
    assert.deepEqual(fixture.trace, [`${disk.serial}:guard`, `${disk.serial}:guard`, `${disk.serial}:smart`]);
  } finally {
    await verify.close();
    db.close();
  }
});

const token = "fixture-agent";
test("agent routes require an authenticated, node-scoped administrator claim and exact confirmation", async () => {
  const cfg = loadConfig({ FILEDECK_AUTH: "on", FILEDECK_AGENT_TOKEN: token, FILEDECK_NODE: "fixture" });
  const app = new Hono();
  app.use("*", agentAuth(cfg.agentToken), agentUser(cfg));
  const feature = registerDiskVerify(app, cfg);
  const base = { kind: "sys", name: "fixture", epoch: 1, iat: Date.now() } as const;
  const headers = (claim: Parameters<typeof signClaim>[0]) => ({
    authorization: `Bearer ${token}`, [USER_HEADER]: signClaim(claim, token), "content-type": "application/json",
  });
  const admin = { ...base, admin: true, diskVerify: { node: "fixture", action: "operate" } } as const;
  try {
    assert.equal((await app.request(DISK_VERIFY_PATH)).status, 401);
    assert.equal((await app.request(DISK_VERIFY_PATH, { headers: headers(base) })).status, 403);
    assert.equal((await app.request(DISK_VERIFY_PATH, { headers: headers({ ...admin, diskVerify: { ...admin.diskVerify, node: "elsewhere" } }) })).status, 403);
    assert.equal((await app.request(DISK_VERIFY_PATH, { headers: headers(admin) })).status, 404);
    const start = (confirm: string) => app.request(DISK_VERIFY_PATH + "/start", { method: "POST", headers: headers(admin), body: JSON.stringify({
      ...full, confirm,
    }) });
    assert.equal((await start("wrong serial")).status, 400);
    assert.equal((await start(disk.serial)).status, 409);
    assert.equal((await app.request(DISK_VERIFY_PATH + "/revoke", { method: "POST", headers: headers(admin) })).status, 403);
    assert.equal((await app.request("/api/info", { headers: headers(admin) })).status, 403);
  } finally { await feature.close(); }
});

test("hub denies anonymous inventory and the generic disk proxy with auth disabled", async () => {
  const hub = createHub(loadConfig({ FILEDECK_MODE: "hub", NODES: "fixture=http://127.0.0.1:1" }));
  try {
    assert.equal((await hub.request(DISK_VERIFY_PATH)).status, 403);
    assert.equal((await hub.request("/api/nodes/fixture" + DISK_VERIFY_PATH)).status, 404);
  } finally { await hub.close(); }
});

test("hub routes signed administrator requests to all agents", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "filedeck-disk-auth-"));
  const password = "synthetic-fixture-password";
  const calls: string[] = [];
  const servers = [];
  try {
    const nodes = [];
    for (const name of ["a", "b"]) {
      const cfg = loadConfig({ FILEDECK_AUTH: "on", FILEDECK_AGENT_TOKEN: token, FILEDECK_NODE: name });
      const agent = new Hono();
      agent.use("*", agentAuth(token), agentUser(cfg));
      agent.get(DISK_VERIFY_PATH, (c) => {
        calls.push(name + ":" + c.get("user").name);
        return c.json({ disks: [], jobs: [], writable: false });
      });
      agent.get(DISK_VERIFY_PATH + "/history", (c) => c.json({ jobs: [], serial: c.req.query("serial") }));
      agent.post(DISK_VERIFY_PATH + "/start", async (c) => c.json({ node: name, actor: c.get("user").name, body: await c.req.json() }, 202));
      const server = createAdaptorServer({ fetch: agent.fetch });
      servers.push(server);
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      });
      nodes.push(name + "=http://127.0.0.1:" + (server.address() as AddressInfo).port);
    }
    const hub = createHub(loadConfig({
      FILEDECK_MODE: "hub", FILEDECK_AUTH: "on", FILEDECK_AGENT_TOKEN: token,
      FILEDECK_AUTH_FILE: path.join(dir, "auth.db"), FILEDECK_DIFF_DIR: path.join(dir, "diff"),
      FILEDECK_ADMINS: "alice", NODES: nodes.join(","),
    }), undefined, undefined, { system: { password: async (_name, pw) => pw === password, key: async () => false } });
    try {
      const signIn = async (name: string) => {
        const response = await hub.request("https://localhost/api/auth/login", {
          method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name, password }),
        }, { incoming: { socket: { remoteAddress: "127.0.0.1", encrypted: false } } } as never);
        assert.equal(response.status, 200);
        return response.headers.get("set-cookie")!.split(";")[0]!;
      };
      assert.equal((await hub.request(DISK_VERIFY_PATH, { headers: { cookie: await signIn("bob") } })).status, 403);
      assert.deepEqual(calls, []);
      const headers = { cookie: await signIn("alice") };
      const response = await hub.request(DISK_VERIFY_PATH, { headers });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), {
        nodes: ["a", "b"].map((node) => ({ node, disks: [], jobs: [], writable: false })),
      });
      assert.deepEqual(calls.sort(), ["a:alice", "b:alice"]);
      const history = await hub.request(DISK_VERIFY_PATH + "/nodes/b/history?serial=FIXTURE%2BA", { headers });
      assert.equal(history.status, 200);
      assert.deepEqual(await history.json(), { jobs: [], serial: "FIXTURE+A" });
      const start = await hub.request(DISK_VERIFY_PATH + "/nodes/b/start", {
        method: "POST", headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ ...full, confirm: full.serial }),
      });
      assert.equal(start.status, 202);
      assert.deepEqual(await start.json(), { node: "b", actor: "alice", body: { ...full, confirm: full.serial } });
      assert.equal((await hub.request(DISK_VERIFY_PATH + "/nodes/b/revoke", { method: "POST", headers })).status, 404);
    } finally { await hub.close(); }
  } finally {
    await Promise.all(servers.map((server) => new Promise<void>((resolve) => {
      server.close(() => resolve());
    })));
    await fs.rm(dir, { recursive: true });
  }
});

test("native transfer and signature detection use only an owned regular-file fixture", async () => {
  // The opt-in command selects the fixture directory. The shim rejects real block nodes.
  const root = process.env.FILEDECK_DISK_VERIFY_TEST_DIR;
  if (!root) return;
  const { execFileSync } = await import("node:child_process");
  const { join } = await import("node:path");
  const { runTool } = await import("../src/disk-verify-device.ts");
  const dir = await fs.mkdtemp(join(root, "native-fixture-"));
  const binary = join(dir, "helper");
  const image = join(dir, "disk.img");
  try {
    execFileSync("cc", ["-Wall", "-Wextra", "-Werror", "-o", binary, new URL("disk-verify-fixture.c", import.meta.url).pathname, "-lblkid", "-lcrypto"]);
    const file = await fs.open(image, "wx+");
    try {
      const length = 16 * 1024 * 1024 + 512;
      await file.truncate(length);
      const key = "13".repeat(32);
      const run = (operation: string, ...args: string[]) => runTool(binary, [operation, "19", String(length), "512", ...args], { file });
      await assert.rejects(runTool(binary, ["write", "20", String(length), "512", "0", "4096", key], { file }), /geometry changed/);
      await run("probe");
      await run("capacity-write", "0", "16384", key);
      await run("capacity-read", "0", "16384", key);
      // Simulate a device that returns the bytes of a different sampled address.
      const aliased = Buffer.alloc(4096);
      await file.read(aliased, 0, aliased.length, 0);
      await file.write(aliased, 0, aliased.length, 1365 * 4096);
      await assert.rejects(run("capacity-read", "0", "16384", key), /Data mismatch/);
      await run("write", "0", String(length), key);
      await run("verify", "0", String(length), key);
      await file.write(Buffer.alloc(512, 255), 0, 512, 2 * 1024 * 1024);
      await assert.rejects(run("verify", "0", String(length), key), /Data mismatch at byte 2097152/);
      await file.write(Buffer.from([0x55, 0xaa]), 0, 2, 510);
      await assert.rejects(run("write", "0", "4096", key), /signature/);
      await assert.rejects(run("discard", "0", "4096"), /signature/);
      await assert.rejects(run("wipefs"), /signature/);
      const marker = Buffer.alloc(2);
      await file.read(marker, 0, 2, 510);
      assert.deepEqual(marker, Buffer.from([0x55, 0xaa]));
      await file.truncate(0);
      await file.truncate(length);
      const label = Buffer.alloc(512);
      label.write("LABELONE");
      label.writeBigUInt64LE(1n, 8);
      label.writeUInt32LE(32, 20);
      label.write("LVM2 001", 24);
      label.write("abcdef0123456789abcdef0123456789", 32);
      let crc = 0xf597a6cf;
      for (const byte of label.subarray(20)) {
        crc ^= byte;
        for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
      }
      label.writeUInt32LE(crc >>> 0, 16);
      await file.write(label, 0, label.length, 512);
      await assert.rejects(run("probe"), /storage membership signature/);
      await file.truncate(0);
      await file.truncate(length);
      const verity = Buffer.alloc(16);
      verity.write("verity");
      verity.writeUInt32LE(1, 8);
      await file.write(verity, 0, verity.length, 0);
      await assert.rejects(run("probe"), /storage membership signature/);
      await file.truncate(0);
      await file.truncate(length);
      const raid = Buffer.alloc(256);
      raid.writeUInt32LE(0xa92b4efc);
      raid.writeUInt32LE(1, 4);
      raid.writeBigUInt64LE(8n, 144);
      await file.write(raid, 0, raid.length, 4096);
      await assert.rejects(run("probe"), /storage membership signature/);
      await file.truncate(0);
      await file.truncate(length);
      const uberblock = Buffer.alloc(8);
      uberblock.writeBigUInt64LE(0x00bab10cn);
      await file.write(uberblock, 0, uberblock.length, 128 * 1024);
      await assert.rejects(run("probe"), /storage membership signature/);
    } finally {
      await file.close();
    }
  } finally {
    await fs.rm(dir, { recursive: true });
  }
});
