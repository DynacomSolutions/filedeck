import { test as baseTest, before, after, mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { createAgent } from "../src/agent.ts";
import { loadConfig } from "../src/config.ts";
import * as ops from "../src/fsops.ts";
import { uploadChunk } from "../src/chunked.ts";
import { emptyTrash, listTrash } from "../src/trash.ts";
import { withoutReadOnly } from "../src/pinwalk.ts";

// These tests call the operations directly, outside a request: they run in an explicit scope with no read-only prefixes.
const test = (name: string, fn: (t: never) => unknown) => baseTest(name, (t) => withoutReadOnly(() => fn(t as never)) as never);

let tmp: string, app: ReturnType<typeof createAgent>;
before(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "filedeck-trashfix-")));
  app = createAgent(loadConfig({ FILEDECK_ROOT: tmp, FILEDECK_NODE: "t" } as never));
});
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const mkItem = (dir: string, n: number, deletedAt: number) => {
  const id = `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  fs.mkdirSync(path.join(dir, id), { recursive: true });
  fs.writeFileSync(path.join(dir, id, "meta.json"), JSON.stringify({ id, name: `f${n}`, originalPath: `/f${n}`, deletedAt, type: "file", size: 1 }));
  return id;
};

test("emptying by age judges every item, also beyond the listing cap", async () => {
  const dir = path.join(tmp, "empty", ".filedeck-trash");
  const now = Date.now();
  const fresh = 5200;
  for (let i = 0; i < fresh; i++) mkItem(dir, i, now);
  for (let i = 0; i < 40; i++) mkItem(dir, fresh + i, now - 30 * 86400_000);
  const r = await emptyTrash(path.join(tmp, "empty"), "/", 7);
  assert.equal(r.removed, 40);
  assert.equal(r.failed, 0);
  assert.equal(fs.readdirSync(dir).length, fresh);
  const all = await emptyTrash(path.join(tmp, "empty"), "/");
  assert.equal(all.removed, fresh);
});

test("a failed move into the trash leaves no ghost item", async () => {
  fs.writeFileSync(path.join(tmp, "x.txt"), "x");
  const m = mock.method(fsp, "rename", async () => {
    throw Object.assign(new Error("boom"), { code: "EIO" });
  });
  try {
    await assert.rejects(ops.trash(tmp, "/x.txt"));
  } finally {
    m.mock.restore();
  }
  assert.equal(fs.readFileSync(path.join(tmp, "x.txt"), "utf8"), "x");
  assert.deepEqual(fs.readdirSync(path.join(tmp, ".filedeck-trash")), []);
});

test("nothing can be uploaded under the name of the trash store", async () => {
  const up = await app.request("/api/fs/upload?dir=/&name=.filedeck-trash", { method: "PUT", body: "hello" });
  assert.equal(up.status, 403);
  await assert.rejects(
    uploadChunk(tmp, "/", ".filedeck-trash", "a".repeat(32), 0, Readable.from([Buffer.from("hi")]), { total: 2, overwrite: false, maxBytes: 100 }),
    (e: { status?: number }) => e.status === 403,
  );
  await assert.rejects(ops.upload(tmp, "/", ".filedeck-trash", Readable.from([Buffer.from("hi")]), true, 100), (e: { status?: number }) => e.status === 403);
});

test("trash on a volume the drive list hides is still listed", async () => {
  const vol = path.join(tmp, "hiddenvol");
  mkItem(path.join(vol, ".filedeck-trash"), 1, Date.now());
  const table = path.join(tmp, "mounts");
  fs.writeFileSync(table, `tmpfs ${vol.slice(tmp.length)} tmpfs rw 0 0\n`);
  const v = await listTrash(tmp, table);
  const hit = v.find((x) => x.volume === "/hiddenvol");
  assert.ok(hit);
  assert.equal(hit.items.length, 1);
});
