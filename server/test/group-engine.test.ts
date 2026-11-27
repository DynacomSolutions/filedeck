import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { groupStorage, type StoredGroupSize } from "../src/group-engine.ts";
import type { GroupMount } from "../src/group-mounts.ts";
import { parseGroupRules } from "../src/group-rules.ts";
import { SizeStore } from "../src/size-store.ts";

const root = { id: 1, mountpoint: "/", root: "/", device: "/dev/disk1", dev: "8:1",
  fsKey: "fs1", fstype: "ext4", drives: [{ name: "disk", model: "Drive" }] };
const bind = { ...root, id: 2, mountpoint: "/copy", root: "/data" };
const mount2 = { ...root, id: 3, mountpoint: "/second", dev: "8:2", fsKey: "fs2", device: "/dev/disk2" };
const rule = (name: string, paths: string[], exclude?: string[]) => ({ name, paths, exclude });
const sample = (bytes: number, fields: Partial<StoredGroupSize> = {}): StoredGroupSize =>
  ({ bytes, dev: 2049, scannedAt: 100, stale: false, errors: 0, files: 100, links: 0, linkChecked: 100, ...fields });

const run = (rules: ReturnType<typeof rule>[], rows: Record<string, StoredGroupSize>, mounts: GroupMount[] = [root],
  used = 1000, statDevices: Record<string, number> = {}) =>
  groupStorage(mounts, parseGroupRules(JSON.stringify({ local: rules }), "local"),
    (p) => Promise.resolve(rows[p] ?? null), () => Promise.resolve({ used, capacity: 4000 }), () => true,
    async (p) => statDevices[p] ?? ([...mounts].sort((a, b) => b.mountpoint.length - a.mountpoint.length)
      .find((m) => m.mountpoint === "/" || p === m.mountpoint || p.startsWith(m.mountpoint + "/"))?.dev === "8:2" ? 2050 : 2049));
const byName = (drives: Awaited<ReturnType<typeof run>>) => Object.fromEntries(drives[0]?.groups.map((g) => [g.name, g]) ?? []);

test("longest prefix wins across nested rules and exclusions; freshness follows dependencies", async () => {
  const groups = byName(await run(
    [rule("A", ["/data", "/data/archive"], ["/data/tmp"]), rule("B", ["/data/archive/keep"]), rule("C", ["/database"])],
    { "/data": sample(600), "/data/archive": sample(200), "/data/archive/keep": sample(50, { scannedAt: 50, stale: true }),
      "/data/tmp": sample(40, { scannedAt: 70 }), "/database": sample(20) },
  ));
  assert.equal(groups.A?.bytes, 510);
  assert.equal(groups.A?.scannedAt, 50);
  assert.equal(groups.A?.stale, true);
  assert.equal(groups.B?.bytes, 50);
  assert.equal(groups.C?.bytes, 20);
  assert.equal(groups.Unattributed?.bytes, 420);
});

test("a missing boundary keeps the ambiguous parent in the remainder", async () => {
  const groups = byName(await run([rule("A", ["/data"], ["/data/missing"]), rule("B", ["/data/keep"])],
    { "/data": sample(600), "/data/keep": sample(50, { scannedAt: 49 }) }));
  assert.equal(groups.A?.bytes, 0);
  assert.equal(groups.A?.notStored, true);
  assert.equal(groups.A?.scannedAt, 49);
  assert.equal(groups.B?.bytes, 50);
  assert.equal(groups.Unattributed?.bytes, 950);
});

test("read bind roots and remove their same-device totals and duplicate capacity", async () => {
  const groups = byName(await run([rule("Root", ["/"]), rule("Data", ["/data", "/copy"])],
    { "/": sample(900), "/data": sample(300), "/copy": sample(300) }, [root, bind]));
  assert.equal(groups.Root?.bytes, 300);
  assert.equal(groups.Data?.bytes, 300);
  assert.equal(groups.Unattributed?.bytes, 400);
});

test("deduct a same-device bind target even when an overmount hides its source", async () => {
  const hidden = { ...mount2, mountpoint: "/hidden" };
  const target = { ...bind, mountpoint: "/srv/b", root: "/hidden/b" };
  const groups = byName(await run([rule("A", ["/"])], {
    "/": sample(900), "/hidden": sample(100, { dev: 2050 }), "/srv/b": sample(300),
  }, [root, hidden, target]));
  assert.equal(groups.A?.bytes, 1000);
  assert.equal(groups.A?.notStored, false);
});

test("validate a btrfs row against the current stat device rather than mountinfo", async () => {
  const subvolume = { ...root, fstype: "btrfs", dev: "8:2" };
  const groups = byName(await run([rule("A", ["/data"])], { "/data": sample(400, { dev: 81920 }) },
    [subvolume], 1000, { "/data": 81920 }));
  assert.equal(groups.A?.bytes, 400);
  assert.equal(groups.A?.notStored, false);
});

test("keep separate btrfs subvolume rows when stat reports different devices", async () => {
  const volume = { ...root, fstype: "btrfs" };
  const child = { ...volume, id: 2, root: "/snapshot", mountpoint: "/subvolume" };
  const groups = byName(await run([rule("A", ["/"])], {
    "/": sample(400, { dev: 81920 }), "/subvolume": sample(100, { dev: 81921 }),
  }, [volume, child], 1000, { "/": 81920, "/subvolume": 81921 }));
  assert.equal(groups.A?.bytes, 500);
  assert.equal(groups.A?.notStored, false);
});

test("a bind mounted after the scan does not invalidate its parent", async () => {
  const groups = byName(await run([rule("Root", ["/"])], { "/": sample(900) }, [root, bind]));
  assert.equal(groups.Root?.bytes, 900);
  assert.equal(groups.Root?.notStored, false);
  assert.equal(groups.Unattributed?.bytes, 100);
});

test("canonical request wins over its bind alias regardless of rule order", async () => {
  const groups = byName(await run([rule("Canonical", ["/data"]), rule("Copy", ["/copy"])],
    { "/data": sample(300), "/copy": sample(300) }, [root, bind]));
  assert.equal(groups.Canonical?.bytes, 300);
  assert.equal(groups.Copy, undefined);
});

test("distinct filesystems on one drive combine without duplicating the group", async () => {
  const drives = await run([rule("Data", ["/"])], { "/": sample(300), "/second": sample(250, { dev: 2050 }) }, [root, mount2]);
  const groups = byName(drives);
  assert.equal(drives.length, 1);
  assert.equal(drives[0]?.usedBytes, 2000);
  assert.equal(drives[0]?.capacityBytes, 8000);
  assert.deepEqual(new Set(drives[0]?.mounts), new Set(["/", "/second"]));
  assert.equal(drives[0]?.groups.filter((g) => g.name === "Data").length, 1);
  assert.equal(groups.Data?.bytes, 550);
  assert.equal(groups.Unattributed?.bytes, 1450);
});

test("keep overage and reject rows from a replaced device", async () => {
  const drives = await run([rule("A", ["/a"]), rule("B", ["/b"])], {
    "/a": sample(1200, { links: 15 }), "/b": sample(50, { dev: 99999 }),
  });
  const groups = byName(drives);
  assert.equal(groups.A?.hardLinks, "heavy");
  assert.equal(groups.A?.bytes, 1200);
  assert.equal(groups.B?.notStored, true);
  assert.equal(drives[0]?.overageBytes, 200);
  assert.equal(groups.Unattributed, undefined);
});

test("collect hard-link evidence during the existing size scan", async (t) => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "filedeck-group-scan-"));
  t.after(() => fs.rm(tmp, { recursive: true, force: true }));
  await fs.writeFile(path.join(tmp, "a"), "data");
  await fs.link(path.join(tmp, "a"), path.join(tmp, "b"));
  await fs.writeFile(path.join(tmp, "c"), "data");
  const store = new SizeStore(":memory:", { root: tmp, ttlMs: 30_000, maxEntries: 100 });
  t.after(() => store.close());
  assert.equal(await store.groupSize("/"), null);
  const scan = await store.scan("/");
  const row = await store.groupSize("/");
  assert.equal(row?.links, 2);
  assert.equal(row?.linkChecked, 3);
  assert.equal(row?.bytes, scan.diskBytes);
});
