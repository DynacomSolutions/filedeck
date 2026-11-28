import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeState } from "../src/urlState.ts";
import {
  folderHref, HISTORY_CAPACITY, inOrder, linePaths, niceMax, parseNodeSummaries, parsePressureLine, PressureFormatError, rankConsumers, readPressure,
  RERANK_MS, RingBuffer, sampleOf, stableOrder, windowSamples, type PressureConsumer, type PressureEvent, type PressureSample, type PressureSnapshot,
} from "../src/pressure.ts";

const consumer = (id: string, rIops: number, wIops = 0, extra: Partial<PressureConsumer> = {}): PressureConsumer => ({ kind: "cgroup", id, label: id, rIops, wIops, rBps: 0, wBps: 0, ...extra });

const snapshotLine = JSON.stringify({
  type: "snapshot", node: "alpha", at: 1000, intervalMs: 1000, source: "ebpf",
  psi: { some: { avg10: 5.3, avg60: 11.7, avg300: 22.9 }, full: { avg10: 0.9, avg60: 4.5, avg300: 7.5 } },
  disks: [{
    name: "disk0", dev: "259:0", mounts: ["/", "/data"], util: 0.8, rIops: 1143, wIops: 2492, rBps: 13500000, wBps: 31500000, queueDepth: 10.2, rAwaitMs: 0.4, wAwaitMs: 3.1, inflight: 2,
    consumers: [
      { kind: "cgroup", id: "/pods/a", label: "ns/web", pod: { namespace: "ns", name: "web", container: "app" }, rIops: 5, wIops: 7, rBps: 1, wBps: 2, psiFull10: 1.5 },
      { kind: "bogus", id: "x", label: "dropped" },
      { kind: "path", id: "path:/srv/x", label: "/srv/x", path: "/srv/x", eventsPerSec: 12, rIops: 0, wIops: 0, rBps: 0, wBps: 0 },
    ],
  }],
});

test("the parser reads a snapshot, drops malformed consumers and defaults missing numbers", () => {
  const event = parsePressureLine(snapshotLine) as Extract<PressureEvent, { type: "snapshot" }>;
  assert.equal(event.type, "snapshot");
  assert.equal(event.snapshot.source, "ebpf");
  assert.deepEqual(event.snapshot.disks[0]!.consumers.map((c) => c.id), ["/pods/a", "path:/srv/x"]);
  assert.deepEqual(event.snapshot.disks[0]!.consumers[0]!.pod, { namespace: "ns", name: "web", container: "app" });
  const sparse = parsePressureLine(JSON.stringify({ type: "snapshot", node: "b", at: 5, disks: [{ name: "d" }] })) as Extract<PressureEvent, { type: "snapshot" }>;
  assert.equal(sparse.snapshot.source, "proc");
  assert.equal(sparse.snapshot.intervalMs, 1000);
  assert.equal(sparse.snapshot.disks[0]!.util, 0);
  assert.deepEqual(sparse.snapshot.disks[0]!.consumers, []);
});

test("the parser knows the control events, ignores newer types and rejects bad lines", () => {
  assert.deepEqual(parsePressureLine('{"type":"ready"}'), { type: "ready" });
  assert.deepEqual(parsePressureLine('{"type":"offline"}'), { type: "offline" });
  assert.deepEqual(parsePressureLine('{"type":"error","error":"no"}'), { type: "error", error: "no" });
  assert.equal(parsePressureLine('{"type":"future"}'), null);
  assert.throws(() => parsePressureLine("{"), PressureFormatError);
  assert.throws(() => parsePressureLine("{}"), PressureFormatError);
  assert.throws(() => parsePressureLine('{"type":"snapshot","node":"a"}'), PressureFormatError);
});

function body(chunks: string[]) {
  const enc = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(enc.encode(chunk));
      controller.close();
    },
  });
}

test("the stream reader joins split lines and releases the body", async () => {
  const events: PressureEvent[] = [];
  const stream = body(['{"type":"rea', 'dy"}\n', snapshotLine.slice(0, 40), snapshotLine.slice(40) + "\n", '{"type":"future"}\n\n']);
  await readPressure(stream, (event) => events.push(event));
  assert.deepEqual(events.map((e) => e.type), ["ready", "snapshot"]);
  assert.equal(stream.locked, false);
});

test("the stream reader rejects a truncated or oversized line and still releases the body", async () => {
  const truncated = body(['{"type":"ready"}\n{"type":"sna']);
  await assert.rejects(readPressure(truncated, () => {}), PressureFormatError);
  assert.equal(truncated.locked, false);
  let cancelled = false;
  const huge = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new TextEncoder().encode("x".repeat(1024 * 1024 + 1))); },
    cancel() { cancelled = true; },
  });
  await assert.rejects(readPressure(huge, () => {}), PressureFormatError);
  assert.equal(cancelled, true);
});

test("the ring buffer keeps the newest items in order and stays bounded", () => {
  const ring = new RingBuffer<number>(3);
  assert.deepEqual(ring.toArray(), []);
  for (const n of [1, 2]) ring.push(n);
  assert.deepEqual(ring.toArray(), [1, 2]);
  for (const n of [3, 4, 5]) ring.push(n);
  assert.deepEqual(ring.toArray(), [3, 4, 5]);
  assert.equal(ring.length, 3);
  const copy = ring.toArray();
  ring.push(6);
  assert.deepEqual(copy, [3, 4, 5]);
  ring.clear();
  assert.equal(ring.length, 0);
  assert.throws(() => new RingBuffer(0), RangeError);
});

test("an hour of one-second samples never grows the history past its capacity", () => {
  const ring = new RingBuffer<number>(HISTORY_CAPACITY);
  for (let i = 0; i < 3600; i++) ring.push(i);
  assert.equal(ring.length, HISTORY_CAPACITY);
  assert.equal(ring.toArray().at(-1), 3599);
});

const sample = (at: number, util = 0): PressureSample => ({ at, util, rIops: 0, wIops: 0, rBps: 0, wBps: 0, queueDepth: 0, rAwaitMs: 0, wAwaitMs: 0, psiSome10: 0, psiFull10: 0 });

test("samples come from the named disk and the window ends at the newest sample", () => {
  const snapshot = (parsePressureLine(snapshotLine) as Extract<PressureEvent, { type: "snapshot" }>).snapshot as PressureSnapshot;
  assert.equal(sampleOf(snapshot, "disk0")?.psiFull10, 0.9);
  assert.equal(sampleOf(snapshot, "other"), null);
  const samples = [0, 30_000, 90_000, 150_000].map((at) => sample(at));
  assert.deepEqual(windowSamples(samples, 1).map((s) => s.at), [90_000, 150_000]);
  assert.deepEqual(windowSamples(samples, 5).length, 4);
  assert.deepEqual(windowSamples([], 5), []);
});

test("the axis top is a round number above the data and never below the floor", () => {
  assert.equal(niceMax(0, 1), 1);
  assert.equal(niceMax(1143, 10), 2000);
  assert.equal(niceMax(5.3, 5), 10);
  assert.equal(niceMax(100, 1), 100);
  assert.equal(niceMax(101, 1), 200);
  assert.equal(niceMax(0.2, 1), 1);
});

test("a gap in the samples breaks the line and a single point still draws", () => {
  const size = { width: 100, height: 10 };
  const samples = [sample(0, 0), sample(1000, 1), sample(10_000, 0.5)];
  const paths = linePaths(samples, (s) => s.util, 0, 10_000, 1, size, 3000);
  assert.equal(paths.length, 2);
  assert.equal(paths[0], "M0.0 10.0 L10.0 0.0");
  assert.equal(paths[1], "M100.0 5.0 L100.0 5.0");
  assert.deepEqual(linePaths([], (s) => s.util, 0, 1, 1, size, 3000), []);
});

test("consumers rank by IOPS, then bytes, then id, so ties keep a fixed order", () => {
  const a = consumer("a", 5, 5);
  const b = consumer("b", 10, 0);
  const c = consumer("c", 1, 0, { rBps: 100 });
  const d = consumer("d", 1, 0);
  assert.deepEqual(rankConsumers([d, c, b, a]).map((x) => x.id), ["a", "b", "c", "d"]);
  assert.deepEqual(rankConsumers([consumer("y", 1), consumer("x", 1)]).map((x) => x.id), ["x", "y"]);
});

test("rows keep their place for two seconds, then rank again", () => {
  const first = stableOrder(null, [consumer("a", 10), consumer("b", 5)], 10_000);
  assert.deepEqual(first.ids, ["a", "b"]);
  const swapped = [consumer("a", 1), consumer("b", 50), consumer("c", 99)];
  const held = stableOrder(first, swapped, 10_000 + RERANK_MS - 1);
  assert.deepEqual(held.ids, ["a", "b", "c"], "no jump before the interval, a new row joins at the end");
  assert.equal(held.at, first.at);
  const gone = stableOrder(held, [consumer("b", 50), consumer("c", 99)], 10_500);
  assert.deepEqual(gone.ids, ["b", "c"]);
  const ranked = stableOrder(held, swapped, 10_000 + RERANK_MS);
  assert.deepEqual(ranked.ids, ["c", "b", "a"]);
  assert.equal(ranked.at, 10_000 + RERANK_MS);
  assert.deepEqual(stableOrder(first, swapped, 5000).ids, ["c", "b", "a"], "a clock that went back ranks again");
});

test("the table order puts unknown rows last in rank order", () => {
  const rows = [consumer("a", 1), consumer("b", 9), consumer("c", 5)];
  assert.deepEqual(inOrder(rows, ["a", "gone"]).map((x) => x.id), ["a", "b", "c"]);
});

test("a folder link opens the node and folder in the file browser", () => {
  const href = folderHref("alpha", "/srv/my data");
  assert.match(href, /^\/\?s=/);
  const state = decodeState(href.slice(1));
  assert.deepEqual(state?.tree, { kind: "leaf", id: "p1", node: "alpha", path: "/srv/my data" });
});

test("the node summary accepts an array or an object and drops entries without a node", () => {
  const entry = { node: "alpha", disks: [{ name: "d0", util: 0.4, psiFull10: 1 }, { util: 1 }], source: "proc", at: 9 };
  const expected = [{ node: "alpha", disks: [{ name: "d0", util: 0.4, psiFull10: 1 }], source: "proc", at: 9 }];
  assert.deepEqual(parseNodeSummaries([entry, { disks: [] }]), expected);
  assert.deepEqual(parseNodeSummaries({ nodes: [entry] }), expected);
  assert.deepEqual(parseNodeSummaries("nope"), []);
});
