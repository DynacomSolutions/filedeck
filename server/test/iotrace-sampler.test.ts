import { test } from "node:test";
import assert from "node:assert/strict";
import { IotraceSampler, type IotraceSource } from "../src/iotrace.ts";
import { trackTimers } from "./timer-probe.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const row = { dev: "259:0", cg: 1, pid: 2, comm: "x", r: 1, w: 0, rb: 4096, wb: 0 };

function fakes() {
  const c = { helper: 0, proc: 0, fail: false };
  const source: IotraceSource = {
    async read() {
      c.helper++;
      if (c.fail) throw new Error("no BPF");
      return { t: Date.now(), rows: [row] };
    },
    close() {},
  };
  const fallback = async () => (c.proc++, { t: Date.now(), rows: [] });
  return { c, source, fallback };
}

test("iotrace sampler: while idle there is no timer and no read", async () => {
  const probe = trackTimers();
  try {
    const { c, source, fallback } = fakes();
    new IotraceSampler(source, fallback, 20);
    await sleep(80);
    assert.equal(probe.active(), 0);
    assert.equal(c.helper + c.proc, 0);
  } finally {
    probe.restore();
  }
});

test("iotrace sampler: a subscriber gets updates, the last unsubscribe stops the deadline", async () => {
  const probe = trackTimers();
  try {
    const { c, source, fallback } = fakes();
    const s = new IotraceSampler(source, fallback, 20);
    const got: number[] = [];
    const off1 = s.subscribe((x) => got.push(x.t));
    const off2 = s.subscribe(() => {});
    for (const t0 = Date.now(); got.length < 3 && Date.now() - t0 < 3000; ) await sleep(10);
    assert.ok(got.length >= 3, "updates arrive");
    assert.equal(probe.active() > 0, true, "a one-shot deadline is armed while subscribed");
    off1();
    await sleep(60);
    assert.equal(probe.active() > 0, true, "one subscriber is left");
    off2();
    assert.equal(probe.active(), 0, "the last unsubscribe clears the deadline");
    const n = c.helper;
    await sleep(80);
    assert.equal(c.helper, n, "no read after that");
  } finally {
    probe.restore();
  }
});

test("iotrace sampler: a scrape reads the maps once, and overlapping reads share it", async () => {
  const probe = trackTimers();
  try {
    const { c, source, fallback } = fakes();
    const s = new IotraceSampler(source, fallback, 20);
    const [a, b] = await Promise.all([s.read(), s.read()]);
    assert.equal(c.helper, 1);
    assert.equal(a, b);
    assert.equal(a.source, "ebpf");
    assert.equal(probe.active(), 0, "a read leaves no timer");
    await s.read();
    assert.equal(c.helper, 2, "each later demand reads once");
  } finally {
    probe.restore();
  }
});

test("iotrace sampler: when the helper fails the proc fallback answers, on demand too", async () => {
  const probe = trackTimers();
  try {
    const { c, source, fallback } = fakes();
    c.fail = true;
    const s = new IotraceSampler(source, fallback, 20);
    const r = await s.read();
    assert.equal(r.source, "proc");
    await s.read();
    assert.equal(c.helper, 1, "the failed helper is not asked again");
    assert.equal(c.proc, 2);
    assert.equal(probe.active(), 0);
  } finally {
    probe.restore();
  }
});
