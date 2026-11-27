import assert from "node:assert/strict";
import { test } from "node:test";
import { sliceLabel, slicePath, sliceValue, storageMode, storageModeUrl, storageSlices } from "../src/storageSunburst";
import type { StorageNode } from "../src/storageTypes";

const statistics = { min: 0, max: 12, mean: 8, resting: 2 };
const nodes: StorageNode[] = [
  { node: "Studio", drives: [
    { id: "disk", devices: [{ name: "disk", model: "Drive" }], mounts: ["/data"], usedBytes: 60, capacityBytes: 100, overageBytes: 0,
      groups: [
        { name: "Projects", bytes: 45, scannedAt: 123, stale: true, notStored: false, errors: 0, hardLinks: "normal",
          io: { read: statistics, write: { ...statistics, mean: 0 }, utilisation: null } },
        { name: "Unattributed", bytes: 15, scannedAt: null, stale: false, notStored: false, errors: 0, hardLinks: "unknown", unattributed: true },
        { name: "Pending", bytes: 0, scannedAt: null, stale: false, notStored: true, errors: 0, hardLinks: "unknown" },
      ] },
  ] },
  { node: "Archive", drives: [
    { id: "disk", devices: [{ name: "disk", model: "Drive" }], mounts: ["/"], usedBytes: 40, capacityBytes: 100, overageBytes: 0,
      groups: [{ name: "Backups", bytes: 40, scannedAt: 345, stale: false, notStored: false, errors: 0, hardLinks: "heavy" }] },
  ] },
];

test("URL round-trips colour and preserves unrelated parameters and the fragment", () => {
  const start = "https://filemanager.example/status/storage?node=Blue+Room&storageMode=write#details";
  assert.equal(storageMode(new URL(start).search), "write");
  const read = storageModeUrl(start, "read");
  assert.equal(read, "/status/storage?node=Blue+Room&storageMode=read#details");
  assert.equal(storageMode(new URL(read, start).search), "read");
  assert.equal(storageModeUrl(start, "size"), "/status/storage?node=Blue+Room#details");
  assert.equal(storageMode("?storageMode=other"), "size");
});

test("rings partition the same space and preserve empty and unattributed states", () => {
  const { total, slices } = storageSlices(nodes);
  assert.equal(total, 100);
  assert.equal(slices.length, 8);
  assert.equal(slices[0]?.start, -Math.PI / 2);
  assert.ok(Math.abs(slices.at(-1)!.end - 1.5 * Math.PI) < 1e-10);
  assert.equal(slices[2]?.parent, slices[1]?.id);
  assert.equal(slices[1]?.parent, slices[0]?.id);
  assert.equal(slices[2]?.group?.stale, true);
  assert.equal(slices[3]?.group?.unattributed, true);
  assert.equal(slices[4]?.group?.notStored, true);
  assert.equal(slicePath(slices[4]!), "");
  assert.deepEqual(storageSlices([]), { total: 0, slices: [] });
});

test("single-node rings have valid paths, and pressure does not alter geometry", () => {
  const { slices } = storageSlices([nodes[0]!]);
  assert.match(slicePath(slices[0]!), /^M [^A]+ A 95 95 0 1 1 .+ Z$/);
  assert.equal(sliceLabel(slices[2]!)?.text, "Projects");
  assert.equal(sliceValue(slices[2]!, "size"), 45);
  assert.equal(sliceValue(slices[2]!, "read"), 8);
  assert.equal(sliceValue(slices[2]!, "write"), 0);
  assert.equal(sliceValue(slices[3]!, "read"), null);
});
