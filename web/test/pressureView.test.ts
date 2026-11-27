import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PressureLink, PressureSummary, SourceBadge } from "../src/DiskPressure.tsx";
import { PressureChart } from "../src/PressureChart.tsx";
import { PressureTable } from "../src/PressureTable.tsx";
import { folderHref, type PressureConsumer, type PressureSample } from "../src/pressure.ts";
import { PRESSURE_DEFAULTS, statusHistoryAction, statusRoute, statusUrl } from "../src/statusRoute.ts";

const noop = () => {};
const zero = { rIops: 0, wIops: 0, rBps: 0, wBps: 0 };
const rows: PressureConsumer[] = [
  { kind: "cgroup", id: "/pods/a", label: "ns-label", pod: { namespace: "apps", name: "web-1", container: "app" }, rIops: 800, wIops: 200, rBps: 4_000_000, wBps: 1_500_000, psiFull10: 12.5 },
  { kind: "cgroup", id: "/system.slice/db.service", label: "db.service", unit: "db.service", ...zero, rIops: 10, wIops: 30 },
  { kind: "process", id: "pid:7:1", label: "sort", comm: "sort", pid: 7, ...zero, rIops: 3 },
  { kind: "path", id: "path:/srv/my data", label: "/srv/my data", path: "/srv/my data", ...zero, eventsPerSec: 42 },
];

test("the table shows a pod as namespace/name, a unit, a process and PSI full", () => {
  const html = renderToStaticMarkup(createElement(PressureTable, { node: "alpha", consumers: rows }));
  assert.match(html, /apps\/web-1/);
  assert.match(html, /container app/);
  assert.match(html, /12\.5 %/);
  assert.match(html, /800 IOPS/);
  assert.match(html, /4\.0 MB\/s/);
  assert.match(html, /sort \(7\)/);
  assert.equal((html.match(/<tr/g) ?? []).length, rows.length + 1);
  assert.match(html, /<caption class="visually-hidden">/);
  assert.match(html, /role="region" aria-label="Who is using this disk" tabindex="0"/);
});

test("rows keep the order they arrive in", () => {
  const html = renderToStaticMarkup(createElement(PressureTable, { node: "alpha", consumers: [rows[1]!, rows[0]!] }));
  assert.ok(html.indexOf("db.service") < html.indexOf("apps/web-1"));
});

test("a folder consumer is a link to that folder in the file browser, a path with events only shows events per second", () => {
  const html = renderToStaticMarkup(createElement(PressureTable, { node: "alpha", consumers: [rows[3]!] }));
  const href = folderHref("alpha", "/srv/my data").replaceAll("&", "&amp;");
  assert.ok(html.includes(`href="${href}"`), html);
  assert.match(html, /data-nav/);
  assert.match(html, /42 events\/s/);
  assert.doesNotMatch(html, /IOPS/);
});

test("the load bar is scaled to the busiest row and hidden from assistive tech", () => {
  const html = renderToStaticMarkup(createElement(PressureTable, { node: "alpha", consumers: rows.slice(0, 2) }));
  assert.match(html, /pressure-bar-read" style="width:80%"/);
  assert.match(html, /pressure-bar-write" style="width:20%"/);
  assert.equal((html.match(/class="pressure-bar" aria-hidden="true"/g) ?? []).length, 2);
});

test("the source badge says eBPF or proc", () => {
  assert.match(renderToStaticMarkup(createElement(SourceBadge, { source: "ebpf" })), /Source: eBPF/);
  assert.match(renderToStaticMarkup(createElement(SourceBadge, { source: "proc" })), /Source: proc/);
});

test("the chart describes its newest values and peak for assistive tech and draws one path per series", () => {
  const samples: PressureSample[] = [0, 1000, 2000].map((at, i) => ({ at, util: 0, rIops: 100 * (i + 1), wIops: 50, rBps: 0, wBps: 0, queueDepth: 0, rAwaitMs: 0, wAwaitMs: 0, psiSome10: 0, psiFull10: 0 }));
  const html = renderToStaticMarkup(createElement(PressureChart, {
    title: "IOPS", series: [{ key: "r", label: "Read", pick: (s) => s.rIops }, { key: "w", label: "Write", pick: (s) => s.wIops, dashed: true }],
    samples, minutes: 5, format: (v) => String(v),
  }));
  assert.match(html, /aria-label="IOPS: Read 300, Write 50\. Peak 300 in the last 5 min\."/);
  assert.equal((html.match(/<path /g) ?? []).length, 2);
  assert.match(html, /stroke-dasharray="5 3"/);
  assert.match(renderToStaticMarkup(createElement(PressureChart, { title: "Busy", series: [{ key: "u", label: "Busy", pick: (s) => s.util }], samples: [], minutes: 1, format: String })), /No samples yet\./);
});

test("the summary links each node to its busiest disk", () => {
  const route = statusRoute("/status", "")!;
  const entries = [{ node: "alpha", disks: [{ name: "disk0", util: 0.2, psiFull10: 0 }, { name: "disk1", util: 0.9, psiFull10: 3.2 }] }, { node: "beta", disks: [] }];
  const html = renderToStaticMarkup(createElement(PressureSummary, { entries, route, navigate: noop }));
  assert.match(html, /href="\/status\/alpha\/disks\/disk1"/);
  assert.match(html, /90 % busy · PSI full 3\.2 %/);
  assert.match(html, /No disk data/);
  assert.match(html, /href="\/status\?section=disks"/);
});

test("a status link keeps its address for a new tab", () => {
  const html = renderToStaticMarkup(createElement(PressureLink, { to: statusRoute("/status/a/disks/d", "")!, navigate: noop }, "Open"));
  assert.match(html, /<a data-nav="true" class="btn-a" href="\/status\/a\/disks\/d">Open<\/a>/);
});

test("the disk route keeps the node and disk in the path and the view options in the query", () => {
  const route = statusRoute("/status/Node%20A/disks/nvme0n1", "?window=15&group=process&top=50")!;
  assert.deepEqual({ node: route.node, section: route.section, disk: route.disk, window: route.window, group: route.group, top: route.top }, { node: "Node A", section: "disks", disk: "nvme0n1", window: 15, group: "process", top: 50 });
  assert.equal(statusUrl(route), "/status/Node%20A/disks/nvme0n1?window=15&group=process&top=50");
  const url = new URL(statusUrl(route), "https://files.test");
  assert.deepEqual(statusRoute(url.pathname, url.search), route);
});

test("defaults and unknown option values leave the address clean", () => {
  const route = statusRoute("/status/a/disks/d", "?window=7&group=thread&top=3")!;
  assert.equal(route.window, undefined);
  assert.equal(route.group, undefined);
  assert.equal(route.top, undefined);
  const withDefaults = { ...route, ...PRESSURE_DEFAULTS };
  assert.equal(statusUrl(withDefaults), "/status/a/disks/d");
});

test("the disk list lives at the node path and the all-nodes list in the query", () => {
  assert.equal(statusUrl({ node: "a", section: "disks" }), "/status/a/disks");
  assert.equal(statusUrl({ node: null, section: "disks" }), "/status?section=disks");
  const all = statusRoute("/status", "?section=disks")!;
  assert.equal(all.section, "disks");
  assert.equal(all.node, null);
  const list = statusRoute("/status/a/disks", "")!;
  assert.equal(list.section, "disks");
  assert.equal(list.disk, undefined);
  assert.equal(statusRoute("/status/a/disks/d/extra", ""), null);
  assert.equal(statusRoute("/status/a/disks/%zz", ""), null);
});

test("filters of other sections do not leak into the disk address and existing addresses are unchanged", () => {
  assert.equal(statusUrl({ node: "a", section: "disks", disk: "d", prefix: "/x", kind: "move", job: "j" }), "/status/a/disks/d");
  assert.equal(statusUrl(statusRoute("/status/a", "?section=events&kind=move")!), "/status/a?section=events&kind=move");
  assert.equal(statusRoute("/status/a", "")!.section, "jobs");
  assert.equal(statusRoute("/status", "?window=5")!.window, undefined);
});

test("a disk change pushes history and a view option replaces it", () => {
  const from = statusRoute("/status/a/disks/d1", "")!;
  assert.equal(statusHistoryAction(from, { ...from, disk: "d2" }), "push");
  assert.equal(statusHistoryAction(from, { ...from, window: 15 }), "replace");
  assert.equal(statusHistoryAction(from, { ...from, group: "path", top: 100 }), "replace");
  assert.equal(statusHistoryAction(from, { ...from, node: "b", disk: undefined }), "push");
  assert.equal(statusHistoryAction({ ...from, section: "jobs", disk: undefined }, { ...from, section: "disks" }), "replace");
});
