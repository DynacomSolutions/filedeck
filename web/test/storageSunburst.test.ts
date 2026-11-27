import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, readFileSync } from "node:fs";
import { sliceLabel, slicePath, sliceValue, storageSlices } from "../src/storageSunburst";
import * as storage from "../src/storageSunburst";
import type { StorageNode } from "../../server/src/group-types";

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

test("the URL restores the node, slice and colour mode and preserves other parameters", () => {
  const url = "https://filemanager.example/storage?keep=yes#details";
  const state = { node: "Blue Room", selected: '["Blue Room","disk","Photos",false]', mode: "read" } as const;
  const changed = new URL(storage.storageViewUrl(url, state), url);
  assert.deepEqual(storage.storageView(changed.search), state);
  assert.equal(changed.searchParams.get("keep"), "yes");
  assert.equal(changed.hash, "#details");
  assert.equal(storage.storageViewUrl(changed.href, { node: null, selected: null, mode: "size" }), "/storage?keep=yes#details");
});

test("node throughput sums available drives and the maximum is independent for each ring", () => {
  const { slices } = storageSlices([{
    ...nodes[0]!, drives: [
      { ...nodes[0]!.drives[0]!, io: { read: { ...statistics, mean: 1000 }, write: { ...statistics, mean: 500 }, utilisation: null } },
      { id: "other", devices: [], mounts: [], usedBytes: 0, capacityBytes: 0, overageBytes: 0, groups: [],
        io: { read: { ...statistics, mean: 200 }, write: { ...statistics, mean: 100 }, utilisation: null } },
    ],
  }, nodes[1]!]);
  assert.equal(sliceValue(slices[0]!, "read"), 1200);
  assert.equal(sliceValue(slices[0]!, "write"), 600);
  assert.equal(sliceValue(slices.find((slice) => slice.label === "Archive")!, "read"), null);
  assert.deepEqual(storage.ringMaximums(slices, "read"), { node: 1200, drive: 1000, group: 8 });
  assert.deepEqual(storage.ringMaximums(slices, "write"), { node: 600, drive: 500, group: 0 });
  const projects = slices.find((slice) => slice.label === "Projects")!;
  assert.equal(storage.colourBand(projects, "read", storage.ringMaximums(slices, "read")), 3);
});

test("node throughput is partial only when some drives have samples for the selected metric", () => {
  const studio = nodes[0]!;
  const { slices } = storageSlices([{
    ...studio,
    drives: [
      { ...studio.drives[0]!, io: { read: statistics, write: { ...statistics, mean: 0 }, utilisation: null } },
      { ...studio.drives[0]!, id: "second", io: { read: statistics, write: null, utilisation: null } },
    ],
  }, nodes[1]!]);
  const studioSlice = slices.find((slice) => slice.label === "Studio")!;
  const archiveSlice = slices.find((slice) => slice.label === "Archive")!;
  assert.equal(sliceValue(studioSlice, "write"), 0);
  assert.equal(storage.sliceHasPartialIO(studioSlice, "write"), true);
  assert.equal(storage.sliceHasPartialIO(studioSlice, "read"), false);
  assert.equal(storage.sliceHasPartialIO(studioSlice, "size"), false);
  assert.equal(storage.sliceHasPartialIO(archiveSlice, "write"), false);
});

test("the app exposes Storage as a real navigation link", () => {
  const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
  assert.match(app, /<a(?=[^>]*\bdata-nav\b)(?=[^>]*href="\/storage")(?=[^>]*aria-label="Storage")[^>]*>/);
});

test("the chart and server use the same storage response types", () => {
  const chart = readFileSync(new URL("../src/StorageSunburst.tsx", import.meta.url), "utf8");
  assert.match(chart, /from "\.\.\/\.\.\/server\/src\/group-types"/);
  assert.equal(existsSync(new URL("../src/storageTypes.ts", import.meta.url)), false);
});
