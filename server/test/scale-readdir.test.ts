import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { walkTree, type WalkOpts } from "../src/walk.ts";
import { list, listOrder, listStream, MAX_LIST } from "../src/fsops.ts";
import { listTrash, MAX_TRASH_ITEMS } from "../src/trash.ts";
import { TRASH_DIR } from "../src/paths.ts";

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "filedeck-scale-")));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
// Handles open on something under the test folder (other fds of the process do not count).
const fds = () =>
  fs.readdirSync("/proc/self/fd").filter((n) => {
    try {
      return fs.readlinkSync(`/proc/self/fd/${n}`).startsWith(tmp + path.sep);
    } catch {
      return false; // closed during the read
    }
  }).length;
const big = path.join(tmp, "big");
fs.mkdirSync(big);
for (let i = 0; i < 50_000; i++) fs.writeFileSync(path.join(big, `f${String(i).padStart(6, "0")}`), "");
for (let i = 0; i < 20; i++) fs.mkdirSync(path.join(big, `d${i}`));

test("walkTree stops at max on a 50 000 file folder and closes the Dir", async () => {
  const o: WalkOpts = { hidden: true, depth: 1, max: 100, include: [], exclude: [], ignoreCase: false };
  const g = walkTree(tmp, "/big", o);
  let n = 0;
  let r = await g.next();
  while (!r.done) (n += r.value.length, (r = await g.next()));
  assert.equal(n, 100);
  assert.equal(r.value.truncated, true);
  assert.equal(fds(), 0, "no leaked directory handle");
});

test("list and listStream give the same first page as a full sort", async () => {
  const names = fs.readdirSync(big).map((name) => ({ name, dir: name.startsWith("d") })).sort(listOrder).map((x) => x.name);
  const plain = await list(tmp, "/big", true);
  assert.equal(plain.entries.length, MAX_LIST);
  assert.equal(plain.truncated, true);
  const got: string[] = [];
  let truncated = false;
  for await (const v of listStream(tmp, "/big", true, 500)) {
    if ("entries" in v) got.push(...v.entries.map((e) => e.name));
    else truncated = v.done.truncated;
  }
  assert.equal(fds(), 0);
  assert.equal(truncated, true);
  assert.deepEqual(got, names.slice(0, MAX_LIST));
});

test("trash listing reads a folder with many items and caps it", async () => {
  const root = path.join(tmp, "tr");
  const t = path.join(root, TRASH_DIR);
  fs.mkdirSync(t, { recursive: true });
  const total = MAX_TRASH_ITEMS + 300;
  for (let i = 0; i < total; i++) fs.mkdirSync(path.join(t, `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`));
  fs.mkdirSync(path.join(t, "not-an-id"));
  const v = await listTrash(root, "");
  assert.equal(v[0]!.items.length, MAX_TRASH_ITEMS);
  assert.equal(v[0]!.truncated, true);
  assert.equal(fds(), 0);
});
