import { test as baseTest } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as ops from "../src/fsops.ts";
import { applyRetention, listTrash } from "../src/trash.ts";
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
