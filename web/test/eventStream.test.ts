import assert from "node:assert/strict";
import test from "node:test";
import { createChangeHub, type StreamSource } from "../src/eventStream.ts";

class Fake implements StreamSource {
  handlers = new Map<string, (e: { data?: unknown }) => void>();
  closed = false;
  constructor(readonly url: string) {}
  addEventListener(type: string, fn: (e: { data?: unknown }) => void) {
    this.handlers.set(type, fn);
  }
  close() {
    this.closed = true;
  }
  emit(type: string, data?: unknown) {
    this.handlers.get(type)?.({ data });
  }
}

function setup(maxStreams = 2) {
  const sources: Fake[] = [];
  const timers = new Map<number, () => void>();
  let next = 1;
  const hub = createChangeHub({
    open: (url) => {
      const s = new Fake(url);
      sources.push(s);
      return s;
    },
    maxStreams,
    pollMs: 1000,
    setInterval: (fn) => {
      timers.set(next, fn);
      return next++;
    },
    clearInterval: (id) => void timers.delete(id as number),
    url: (n, p) => `${n}:${p}`,
  });
  const live = () => sources.filter((s) => !s.closed);
  return { hub, sources, live, timers };
}

test("panels showing the same folder share one stream and all hear its changes", () => {
  const { hub, live } = setup();
  let a = 0, b = 0;
  const offA = hub.subscribe("n", "/x", () => a++);
  const offB = hub.subscribe("n", "/x", () => b++);
  assert.equal(live().length, 1);
  live()[0]!.emit("change");
  assert.deepEqual([a, b], [1, 1]);
  offA();
  assert.equal(live().length, 1);
  offB();
  assert.equal(live().length, 0);
});

test("folders beyond the cap are polled, and take over a stream when one is released", () => {
  const { hub, live, timers } = setup(2);
  const hits: string[] = [];
  const off1 = hub.subscribe("n", "/1", () => hits.push("1"));
  hub.subscribe("n", "/2", () => hits.push("2"));
  hub.subscribe("n", "/3", () => hits.push("3"));
  assert.equal(live().length, 2);
  assert.equal(timers.size, 1);
  [...timers.values()][0]!();
  assert.deepEqual(hits, ["3"]);
  off1();
  assert.equal(live().length, 2); // /3 now has a stream
  assert.equal(timers.size, 0);
});

test("a hidden page holds no connection and one catch-up notification follows when it returns", () => {
  const { hub, live } = setup();
  let n = 0;
  hub.subscribe("n", "/x", () => n++);
  hub.setVisible(false);
  assert.equal(live().length, 0);
  assert.equal(n, 0);
  hub.setVisible(true);
  assert.equal(live().length, 1);
  assert.equal(n, 1);
});

test("a stream the server refuses falls back to polling instead of reconnecting", () => {
  const { hub, live, timers, sources } = setup();
  let n = 0;
  hub.subscribe("n", "/x", () => n++);
  live()[0]!.emit("error", "watch limit reached");
  assert.equal(live().length, 0);
  assert.equal(timers.size, 1);
  assert.equal(sources.length, 1);
  [...timers.values()][0]!();
  assert.equal(n, 1);
  // a plain dropped connection (no data) is the browser's to retry
  const b = setup();
  b.hub.subscribe("n", "/y", () => undefined);
  b.live()[0]!.emit("error");
  assert.equal(b.live().length, 1);
});
