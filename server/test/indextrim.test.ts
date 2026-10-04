import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { IndexCache, openDb, type DirReader, type IdxEntry } from "../src/index-cache.ts";

const big = (n: number): IdxEntry[] => Array.from({ length: n }, (_, i) => ({ n: `f${i}`, t: "file" as const, s: i, m: 1000 + i, i: i + 1 }));
const reader = (entries: IdxEntry[]): DirReader => ({ statDir: async () => ({ ino: 1, mtime: 5 }), readDir: async () => entries });

test("a large directory is stored in yielding batches and served back intact", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fd-idx-"));
  const idx = new IndexCache(path.join(dir, "i.db"), reader(big(30_000)), { ttlMs: 60_000 });
  try {
    const h = monitorEventLoopDelay({ resolution: 5 });
    h.enable();
    const a = await idx.list("/tmp");
    h.disable();
    assert.equal(a.cached, false);
    assert.equal(a.entries.length, 30_000);
    // no single block anywhere near the old whole-listing transaction (generous bound for slow CI disks)
    assert.ok(h.max / 1e6 < 1500, `event loop blocked ${h.max / 1e6} ms`);
    const b = await idx.list("/tmp");
    assert.equal(b.cached, true);
    assert.equal(b.entries.length, 30_000);
  } finally {
    idx.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("trimAsync runs in a worker, drops stale and over-budget directories and leaves the index usable", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fd-idx-"));
  const file = path.join(dir, "i.db");
  const idx = new IndexCache(file, reader(big(50)), { ttlMs: 60_000, maxEntries: 120 });
  try {
    for (const d of ["/a", "/b", "/c", "/d"]) await idx.list(d);
    // /old was last used 40 days ago
    const db = openDb(file)!;
    db.prepare("INSERT INTO dirs (path, ino, mtime, listed_at, used_at) VALUES ('/old', 1, 5, 0, ?)").run(Date.now() - 40 * 86400_000);
    db.prepare("INSERT INTO ents (dir, name, t, s, m, ino, l, hash) VALUES ('/old', 'x', 'file', 1, 1, 1, NULL, NULL)").run();
    db.close();
    // the loop keeps turning while the worker scans
    let ticks = 0;
    const t = setInterval(() => ticks++, 1);
    const r = await idx.trimAsync();
    clearInterval(t);
    assert.ok(r.removed >= 2, `removed ${r.removed}`); // /old plus at least one LRU directory
    assert.ok(ticks > 0);
    const chk = openDb(file)!;
    const rows = (chk.prepare("SELECT count(*) AS n FROM ents").get() as { n: number }).n;
    const olds = (chk.prepare("SELECT count(*) AS n FROM dirs WHERE path = '/old'").get() as { n: number }).n;
    chk.close();
    assert.equal(olds, 0);
    assert.ok(rows <= 120, `rows ${rows}`);
    // still serves: a trimmed directory is simply re-read, a kept one is a hit
    assert.equal((await idx.list("/a")).entries.length, 50);
    assert.equal((await idx.list("/d")).entries.length, 50);
  } finally {
    idx.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
