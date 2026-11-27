import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { DriveMap, mountInfoForRoot, parseMountInfo, type MountIdentity } from "../src/group-mounts.ts";

test("mountinfo keeps filesystem roots, encoded names and topmost targets", () => {
  const rows = parseMountInfo([
    "38 24 8:1 / / rw shared:2 - ext4 /dev/sda1 rw",
    String.raw`44 38 8:1 /backups\040old /host/bind\040data rw - ext4 /dev/sda1 rw`,
    "45 38 8:1 /other /host/bind rw - ext4 /dev/sda1 rw",
    "46 38 8:2 / /host/bind rw - ext4 /dev/sda2 rw",
    "invalid",
  ].join("\n"));
  assert.equal(rows[1]?.root, "/backups old");
  assert.equal(rows[1]?.mountpoint, "/host/bind data");
  assert.deepEqual(mountInfoForRoot(rows, "/host").map(({ mountpoint, root, dev }) => ({ mountpoint, root, dev })), [
    { mountpoint: "/", root: "/host", dev: "8:1" },
    { mountpoint: "/bind data", root: "/backups old", dev: "8:1" },
    { mountpoint: "/bind", root: "/", dev: "8:2" },
  ]);
});

test("resolve partition, LVM, RAID and multi-device btrfs from sysfs fixtures", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "filedeck-block-fixture-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const inRoot = (p: string) => path.join(root, p);
  async function file(p: string, contents: string) {
    await fs.mkdir(path.dirname(inRoot(p)), { recursive: true });
    await fs.writeFile(inRoot(p), contents);
  }
  async function link(p: string, target: string) {
    await fs.mkdir(path.dirname(inRoot(p)), { recursive: true });
    await fs.symlink(inRoot(target), inRoot(p));
  }
  await file("sys/devices/disk-a/device/model", "Drive A \n");
  await file("sys/devices/disk-b/device/model", "Drive B\n");
  await file("sys/devices/disk-a/part-a/partition", "1\n");
  await file("sys/devices/disk-b/part-b/partition", "1\n");
  await link("sys/class/block/disk-a", "sys/devices/disk-a");
  await link("sys/class/block/disk-b", "sys/devices/disk-b");
  await link("sys/class/block/part-a", "sys/devices/disk-a/part-a");
  await link("sys/class/block/part-b", "sys/devices/disk-b/part-b");
  await link("sys/dev/block/8:1", "sys/devices/disk-a/part-a");
  await link("sys/class/block/dm-0", "sys/devices/dm-0");
  await link("sys/dev/block/253:0", "sys/devices/dm-0");
  await link("sys/devices/dm-0/slaves/md0", "sys/devices/md0");
  await link("sys/class/block/md0", "sys/devices/md0");
  await link("sys/dev/block/9:0", "sys/devices/md0");
  await link("sys/devices/md0/slaves/part-a", "sys/devices/disk-a/part-a");
  await link("sys/devices/md0/slaves/part-b", "sys/devices/disk-b/part-b");
  await link("sys/fs/btrfs/example/devices/part-a", "sys/devices/disk-a/part-a");
  await link("sys/fs/btrfs/example/devices/part-b", "sys/devices/disk-b/part-b");
  await link("dev/mapper/volume", "dev/dm-0");
  await file("dev/dm-0", "");
  const map = new DriveMap(inRoot("sys"), inRoot("dev"));
  const describe = (dev: string, device: string, fstype = "ext4") =>
    map.describe({ id: 1, dev, device, fstype, root: "/", mountpoint: "/" } satisfies MountIdentity);
  const a = { name: "disk-a", model: "Drive A" };
  const b = { name: "disk-b", model: "Drive B" };
  assert.deepEqual((await describe("8:1", "/dev/part-a")).drives, [a]);
  assert.deepEqual((await describe("253:0", "/dev/mapper/volume")).drives, [a, b]);
  assert.deepEqual((await describe("9:0", "/dev/md0")).drives, [a, b]);
  const btrfsA = await describe("0:45", "/dev/part-a", "btrfs");
  const btrfsB = await describe("0:46", "/dev/part-b", "btrfs");
  assert.deepEqual(btrfsA.drives, [a, b]);
  assert.equal(btrfsA.fsKey, btrfsB.fsKey);
  assert.deepEqual((await describe("8:99", "/dev/missing")).drives, []);
});
