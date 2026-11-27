import assert from "node:assert/strict";
import { test } from "node:test";
import { appendChanges, CHANGE_ROW_LIMIT, nextChangeStreamFailureCount, readChanges, StreamFormatError, type StatusChange } from "../src/statusChanges.ts";
import { streamRetryDelay } from "../src/eventStream.ts";
import { changesUrl, statusHistoryAction, statusRoute, statusUrl } from "../src/statusRoute.ts";
import { jobDuration, statusJobs } from "../src/statusJobs.ts";
import type { JobsSnapshot } from "../src/Jobs.tsx";
import type { DiffJobView, JobView, OpJob } from "../src/api.ts";
import { coveredMountCount } from "../src/StatusNodes.tsx";

test("mixed-version node payloads derive the covered numerator when the field is absent", () => {
  assert.equal(coveredMountCount({ coverage: [{ state: "watched" }, { state: "unknown" }] }), 1);
  assert.equal(coveredMountCount({ covered: 2, coverage: [{ state: "watched" }] }), 2);
});

test("status route round trips escaped nodes, selected jobs and filters", () => {
  const route = statusRoute("/status/Node%20A", "?section=events&job=scan%3A1&jobs=active&prefix=%2Fdata&glob=*.txt&kind=move&type=file")!;
  assert.equal(route.node, "Node A");
  assert.equal(route.job, "scan:1");
  assert.equal(route.section, "events");
  const url = new URL(statusUrl(route), "https://files.test");
  assert.deepEqual(statusRoute(url.pathname, url.search), route);
  assert.equal(changesUrl(route.node!, route, "cursor"), "/api/v1/changes?node=Node+A&prefix=%2Fdata&glob=*.txt&kind=move&type=file&since=cursor");
});

test("only node changes push browser history", () => {
  const from = statusRoute("/status/a", "")!;
  assert.equal(statusHistoryAction(from, { ...from, node: "b" }), "push");
  assert.equal(statusHistoryAction(from, { ...from, section: "nodes", job: "job", kind: "move" }), "replace");
});

test("unknown sections and filter values use defaults without matching other paths", () => {
  assert.equal(statusRoute("/status/a/extra", ""), null);
  assert.equal(statusRoute("/status/%zz", ""), null);
  const route = statusRoute("/status", "?section=no&kind=ping&type=other&jobs=all")!;
  assert.equal(statusUrl(route), "/status");
});

test("job list includes background jobs, node transfers and compares with one stable selection key", () => {
  const base: JobView = { id: "id", kind: "du", origin: "cli", title: "Scan", state: "running", createdAt: 2, progress: { bytes: 0, totalBytes: 0, entries: 0, totalEntries: 0, current: "" } };
  const op: OpJob = { ...base, id: "transfer", kind: "ops", op: "copy", nodes: ["a", "b"], counts: { total: 0, done: 0, skipped: 0, failed: 0 }, speed: 0 };
  const compare: DiffJobView = { ...base, id: "compare", kind: "folderdiff", state: "done", left: { node: "a", path: "/" }, right: { node: "b", path: "/" } };
  const snapshot: JobsSnapshot = { jobs: { a: [base], b: [{ ...base, state: "failed" }] }, ops: [op], compares: [compare], uploads: [], stale: new Set(), loading: false };
  assert.deepEqual(statusJobs(snapshot, { node: "a", section: "jobs" }).map(({ key }) => key), ["agent:a:id", "op:transfer", "compare:compare"]);
  assert.deepEqual(statusJobs(snapshot, { node: "b", section: "jobs", jobs: "failed", job: "op:transfer" }).map(({ key }) => key), ["op:transfer", "agent:b:id"]);
  assert.equal(statusJobs(snapshot, { node: null, section: "jobs" }).length, 4);
});

test("job duration uses finish time, current time or an explicit unknown state", () => {
  assert.equal(jobDuration({ state: "done", startedAt: 1, finishedAt: 61_001 }, 100_001), "1 min 1 s");
  assert.equal(jobDuration({ state: "running", startedAt: 1 }, 5001), "5 s");
  assert.equal(jobDuration({ state: "queued" }, 5001), "Not started");
  assert.equal(jobDuration({ state: "done", startedAt: 1 }, 5001), "Unknown");
});

test("event history caps memory and deduplicates replay by cursor and kind", () => {
  const events = Array.from({ length: 600 }, (_, i): StatusChange => ({ kind: "modify", cursor: String(i) }));
  const capped = appendChanges([], events);
  assert.equal(capped.length, CHANGE_ROW_LIMIT);
  assert.equal(capped[0]?.cursor, "100");
  assert.deepEqual(appendChanges(capped, events.slice(-1)), capped);
  assert.equal(appendChanges(capped, [{ ...capped.at(-1)!, kind: "reset" }]).at(-1)?.kind, "reset");
});

test("NDJSON reader handles split lines and releases a malformed stream", async () => {
  const enc = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const text of ['{"kind":"mov', 'e","path":"/one"}\n{"kind":"ping"}\n']) controller.enqueue(enc.encode(text));
      controller.close();
    },
  });
  const events: StatusChange[] = [];
  await readChanges(body, (event) => events.push(event));
  assert.deepEqual(events, [{ kind: "move", path: "/one" }, { kind: "ping" }]);
  assert.equal(body.locked, false);
  let stopped = false;
  const malformed = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(enc.encode("x".repeat(1024 * 1024 + 1))); },
    cancel() { stopped = true; },
  });
  await assert.rejects(readChanges(malformed, () => {}), /oversized/);
  assert.equal(stopped, true);
  assert.equal(malformed.locked, false);
});

test("a stream retry starts at three seconds and doubles up to five minutes", () => {
  assert.deepEqual([1, 2, 3, 7, 8, 100].map((failures) => streamRetryDelay(3000, failures)),
    [3000, 6000, 12000, 192000, 300000, 300000]);
});

test("the reader rejects a stream that ends with an unfinished line", async () => {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"kind":'));
      controller.close();
    },
  });
  await assert.rejects(readChanges(body, () => assert.fail("The stream sent no complete event.")), /incomplete line/);
  assert.equal(body.locked, false);
});

test("a network failure after a real event resets the reconnect delay", async () => {
  const networkError = new TypeError("Network connection lost.");
  const changes: StatusChange[] = [];
  const encode = new TextEncoder();
  let first = true;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (first) {
        first = false;
        controller.enqueue(encode.encode('{"kind":"modify","path":"/one"}\n'));
      } else {
        controller.error(networkError);
      }
    },
  });
  await assert.rejects(readChanges(body, (event) => changes.push(event)), (error) => {
    assert.equal(error, networkError);
    assert.deepEqual(changes, [{ kind: "modify", path: "/one" }]);
    assert.equal(nextChangeStreamFailureCount(6, changes.length > 0, error), 1);
    assert.equal(nextChangeStreamFailureCount(6, false, error), 7);
    return true;
  });
});

test("format errors after a real event preserve the reconnect back-off", async () => {
  const encode = new TextEncoder();
  for (const tail of ['{bad}\n', '{}\n', "x".repeat(1024 * 1024 + 1), '{"kind":']) {
    const changes: StatusChange[] = [];
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encode.encode('{"kind":"modify","path":"/one"}\n'));
        controller.enqueue(encode.encode(tail));
        controller.close();
      },
    });
    await assert.rejects(readChanges(body, (event) => changes.push(event)), (error) => {
      assert.ok(error instanceof StreamFormatError);
      assert.deepEqual(changes, [{ kind: "modify", path: "/one" }]);
      assert.equal(nextChangeStreamFailureCount(6, changes.length > 0, error), 7);
      return true;
    });
  }
});
