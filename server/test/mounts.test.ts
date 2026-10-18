import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../src/config.ts";
import { parseMounts, rebaseMountTable, readMountTable } from "../src/mounts.ts";

const hostTable = "/dev/nvme0n1p2 / ext4 rw 0 0\n/dev/nvme0n1p3 /home ext4 rw 0 0\nproc /proc proc rw 0 0\n";
const containerTable = [
  "overlay / overlay rw 0 0",
  "/dev/nvme0n1p2 /host ext4 rw 0 0",
  "/dev/nvme0n1p3 /host/home ext4 rw 0 0",
  "/dev/nvme0n1p2 /tmp ext4 rw 0 0",
  "/dev/nvme0n1p2 /var/lib/filedeck ext4 rw 0 0",
  "",
].join("\n");

test("host-style table parses to host mounts", () => {
  assert.deepEqual(parseMounts(hostTable).map((m) => m.mountpoint), ["/", "/home"]);
});

test("container-style table is rebased to host mount points and drops entries outside root", () => {
  const m = parseMounts(rebaseMountTable(containerTable, "/host"));
  assert.deepEqual(m.map((x) => [x.device, x.mountpoint]), [["/dev/nvme0n1p2", "/"], ["/dev/nvme0n1p3", "/home"]]);
  assert.equal(rebaseMountTable(hostTable, "/"), hostTable);
});

test("readMountTable falls back to the rebased /proc/mounts when /proc/1/mounts is unreadable", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "filedeck-mt-"));
  try {
    fs.mkdirSync(path.join(root, "proc"));
    fs.writeFileSync(path.join(root, "proc/mounts"), containerTable.replaceAll("/host", root));
    const out = parseMounts(await readMountTable(root, `${root}/proc/1/mounts`));
    assert.deepEqual(out.map((x) => x.mountpoint), ["/", "/home"]);
    assert.equal(await readMountTable(root, `${root}/elsewhere`), "");
    fs.writeFileSync(path.join(root, "proc/1-direct"), hostTable);
    assert.equal(await readMountTable(root, path.join(root, "proc/1-direct")), hostTable);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("config default mount table: host init for a host root, own table for /", () => {
  assert.equal(loadConfig({ FILEDECK_ROOT: "/host" } as NodeJS.ProcessEnv).procMounts, "/host/proc/1/mounts");
  assert.equal(loadConfig({ FILEDECK_ROOT: "/" } as NodeJS.ProcessEnv).procMounts, "/proc/mounts");
  assert.equal(loadConfig({ FILEDECK_ROOT: "/host", FILEDECK_PROC_MOUNTS: "/x" } as NodeJS.ProcessEnv).procMounts, "/x");
});
