import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { FIRST_BATCH, list, listOrder, listStream, smallest, type Entry } from "../src/fsops.ts";

const collect = async (root: string, p: string, hidden: boolean, batch: number) => {
  const batches: Entry[][] = [];
  let done: { path: string; truncated: boolean } | null = null;
  for await (const v of listStream(root, p, hidden, batch)) {
    if ("entries" in v) batches.push(v.entries);
    else done = v.done;
  }
  return { batches, done };
};

test("listStream sends the default order in batches and the same entries as list", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fd-ls-"));
  try {
    fs.mkdirSync(path.join(root, "d/sub"), { recursive: true });
    for (let i = 1; i <= 12; i++) fs.writeFileSync(path.join(root, "d", `f${i}.txt`), "x");
    fs.mkdirSync(path.join(root, "d/zdir"));
    fs.writeFileSync(path.join(root, "d/.hidden"), "h");
    fs.symlinkSync("zdir", path.join(root, "d/alink")); // a link to a folder sorts with the folders
    const { batches, done } = await collect(root, "/d", false, 5);
    assert.ok(batches.length >= 3, "several batches");
    assert.equal(batches[0]!.length, 5);
    const names = batches.flat().map((e) => e.name);
    assert.deepEqual(names, ["alink", "sub", "zdir", "f1.txt", "f2.txt", "f3.txt", "f4.txt", "f5.txt", "f6.txt", "f7.txt", "f8.txt", "f9.txt", "f10.txt", "f11.txt", "f12.txt"]);
    assert.equal(done?.truncated, false);
    assert.equal(done?.path, "/d");
    const plain = await list(root, "/d", false);
    assert.deepEqual(new Set(names), new Set(plain.entries.map((e) => e.name)));
    assert.ok((await collect(root, "/d", true, 50)).batches.flat().some((e) => e.name === ".hidden"));
    await assert.rejects(collect(root, "/d/f1.txt", false, 5), /not a directory/);
    assert.equal((await collect(root, "/d/sub", false, 5)).batches.length, 0, "an empty folder has only the done line");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("listOrder: folders first, numeric names", () => {
  const x = [{ name: "b10", dir: false }, { name: "b2", dir: false }, { name: "z", dir: true }];
  assert.deepEqual(x.sort(listOrder).map((e) => e.name), ["z", "b2", "b10"]);
});

test("smallest agrees with a full sort, ties included", () => {
  const names = ["b10", "b2", "01", "1", "001", "a", "A", "z", "Z", "x9", "x10", "é", "e"];
  const rows = names.map((name, i) => ({ name, dir: i % 3 === 0 }));
  const full = rows.slice().sort(listOrder);
  for (const k of [1, 3, 7, names.length, names.length + 5]) assert.deepEqual(smallest(rows, k), full.slice(0, k), `k=${k}`);
  assert.deepEqual(smallest(rows.slice().reverse(), 5), full.slice(0, 5), "input order does not matter");
});

test("listStream: a small first batch, then full batches, the same total order, folder links ordered as folders", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fd-ls-"));
  try {
    const d = path.join(root, "d");
    fs.mkdirSync(path.join(d, "zdir"), { recursive: true });
    fs.mkdirSync(path.join(d, "mdir"));
    for (let i = 0; i < 350; i++) fs.writeFileSync(path.join(d, `f${String(i).padStart(3, "0")}`), "x");
    fs.symlinkSync("zdir", path.join(d, "alink"));
    fs.symlinkSync("nowhere", path.join(d, "broken"));
    const { batches } = await collect(root, "/d", false, 200);
    assert.equal(batches[0]!.length, FIRST_BATCH);
    assert.ok(batches.slice(1, -1).every((b) => b.length === 200));
    const names = batches.flat().map((e) => e.name);
    assert.deepEqual(names.slice(0, 3), ["alink", "mdir", "zdir"]);
    assert.equal(names[3], "broken", "a broken link sorts with the files");
    assert.equal(new Set(names).size, 354, "no row twice, none missing");
    const e = batches.flat().find((x) => x.name === "alink")!;
    assert.equal(e.linkDir, true);
    assert.equal(e.target, "zdir");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
