import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { contractTest } from "./agent-under-test.ts";
import { getJson, q, streamLines, withAgent } from "./fs-fixture.ts";

// The HTTP form of the list parts of test/scale-readdir.test.ts: a folder far above the entry cap.
const MAX_LIST = 20_000;
const setup = (root: string) => {
  const big = path.join(root, "big");
  fs.mkdirSync(big);
  for (let i = 0; i < 50_000; i++) fs.writeFileSync(path.join(big, `f${String(i).padStart(6, "0")}`), "");
  for (let i = 0; i < 20; i++) fs.mkdirSync(path.join(big, `d${i}`));
};
// folders first, in natural order (d0, d1, d2, ... d19), then the files in name order
const want = [...Array.from({ length: 20 }, (_, i) => `d${i}`), ...Array.from({ length: 50_000 }, (_, i) => `f${String(i).padStart(6, "0")}`)].slice(0, MAX_LIST);

contractTest("a folder of 50 020 names: the plain list stops at 20 000 and says it is truncated", () =>
  withAgent({ setup, prefix: "fd-scale-" }, async (app) => {
    const plain = await getJson(app, "/api/fs/list?path=/big&hidden=1");
    assert.equal(plain.status, 200);
    assert.equal(plain.body.entries.length, MAX_LIST);
    assert.equal(plain.body.truncated, true);
    assert.equal(plain.body.path, "/big");
  }),
);

contractTest("the streamed list of that folder is the first 20 000 names of a full sort, in batches, ending with one done line", () =>
  withAgent({ setup, prefix: "fd-scale-" }, async (app) => {
    const lines = await streamLines(app, "/api/fs/list?path=/big&hidden=1&stream=1");
    const done = lines.at(-1);
    assert.deepEqual(done, { done: { path: "/big", truncated: true } });
    assert.equal(lines.filter((l) => l.done).length, 1, "one done line");
    const batches = lines.slice(0, -1);
    assert.ok(batches.every((l) => Array.isArray(l.e) && Object.keys(l).length === 1), "every other line is a batch");
    assert.equal(batches[0].e.length, 100, "a small first batch, for a quick first paint");
    assert.ok(batches.slice(1).every((l) => l.e.length <= 500), "later batches have at most 500 rows");
    const names: string[] = batches.flatMap((l) => l.e.map((e: { name: string }) => e.name));
    assert.equal(names.length, MAX_LIST);
    assert.deepEqual(names, want);
    // a row of the streamed list is the same row as in the plain list
    const plain = await getJson(app, "/api/fs/list?path=/big&hidden=1");
    const byName = new Map<string, unknown>(batches.flatMap((l) => l.e).map((e: { name: string }) => [e.name, e]));
    let same = 0;
    for (const e of plain.body.entries.slice(0, 500)) {
      if (byName.has(e.name)) { assert.deepEqual(byName.get(e.name), e, e.name); same++; }
    }
    assert.ok(same > 0, "the plain list and the streamed list share rows");
  }),
);

contractTest("a small folder streams its rows, then done with truncated false", () =>
  withAgent(
    {
      setup: (root) => {
        fs.mkdirSync(path.join(root, "s"));
        for (const n of ["b", "a", "c"]) fs.writeFileSync(path.join(root, "s", n), n);
        fs.mkdirSync(path.join(root, "s/z"));
      },
      prefix: "fd-scale-",
    },
    async (app) => {
      const lines = await streamLines(app, `/api/fs/list?path=${q("/s")}&stream=1`);
      assert.equal(lines.length, 2);
      assert.deepEqual(lines[0].e.map((e: { name: string }) => e.name), ["z", "a", "b", "c"]);
      assert.deepEqual(lines[1], { done: { path: "/s", truncated: false } });
      const r = await app.request("/api/fs/list?path=/s&stream=1");
      assert.match(r.headers.get("content-type") ?? "", /^application\/x-ndjson/);
      assert.equal(r.headers.get("cache-control"), "no-store");
    },
  ),
);

contractTest("an empty folder streams only the done line", () =>
  withAgent({ setup: (root) => fs.mkdirSync(path.join(root, "e")), prefix: "fd-scale-" }, async (app) => {
    assert.deepEqual(await streamLines(app, "/api/fs/list?path=/e&stream=1"), [{ done: { path: "/e", truncated: false } }]);
    assert.deepEqual((await getJson(app, "/api/fs/list?path=/e")).body, { path: "/e", entries: [], truncated: false });
  }),
);
