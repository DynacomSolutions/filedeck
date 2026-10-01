import { test } from "node:test";
import assert from "node:assert/strict";
import { gatherDrop } from "../../web/src/dropTree.ts";

type E = { isFile: boolean; isDirectory: boolean; name: string; file?: (ok: (f: File) => void) => void; createReader?: () => { readEntries: (ok: (e: E[]) => void) => void } };
const file = (name: string, body = "x"): E => ({ isFile: true, isDirectory: false, name, file: (ok) => ok(new File([body], name)) });
// readEntries hands out at most `page` entries per call, like Chrome (100), until it returns []
const dir = (name: string, kids: E[], page = 2): E => ({
  isFile: false,
  isDirectory: true,
  name,
  createReader: () => {
    let i = 0;
    return { readEntries: (ok) => { const out = kids.slice(i, i + page); i += page; ok(out); } };
  },
});

test("dropped folders keep their tree, empty folders and paged directory reads", async () => {
  const tree = dir("photos", [file("a.txt"), dir("2026", [file("b.txt"), dir("raw", [file("r.cr2")])]), dir("empty", []), file("c.txt"), file("d.txt")]);
  const { picked, dirs } = await gatherDrop({ entries: [tree as never, file("loose.txt") as never], plain: [] });
  assert.deepEqual(picked.map((p) => p.rel).sort(), ["loose.txt", "photos/2026/b.txt", "photos/2026/raw/r.cr2", "photos/a.txt", "photos/c.txt", "photos/d.txt"]);
  assert.deepEqual(dirs.sort(), ["photos", "photos/2026", "photos/2026/raw", "photos/empty"]);
});

test("without directory entries the plain files are used", async () => {
  const f = new File(["z"], "z.txt");
  const { picked, dirs } = await gatherDrop({ entries: [], plain: [f] });
  assert.deepEqual(picked.map((p) => p.rel), ["z.txt"]);
  assert.deepEqual(dirs, []);
});
