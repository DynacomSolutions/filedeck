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

test("drop asks who is signed in: an error without data calls onDrop once per 10 s; an error event with data does not", () => {
  let t = 1_000_000;
  let drops = 0;
  const sources: Fake[] = [];
  const hub = createChangeHub({
    open: (url) => {
      const s = new Fake(url);
      sources.push(s);
      return s;
    },
    maxStreams: 4,
    pollMs: 1000,
    setInterval: () => 0,
    clearInterval: () => {},
    url: (n, p) => `${n}:${p}`,
    onDrop: () => drops++,
    now: () => t,
  });
  hub.subscribe("n", "/a", () => {});
  hub.subscribe("n", "/b", () => {});
  sources[0]!.emit("error");
  assert.equal(drops, 1);
  t += 5_000;
  sources[1]!.emit("error");
  assert.equal(drops, 1, "a second drop within 10 s does not ask again");
  t += 5_000;
  sources[0]!.emit("error");
  assert.equal(drops, 2, "10 s later it asks again");
  t += 20_000;
  sources[1]!.emit("error", "too many watches");
  assert.equal(drops, 2, "a server-sent error event is not a drop");
});

/** A hub whose fake sources have a `readyState`, with a clock. */
function setupWithClock(maxStreams = 2) {
  const sources: (Fake & { readyState: number })[] = [];
  const timers = new Map<number, () => void>();
  let next = 1;
  const clock = { t: 1_000_000 };
  const hub = createChangeHub({
    open: (url) => {
      const s = Object.assign(new Fake(url), { readyState: 1 });
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
    now: () => clock.t,
  });
  const live = () => sources.filter((s) => !s.closed);
  const tick = () => [...timers.values()].forEach((fn) => fn());
  return { hub, sources, live, timers, clock, tick };
}

test("a reconnect tells the listeners to look again: changes made while the stream was down are not missed; the first ready is not a change", () => {
  const { hub, live } = setupWithClock();
  let n = 0;
  hub.subscribe("n", "/x", () => n++);
  const s = live()[0]!;
  s.emit("ready", "false");
  assert.equal(n, 0, "the first ready of a stream is no change");
  s.emit("error"); // dropped; the browser reconnects by itself
  s.emit("ready", "false");
  assert.equal(n, 1, "the ready after the reconnect is one");
  s.emit("ready", "false");
  assert.equal(n, 2);
});

test("a stream the browser gave up on (CLOSED, for example a 503 or a 401 at the reconnect) falls back to polling, and is opened again later", () => {
  const { hub, live, sources, timers, clock, tick } = setupWithClock();
  let n = 0;
  hub.subscribe("n", "/x", () => n++);
  const s = sources[0]!;
  s.readyState = 2;
  s.emit("error");
  assert.ok(s.closed, "the dead source is closed");
  assert.equal(live().length, 0);
  assert.equal(hub.openStreams(), 0);
  assert.equal(timers.size, 1, "the folder is polled meanwhile");
  tick();
  assert.equal(n, 1, "a poll tick tells the listeners");
  assert.equal(sources.length, 1, "not reopened at once");
  clock.t += 1_000;
  tick();
  assert.equal(sources.length, 2, "reopened after the wait");
  assert.equal(live().length, 1);
  assert.equal(timers.size, 0, "polling stops with the stream back");
  // a second failure in a row waits longer
  sources[1]!.readyState = 2;
  sources[1]!.emit("error");
  clock.t += 1_000;
  tick();
  assert.equal(sources.length, 2, "the second wait is longer");
  clock.t += 1_000;
  tick();
  assert.equal(sources.length, 3);
  // a stream that comes up resets the wait
  sources[2]!.emit("ready", "false");
  sources[2]!.readyState = 2;
  sources[2]!.emit("error");
  clock.t += 1_000;
  tick();
  assert.equal(sources.length, 4, "back to the first wait");
});
