import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import type { Hono } from "hono";
import { createAgent } from "../src/agent.ts";
import { createHub } from "../src/hub.ts";
import { loadConfig } from "../src/config.ts";
import { ROOT_ROUTES } from "../src/agent-workers.ts";
import type { PressureCollector } from "../src/pressure/collector.ts";

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), "pressure-api-")));
const cleanups: (() => void | Promise<void>)[] = [];
after(async () => {
  for (const c of cleanups.reverse()) await Promise.resolve(c()).catch(() => {});
  fs.rmSync(tmp, { recursive: true, force: true });
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (f: () => boolean, ms = 8000) => {
  for (const t0 = Date.now(); !f() && Date.now() - t0 < ms; ) await sleep(10);
};
const TOKEN = "agent-secret";
const auth = { authorization: `Bearer ${TOKEN}` };

function agent(name: string, env: Record<string, string> = {}) {
  const root = fs.mkdtempSync(path.join(tmp, "root-"));
  const cg = fs.mkdtempSync(path.join(tmp, "cg-"));
  const app = createAgent(loadConfig({ FILEDECK_ROOT: root, FILEDECK_NODE: name, FILEDECK_AGENT_TOKEN: TOKEN, FILEDECK_PRESSURE_CGROUP_ROOT: cg, FILEDECK_PRESSURE_INTERVAL_MS: "250", ...env } as never));
  cleanups.push(() => (app as unknown as { close(): Promise<void> }).close());
  return app as unknown as Hono & { pressure?: PressureCollector };
}

const listen = (app: { fetch: never }) =>
  new Promise<ReturnType<typeof serve>>((res) => {
    const s: ReturnType<typeof serve> = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, () => res(s));
    cleanups.push(() => {
      s.close();
      (s as unknown as { closeAllConnections?(): void }).closeAllConnections?.();
    });
  });
const urlOf = (s: ReturnType<typeof serve>) => `http://127.0.0.1:${(s.address() as AddressInfo).port}`;

/** NDJSON lines of a response body, collected as they come. */
function lines(res: Response) {
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  const out: Record<string, any>[] = [];
  void (async () => {
    for (;;) {
      const { value, done } = await reader.read().catch(() => ({ value: undefined, done: true }));
      if (done) return;
      buf += dec.decode(value);
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        out.push(JSON.parse(buf.slice(0, i)));
        buf = buf.slice(i + 1);
      }
    }
  })();
  return { out, cancel: () => reader.cancel().catch(() => {}) };
}

test("pressure routes are off by default, and the agent token guards them when on", async () => {
  const off = agent("a");
  assert.equal((await off.request("/api/v1/disk-pressure", { headers: auth })).status, 404);
  assert.equal((await off.request("/api/v1/disk-pressure/stream", { headers: auth })).status, 404);
  assert.equal(off.pressure, undefined);
  const on = agent("a", { FILEDECK_PRESSURE: "1" });
  assert.equal((await on.request("/api/v1/disk-pressure")).status, 401);
  assert.equal((await on.request("/api/v1/disk-pressure/stream")).status, 401);
  assert.equal((await on.request("/api/v1/disk-pressure?top=500", { headers: auth })).status, 400);
  assert.equal((await on.request("/api/v1/disk-pressure?disk=a/b", { headers: auth })).status, 400);
  assert.equal((await on.request("/api/v1/disk-pressure/stream?top=x", { headers: auth })).status, 400);
  // with sign-in on, the root process answers these routes itself
  assert.ok(ROOT_ROUTES.some((re) => re.test("/api/v1/disk-pressure")) && ROOT_ROUTES.some((re) => re.test("/api/v1/disk-pressure/stream")));
});

test("GET /api/v1/disk-pressure answers one snapshot, and the collector stops again", async () => {
  const a = agent("a", { FILEDECK_PRESSURE: "1" });
  assert.equal(a.pressure!.sampleCount, 0, "nothing is sampled before the first request");
  const res = await a.request("/api/v1/disk-pressure?top=3", { headers: auth });
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type")!, /application\/json/);
  const s = await res.json();
  assert.equal(s.type, "snapshot");
  assert.equal(s.node, "a");
  assert.ok(s.intervalMs >= 200 && s.intervalMs < 5000, `interval ${s.intervalMs}`);
  assert.ok(s.source === "proc" || s.source === "ebpf");
  assert.ok(typeof s.at === "number" && Math.abs(Date.now() - s.at) < 5000);
  assert.deepEqual(Object.keys(s.psi), ["some", "full"]);
  assert.deepEqual(Object.keys(s.psi.full), ["avg10", "avg60", "avg300"]);
  assert.ok(Array.isArray(s.disks));
  for (const d of s.disks) {
    for (const k of ["name", "dev", "mounts", "util", "rIops", "wIops", "rBps", "wBps", "queueDepth", "rAwaitMs", "wAwaitMs", "inflight", "consumers"]) assert.ok(k in d, `disk.${k}`);
    assert.ok(d.consumers.length <= 3);
    assert.ok(d.util >= 0 && d.util <= 1);
  }
  const none = await (await a.request("/api/v1/disk-pressure?top=0&disk=no-such-disk", { headers: auth })).json();
  assert.deepEqual(none.disks, []);
  assert.equal(a.pressure!.live, false, "a request is not a live view");
  assert.equal(a.pressure!.sampleCount, 2, "a baseline and one sample, then nothing");
  await sleep(600);
  assert.equal(a.pressure!.sampleCount, 2, "no reader: no sampling");
});

test("GET /api/v1/disk-pressure/stream: ready first, then one snapshot per interval, ends with the client", async () => {
  const a = agent("a", { FILEDECK_PRESSURE: "1" });
  const srv = await listen(a as never);
  const ctl = new AbortController();
  const res = await fetch(`${urlOf(srv)}/api/v1/disk-pressure/stream?top=2`, { headers: auth, signal: ctl.signal });
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type")!, /application\/x-ndjson/);
  const l = lines(res);
  await until(() => l.out.length >= 4);
  assert.deepEqual(l.out[0], { type: "ready" });
  const snaps = l.out.slice(1);
  assert.ok(snaps.length >= 3 && snaps.every((x) => x.type === "snapshot"));
  const gaps = snaps.slice(1).map((x, i) => x.at - snaps[i]!.at);
  assert.ok(gaps.every((g) => g > 100 && g < 5000), `gaps ${gaps}`);
  assert.equal(a.pressure!.live, true);
  await l.cancel();
  ctl.abort();
  await until(() => !a.pressure!.live);
  assert.equal(a.pressure!.live, false, "the view closes when the client goes");
});

test("stream: a slow client gets the latest snapshot and skips the ones in between", async () => {
  const a = agent("a", { FILEDECK_PRESSURE: "1" });
  const res = await a.request("/api/v1/disk-pressure/stream", { headers: auth });
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  const read = async () => JSON.parse(dec.decode((await reader.read()).value));
  assert.deepEqual(await read(), { type: "ready" });
  const first = await read();
  await sleep(1200); // four intervals pass while this client does not read
  const next = await read();
  assert.ok(Date.now() - next.at < 1000, `got a snapshot of ${Date.now() - next.at} ms ago, not an old one`);
  assert.ok(next.at - first.at >= 750);
  await reader.cancel();
  await until(() => !a.pressure!.live);
});

test("stream limit: past 32 open streams the agent says 429", async () => {
  const a = agent("a", { FILEDECK_PRESSURE: "1" });
  const open = await Promise.all(Array.from({ length: 32 }, () => a.request("/api/v1/disk-pressure/stream", { headers: auth })));
  assert.ok(open.every((r) => r.status === 200));
  assert.equal((await a.request("/api/v1/disk-pressure/stream", { headers: auth })).status, 429);
  await Promise.all(open.map((r) => r.body!.cancel()));
  await until(() => !a.pressure!.live);
  assert.equal((await a.request("/api/v1/disk-pressure/stream", { headers: auth })).status, 200);
});

test("/metrics carries the pressure series without a token, and a scrape reads once without starting anything", async () => {
  const a = agent("a", { FILEDECK_PRESSURE: "1" });
  const res = await a.request("/metrics");
  assert.equal(res.status, 200);
  const text = await res.text();
  assert.match(text, /filedeck_pressure_probe_seconds_total /);
  assert.match(text, /filedeck_pressure_source\{source="(proc|ebpf)"\} 1/);
  assert.equal(a.pressure!.live, false);
  assert.ok(!(await (await agent("b").request("/metrics")).text()).includes("filedeck_pressure"), "off: no pressure series");
  a.pressure!.close();
});

test("hub: node summary, one snapshot and a stream of one node; a node without pressure is marked unsupported", async () => {
  const a = agent("a", { FILEDECK_PRESSURE: "1" });
  const b = agent("b");
  const sa = await listen(a as never);
  const sb = await listen(b as never);
  const hub = createHub(loadConfig({ FILEDECK_MODE: "hub", FILEDECK_STATIC: tmp, FILEDECK_AGENT_TOKEN: TOKEN, NODES: `a=${urlOf(sa)},b=${urlOf(sb)}` } as never));
  cleanups.push(() => (hub as unknown as { close(): Promise<void> }).close());
  const hs = await listen(hub as never);
  const H = urlOf(hs);
  const nodes = (await (await fetch(`${H}/api/v1/disk-pressure/nodes`)).json()) as any[];
  assert.deepEqual(nodes.map((n) => [n.node, n.state]), [["a", "ok"], ["b", "unsupported"]]);
  assert.ok(Array.isArray(nodes[0].disks) && nodes[0].source && nodes[0].at > 0);
  for (const d of nodes[0].disks) assert.deepEqual(Object.keys(d).sort(), ["name", "psiFull10", "util"]);
  assert.deepEqual(nodes[1].disks, []);
  const one = await (await fetch(`${H}/api/v1/disk-pressure?node=a&top=1`)).json();
  assert.equal(one.node, "a");
  assert.equal((await fetch(`${H}/api/v1/disk-pressure?node=b`)).status, 404, "the agent's answer for a node without pressure");
  assert.equal((await fetch(`${H}/api/v1/disk-pressure?node=nope`)).status, 404);
  assert.equal((await fetch(`${H}/api/v1/disk-pressure`)).status, 400);
  assert.equal((await fetch(`${H}/api/v1/disk-pressure?node=a&top=999`)).status, 400);
  assert.equal((await fetch(`${H}/api/v1/disk-pressure/nodes?node=nope`)).status, 404);
  // the stream
  const ctl = new AbortController();
  const res = await fetch(`${H}/api/v1/disk-pressure/stream?node=a&top=0`, { signal: ctl.signal });
  assert.equal(res.status, 200);
  const l = lines(res);
  await until(() => l.out.length >= 3);
  assert.deepEqual(l.out[0], { type: "ready" });
  assert.equal(l.out[1]!.type, "snapshot");
  assert.equal(a.pressure!.live, true);
  await l.cancel();
  ctl.abort();
  await until(() => !a.pressure!.live);
  assert.equal(a.pressure!.live, false, "the agent's live view closes when the hub client leaves");
  // the generic proxy path is guarded and works too
  const via = await fetch(`${H}/api/nodes/a/api/v1/disk-pressure?top=0`);
  assert.equal(via.status, 200);
  assert.equal((await via.json()).type, "snapshot");
});
