import { test as baseTest } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as ops from "../src/fsops.ts";
import { applyRetention, listTrash, deleteItems, restoreItems } from "../src/trash.ts";
import { TRASH_DIR } from "../src/paths.ts";
import { withReadOnly, withoutReadOnly } from "../src/pinwalk.ts";

// the setup calls the operations directly, outside a request: in a scope with no read-only prefixes
const test = (name: string, fn: () => Promise<void>) => baseTest(name, () => withoutReadOnly(fn));

const day = 86_400_000;
/** as the agent runs it: in a read-only scope (no read-only prefixes here) */
const sweep = (root: string, p: Parameters<typeof applyRetention>[2]) => withReadOnly(root, [], () => applyRetention(root, "", p));
function setup() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "trash-retention-")));
  const age = (id: string, daysAgo: number) => {
    const f = path.join(root, TRASH_DIR, id, "meta.json");
    fs.writeFileSync(f, JSON.stringify({ ...JSON.parse(fs.readFileSync(f, "utf8")), deletedAt: Date.now() - daysAgo * day }));
  };
  const ids = async () => (await listTrash(root, "")).flatMap((v) => v.items.map((i) => i.name)).sort();
  return { root, age, ids };
}

test("trash retention: items older than the age limit are purged, newer ones stay", async () => {
  const { root, age, ids } = setup();
  try {
    for (const n of ["old.txt", "new.txt"]) fs.writeFileSync(path.join(root, n), "x");
    fs.mkdirSync(path.join(root, "olddir/sub"), { recursive: true });
    fs.writeFileSync(path.join(root, "olddir/sub/f"), "y");
    const a = await ops.trash(root, "/old.txt");
    const d = await ops.trash(root, "/olddir");
    await ops.trash(root, "/new.txt");
    age(a.id, 8);
    age(d.id, 30);
    const r = await sweep(root, { maxAgeDays: 7, maxPercent: 0, maxBytes: 0 });
    assert.deepEqual(r.map((x) => [x.volume, x.removed, x.failed]), [["/", 2, 0]]);
    assert.deepEqual(await ids(), ["new.txt"]);
    assert.deepEqual(await sweep(root, { maxAgeDays: 7, maxPercent: 0, maxBytes: 0 }), [], "nothing more to do");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("trash retention: over the size cap the oldest items go first, until the trash fits; read-only volumes are left alone", async () => {
  const { root, age, ids } = setup();
  try {
    const big = "z".repeat(64 * 1024);
    for (const [n, days] of [["a", 3], ["b", 2], ["c", 1]] as const) {
      fs.writeFileSync(path.join(root, n), big);
      age((await ops.trash(root, "/" + n)).id, days);
    }
    assert.deepEqual(await sweep(root, { maxAgeDays: 0, maxPercent: 0, maxBytes: 150 * 1024, blocked: () => true }), []);
    assert.deepEqual(await ids(), ["a", "b", "c"]);
    // each item takes a little over 64 KiB on disk (data plus meta.json): 150 KiB holds two, so only the oldest goes
    const r = await sweep(root, { maxAgeDays: 0, maxPercent: 0, maxBytes: 150 * 1024 });
    assert.equal(r[0]!.removed, 1);
    assert.ok(r[0]!.freed >= 64 * 1024);
    assert.deepEqual(await ids(), ["b", "c"]);
    // the measured size is kept with the item
    const kept = fs.readdirSync(path.join(root, TRASH_DIR)).map((id) => JSON.parse(fs.readFileSync(path.join(root, TRASH_DIR, id, "meta.json"), "utf8")));
    assert.ok(kept.every((m) => m.diskBytes >= 64 * 1024));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("trash retention: an old item that cannot be removed stops the cap purge; newer items are never deleted past it", async () => {
  if (process.getuid?.() === 0) return; // root deletes in a read-only folder
  const { root, age, ids } = setup();
  let locked = "";
  try {
    const big = "z".repeat(64 * 1024);
    fs.mkdirSync(path.join(root, "stuck/ro"), { recursive: true });
    fs.writeFileSync(path.join(root, "stuck/ro/f"), big);
    const s = await ops.trash(root, "/stuck");
    age(s.id, 5);
    for (const [n, days] of [["b", 2], ["c", 1]] as const) {
      fs.writeFileSync(path.join(root, n), big);
      age((await ops.trash(root, "/" + n)).id, days);
    }
    locked = path.join(root, TRASH_DIR, s.id, "data", "ro");
    fs.chmodSync(locked, 0o555); // its file cannot be unlinked
    const r = await sweep(root, { maxAgeDays: 0, maxPercent: 0, maxBytes: 70 * 1024 });
    assert.deepEqual([r[0]!.removed, r[0]!.failed >= 1], [0, true]);
    assert.deepEqual(await ids(), ["b", "c"], "the stuck item left the list (renamed for removal); the newer ones stay");
    fs.chmodSync(path.join(root, TRASH_DIR, ".purge-" + s.id, "data", "ro"), 0o755);
    locked = "";
    await sweep(root, { maxAgeDays: 0, maxPercent: 0, maxBytes: 0 });
    assert.ok(!fs.readdirSync(path.join(root, TRASH_DIR)).some((n) => n.startsWith(".purge-")), "the next sweep clears what was left");
  } finally {
    if (locked) fs.chmodSync(locked, 0o755);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("trash retention: hard links in an item are counted once", async () => {
  const { root } = setup();
  try {
    fs.mkdirSync(path.join(root, "snap"));
    fs.writeFileSync(path.join(root, "snap/one"), "z".repeat(256 * 1024));
    for (let i = 0; i < 9; i++) fs.linkSync(path.join(root, "snap/one"), path.join(root, `snap/link${i}`));
    await ops.trash(root, "/snap");
    // ten names, one copy on disk: a 400 KiB cap holds it
    assert.deepEqual(await sweep(root, { maxAgeDays: 0, maxPercent: 0, maxBytes: 400 * 1024 }), []);
    const meta = fs.readdirSync(path.join(root, TRASH_DIR)).map((id) => JSON.parse(fs.readFileSync(path.join(root, TRASH_DIR, id, "meta.json"), "utf8")));
    assert.ok(meta[0].diskBytes < 400 * 1024 && meta[0].diskBytes >= 256 * 1024, `diskBytes ${meta[0].diskBytes}`);
    assert.ok(!fs.readdirSync(path.join(root, TRASH_DIR, fs.readdirSync(path.join(root, TRASH_DIR))[0]!)).some((n) => n.startsWith(".meta-")), "no temp file left");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("trash: a restore and a removal of the same item never run together", async () => {
  const { root } = setup();
  try {
    fs.mkdirSync(path.join(root, "keep"));
    fs.writeFileSync(path.join(root, "keep/f"), "precious");
    const t = await ops.trash(root, "/keep");
    const [del, res] = await Promise.all([deleteItems(root, "/", [t.id]), restoreItems(root, "/", [t.id])]);
    const oks = [del[0]!.ok, res[0]!.ok];
    assert.equal(oks.filter(Boolean).length, 1, JSON.stringify([del, res]));
    if (res[0]!.ok) assert.equal(fs.readFileSync(path.join(root, "keep/f"), "utf8"), "precious", "a restored item is whole");
    else assert.match(res[0]!.error ?? "", /being restored or removed|no such|not found/i);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("trash retention: a read-only folder elsewhere does not stop the sweep of the root volume", async () => {
  const { root, age, ids } = setup();
  try {
    fs.writeFileSync(path.join(root, "old"), "x");
    age((await ops.trash(root, "/old")).id, 30);
    fs.mkdirSync(path.join(root, "archive"));
    await withReadOnly(root, ["/archive"], () => applyRetention(root, "", { maxAgeDays: 7, maxPercent: 0, maxBytes: 0 }));
    assert.deepEqual(await ids(), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
