import { test, after } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { FanWatch as RealFanWatch, type HelperProc } from "../src/fanwatch.ts";
import { EventBus } from "../src/events/bus.ts";
import { Filter } from "../src/events/filter.ts";
import { ownState } from "../src/events/own-state.ts";

const watchers: RealFanWatch[] = [];
const buses: EventBus[] = [];
const dirs: string[] = [];
after(async () => {
  for (const w of watchers) w.stop();
  for (const b of buses) await b.close().catch(() => {});
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (f: () => boolean, ms = 10_000) => {
  for (const t0 = Date.now(); !f() && Date.now() - t0 < ms; ) await sleep(10);
};

class Fake extends EventEmitter implements HelperProc {
  stdout = new PassThrough();
  stderr = new PassThrough();
  kill() {
    return true;
  }
}

function rig() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "fanwatch-events-")));
  dirs.push(root);
  const mounts = path.join(root, "mounts");
  fs.writeFileSync(mounts, "/dev/a / ext4 rw 0 0\n/dev/b /data xfs rw 0 0\n");
  const bus = new EventBus({ node: "n1", journal: { dir: null } });
  buses.push(bus);
  const calls: string[] = [];
  const procs: Fake[] = [];
  const w = new RealFanWatch({ applyChanged: async (v: string) => void calls.push(v), markStale: () => {} }, { helper: "fake", root, procMounts: mounts, settleMs: 10, modifyMs: 5000, restartMinMs: 10, restartMaxMs: 20, bus, spawn: () => (procs.push(new Fake()), procs.at(-1)!) });
  watchers.push(w);
  const host = (p: string) => root + p; // a helper path: the root as the agent's helper sees it
  return { root, bus, w, calls, procs, host };
}

/** The events the bus holds so far, read from its journal. */
async function held(bus: EventBus): Promise<Record<string, unknown>[]> {
  await bus.whenServing();
  const sub = await bus.subscribe(new Filter(), bus.cursorOf(0), "internal");
  const out: Record<string, unknown>[] = [];
  const head = bus.journal.head;
  while (out.length < head) {
    const batch = await Promise.race([sub.next(), sleep(500).then(() => null)]);
    if (!batch) break;
    for (const b of batch) out.push(JSON.parse(b.toString("utf8")));
  }
  sub.close();
  return out;
}

test("helper lines become events: kinds, the folder flag, paths mapped to the agent's view, a move with its old place", async () => {
  const r = rig();
  await r.w.start();
  for (const l of [
    `C f ${r.host("/data/a/new.txt")}`,
    `D d ${r.host("/data/a/old")}`,
    `M f ${r.host("/data/a/log")}`,
    `W f ${r.host("/data/a/log")}`,
    `A d ${r.host("/data/a")}`,
    `R f ${r.host("/data/b/x")}\t${r.host("/data/a/x")}`,
    `C f ${r.host("/data/we\\x0aird\\\\name")}`,
  ])
    r.w.line(l);
  const ev = (await held(r.bus)).map((e) => [e.kind, e.dir, e.path, e.from]);
  assert.deepEqual(ev, [
    ["create", false, "/data/a/new.txt", undefined],
    ["delete", true, "/data/a/old", undefined],
    ["modify", false, "/data/a/log", undefined],
    ["close_write", false, "/data/a/log", undefined],
    ["attrib", true, "/data/a", undefined],
    ["move", false, "/data/b/x", "/data/a/x"],
    ["create", false, "/data/we\nird\\name", undefined],
  ]);
});

test("paths outside the served root and inside a trash store are not published; a move across that edge is a create or a delete", async () => {
  const r = rig();
  await r.w.start();
  r.w.line("C f /elsewhere/x");
  r.w.line(`C f ${r.host("/data/.filedeck-trash/x")}`);
  r.w.line(`R f ${r.host("/data/in")}\t/elsewhere/out`);
  r.w.line(`R f /elsewhere/in\t${r.host("/data/gone")}`);
  r.w.line(`R f /elsewhere/a\t/elsewhere/b`);
  const ev = (await held(r.bus)).map((e) => [e.kind, e.path]);
  assert.deepEqual(ev, [["create", "/data/in"], ["delete", "/data/gone"]]);
});

test("the size store gets the folder that holds the entry, and a folder entry itself (not for a modify)", async () => {
  const r = rig();
  await r.w.start();
  r.w.line(`C d ${r.host("/data/a/sub")}`);
  r.w.line(`M f ${r.host("/data/b/file")}`);
  r.w.line(`R f ${r.host("/data/c/new")}\t${r.host("/data/d/old")}`);
  await until(() => r.calls.length >= 5);
  await sleep(60);
  assert.deepEqual([...r.calls].sort(), ["/data/a", "/data/a/sub", "/data/b", "/data/c", "/data/d"]);
});

test("an older helper's one-line-per-folder output still reaches the size store (and makes no event)", async () => {
  const r = rig();
  await r.w.start();
  r.w.line(`x ${r.host("/data/a")}`);
  r.w.line(`w ${r.host("/data/b")}`);
  r.w.line(`m ${r.host("/data/c")}`);
  await until(() => r.calls.length >= 3);
  assert.deepEqual([...r.calls].sort(), ["/data/a", "/data/b", "/data/c"]);
  assert.equal((await held(r.bus)).length, 0);
});

test("ready, overflow, an unwatched filesystem, helper exit and restart: each is a control event with its scope and window, and the bus says whether the watcher runs", async () => {
  const r = rig();
  await r.w.start();
  assert.equal(r.bus.ready, false);
  r.w.line("#caps rename=1 target=1 unlimited=1 cache=16384");
  r.w.line("#ready 2");
  assert.equal(r.bus.ready, true);
  r.w.line("#stats events=10 hits=7 misses=3 opens=3 unresolved=1");
  r.w.line("!overflow");
  r.w.line(`c ${r.host("/data/net")}`);
  const st = r.w.status() as { caps: string; helper: Record<string, number> };
  assert.match(st.caps, /unlimited=1/);
  assert.equal(st.helper.hits, 7);
  r.procs[0]!.emit("exit", 1, null);
  assert.equal(r.bus.ready, false, "no watcher now");
  await until(() => r.procs.length >= 2);
  r.w.line("#ready 2");
  assert.equal(r.bus.ready, true);
  const ev = await held(r.bus);
  assert.deepEqual(ev.map((e) => e.kind), ["ready", "overflow", "reset", "reset", "reset", "ready"]);
  assert.equal(ev[1]!.scope, "node");
  assert.equal(typeof (ev[1]!.window as { from: number }).from, "number");
  assert.equal(ev[2]!.scope, "filesystem");
  assert.equal(ev[2]!.path, "/data/net");
  assert.match(String(ev[3]!.reason), /exited/);
  assert.equal((ev[3]!.window as { to?: number }).to, undefined, "still away");
  const gap = ev[4]!.window as { from: number; to: number };
  assert.ok(gap.to >= gap.from, "the gap has an end once the watcher is back");
  assert.match(String(ev[4]!.reason), /not running/);
  assert.deepEqual(r.bus.events.overflow, 1);
});

test("a path with a line break cannot inject a control line into the event stream", async () => {
  const r = rig();
  await r.w.start();
  r.w.line(`C f ${r.host("/data/a\\x0a!overflow")}`);
  const ev = await held(r.bus);
  assert.equal(ev.length, 1);
  assert.equal(ev[0]!.kind, "create");
  assert.equal(ev[0]!.path, "/data/a\n!overflow");
});

test("thousands of events a second are published without holding the helper's pipe (nothing is dropped)", async () => {
  const r = rig();
  await r.w.start();
  const t0 = Date.now();
  for (let i = 0; i < 50_000; i++) r.w.line(`C f ${r.host(`/data/d${i % 100}/f${i}`)}`);
  await r.bus.whenServing();
  const ms = Date.now() - t0;
  assert.equal(r.bus.events.create, 50_000);
  assert.ok(ms < 20_000, `50k events took ${ms} ms`);
});

test("the agent's own state files (journal, stores) are not published, so writing the journal makes no event; the size store still hears of the folder", async () => {
  const r = rig();
  const w = new RealFanWatch({ applyChanged: async (v: string) => void r.calls.push(v), markStale: () => {} }, { helper: "fake", root: r.root, procMounts: path.join(r.root, "mounts"), settleMs: 10, bus: r.bus, ignoreName: ownState("n1"), spawn: () => new Fake() });
  watchers.push(w);
  await w.start();
  w.line(`M f ${r.host("/var/lib/filedeck/index/changes-n1/seg-000000000000001.jsonl")}`);
  w.line(`C f ${r.host("/var/lib/filedeck/index/sizes-n1.db-wal")}`);
  w.line(`R f ${r.host("/var/lib/filedeck/index/changes-n1/meta.json")}\t${r.host("/var/lib/filedeck/index/changes-n1/meta.json.123")}`);
  w.line(`C f ${r.host("/var/lib/filedeck/index/changes-other/x")}`);
  w.line(`C f ${r.host("/data/sizes-n1.db-notes.txt")}`);
  const ev = (await held(r.bus)).map((e) => [e.kind, e.path]);
  assert.deepEqual(ev, [["create", "/var/lib/filedeck/index/changes-other/x"]], "a name like another node's state is an ordinary file");
  await until(() => r.calls.includes("/var/lib/filedeck/index/changes-n1"));
  assert.ok(r.calls.includes("/var/lib/filedeck/index/changes-n1"), "the size store is still told, as before");
  assert.equal(ownState("n1")("filedeck-changes-n1-123-abc"), true);
  assert.equal(ownState("n1")("filedeck-notes"), false);
});
