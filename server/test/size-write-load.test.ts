import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { FanWatch } from "../src/fanwatch.ts";
import { SizeStore } from "../src/size-store.ts";
import { DEFAULT_SIZE_EXCLUDE, parseSizeExclude } from "../src/size-exclude.ts";

/**
 * Load test: 50,000 change events in one busy subtree of a real size store (a file), paced over about 8 seconds, through the real watcher.
 * It prints the write transactions the store's writer ran and the bytes the process passed to write() (/proc/self/io `wchar`: the store's writes
 * dominate, nothing else here writes a file). "legacy" is the behaviour before the commit interval (every 250 ms, no excludes); "batched" is the new
 * default with the interval scaled down (1.5 s instead of 30 s, so the test is short: the real gain is larger).
 */
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const wchar = () => {
  try {
    return Number(/^wchar: (\d+)/m.exec(fs.readFileSync("/proc/self/io", "utf8"))?.[1]);
  } catch {
    return NaN;
  }
};
const cleanups: (() => Promise<void> | void)[] = [];
after(async () => {
  for (const c of cleanups) await c();
});

const EVENTS = 50_000;
const FOLDERS = 60;

async function run(label: string, o: { commitMs: number; exclude: string[]; sub: string }) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "size-load-")));
  const base = path.join(dir, "data", o.sub);
  for (let d = 0; d < FOLDERS; d++) {
    fs.mkdirSync(path.join(base, `d${d}`, "inner"), { recursive: true });
    for (let f = 0; f < 5; f++) fs.writeFileSync(path.join(base, `d${d}`, `f${f}`), "x");
  }
  const st = new SizeStore(path.join(dir, "sizes.db"), { root: dir, ttlMs: 60_000, maxEntries: 100_000 });
  await st.mayScan();
  await st.scan("/");
  await st.scan("/data");
  const sink = {
    applyChanged: st.applyChanged.bind(st),
    markStale: st.markStale.bind(st),
    notePending: st.notePending.bind(st),
    takeDue: st.takeDue.bind(st),
    noteRan: st.noteRan.bind(st),
    markDirty: st.markDirty.bind(st),
    clearPending: st.clearPending.bind(st),
    isWriter: true,
  };
  const w = new FanWatch(sink, { helper: "x", root: dir, procMounts: "/proc/mounts", settleMs: 100, modifyMs: 1500, commitMs: o.commitMs, exclude: o.exclude });
  const tx0 = st.writeTransactions;
  const io0 = wchar();
  const t0 = Date.now();
  for (let sent = 0; sent < EVENTS; ) {
    for (let i = 0; i < 625; i++, sent++) {
      const d = sent % FOLDERS;
      const kind = sent % 10 === 0 ? "C" : sent % 10 === 5 ? "W" : "M";
      w.line(`${kind} f ${dir}/data/${o.sub}/d${d}/inner/f${sent}`);
      if (sent % 7 === 0) w.line(`${kind === "M" ? "C" : kind} f ${dir}/data/${o.sub}/d${d}/f${sent % 5}`);
    }
    await sleep(100);
  }
  // let the open interval end and the folders be re-read
  await sleep(o.commitMs + 2500);
  await w.handover(10);
  await sleep(500);
  const tx = st.writeTransactions - tx0;
  const bytes = wchar() - io0;
  const stats = w.status().size;
  console.log(`LOAD ${label}: events=${EVENTS} seconds=${((Date.now() - t0) / 1000).toFixed(1)} sqlite_write_transactions=${tx} bytes_written=${bytes} commit_rounds=${stats.commits} dirty_paths=${stats.dirtyPaths} excluded_events=${stats.excludedEvents}`);
  w.stop();
  await st.close();
  fs.rmSync(dir, { recursive: true, force: true });
  return { tx, bytes, stats };
}

test("load: 50,000 events in a busy subtree cost far fewer writes with the commit interval, and none in an excluded folder", async () => {
  const legacy = await run("legacy (before)", { commitMs: 0, exclude: [], sub: "busy" });
  const batched = await run("batched (after)", { commitMs: 1500, exclude: parseSizeExclude(DEFAULT_SIZE_EXCLUDE), sub: "busy" });
  const excluded = await run("excluded folder (after)", { commitMs: 1500, exclude: parseSizeExclude(DEFAULT_SIZE_EXCLUDE), sub: "node_modules" });
  assert.ok(batched.tx * 3 < legacy.tx, `batched ${batched.tx} against legacy ${legacy.tx}`);
  assert.ok(excluded.tx <= 5, `excluded folder: ${excluded.tx} write transactions`);
  assert.ok(excluded.stats.excludedEvents >= EVENTS);
  if (Number.isFinite(legacy.bytes)) assert.ok(batched.bytes < legacy.bytes, `bytes ${batched.bytes} against ${legacy.bytes}`);
});
