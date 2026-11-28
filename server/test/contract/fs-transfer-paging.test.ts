import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { contractTest } from "./agent-under-test.ts";
import { getJson, streamLines, withAgent } from "./fs-fixture.ts";

// The agent side of test/transfer-paging.test.ts. The hub's copy and move jobs read a node with these calls only:
// list (a page, with `truncated`), stat, and download with ranges. The jobs themselves stay in the TS tests.
const tree = (root: string) => {
  fs.mkdirSync(path.join(root, "src/sub"), { recursive: true });
  for (let i = 0; i < 1200; i++) fs.writeFileSync(path.join(root, "src", `f${i}`), String(i));
  fs.writeFileSync(path.join(root, "real"), "real data");
  fs.symlinkSync("../real", path.join(root, "src/ln"));
  fs.symlinkSync("missing", path.join(root, "src/broken"));
  fs.symlinkSync("sub", path.join(root, "src/dirln"));
};

contractTest("a folder with many entries lists whole, and a link reports its target", () =>
  withAgent({ setup: tree, prefix: "fd-page-" }, async (app) => {
    const l = await getJson(app, "/api/fs/list?path=/src");
    assert.equal(l.body.truncated, false);
    assert.equal(l.body.entries.length, 1200 + 4);
    const by = (n: string) => l.body.entries.find((e: { name: string }) => e.name === n);
    assert.equal(by("ln").type, "symlink");
    assert.equal(by("ln").linkDir, false);
    assert.equal(by("dirln").linkDir, true);
    assert.equal(by("broken").broken, true);
    assert.equal(by("f7").size, 1);
    assert.equal(by("sub").type, "dir");
  }),
);

contractTest("a link chosen by name is followed by a download; a broken link fails with 404", () =>
  withAgent({ setup: tree, prefix: "fd-page-" }, async (app) => {
    const ok = await app.request("/api/fs/download?path=/src/ln");
    assert.equal(ok.status, 200);
    assert.equal(await ok.text(), "real data");
    assert.equal(ok.headers.get("content-length"), "9");
    assert.equal((await app.request("/api/fs/download?path=/src/broken")).status, 404);
    assert.equal((await app.request("/api/fs/download?path=/src/dirln")).status, 400, "a link to a folder is a folder");
  }),
);

contractTest("a streamed listing always ends with a done line, and a bad path fails with a status before any line", () =>
  withAgent({ setup: tree, prefix: "fd-page-" }, async (app) => {
    const lines = await streamLines(app, "/api/fs/list?path=/src&stream=1");
    assert.deepEqual(lines.at(-1), { done: { path: "/src", truncated: false } });
    assert.equal(lines.flatMap((l) => l.e ?? []).length, 1204);
    const missing = await app.request("/api/fs/list?path=/nope&stream=1");
    assert.equal(missing.status, 404);
    assert.match(missing.headers.get("content-type") ?? "", /^application\/json/);
    assert.deepEqual(await missing.json(), { error: "not found" });
    const file = await app.request("/api/fs/list?path=/real&stream=1");
    assert.equal(file.status, 400);
    assert.deepEqual(await file.json(), { error: "not a directory" });
  }),
);

contractTest("a file reads back whole from ranges of any size, and a range past the end is 416", () =>
  withAgent({ setup: (root) => fs.writeFileSync(path.join(root, "big.bin"), crypto.randomBytes(3_000_001)), prefix: "fd-page-" }, async (app, root) => {
    const want = fs.readFileSync(path.join(root, "big.bin"));
    const size = want.length;
    for (const page of [1 << 20, 65_536, 999_999]) {
      const parts: Buffer[] = [];
      for (let at = 0; at < size; at += page) {
        const end = Math.min(at + page, size) - 1;
        const r = await app.request("/api/fs/download?path=/big.bin", { headers: { range: `bytes=${at}-${end}` } });
        assert.equal(r.status, 206, `page ${page} at ${at}`);
        assert.equal(r.headers.get("content-range"), `bytes ${at}-${end}/${size}`);
        assert.equal(r.headers.get("content-length"), String(end - at + 1));
        parts.push(Buffer.from(await r.arrayBuffer()));
      }
      assert.ok(Buffer.concat(parts).equals(want), `page ${page}`);
    }
    const whole = await app.request("/api/fs/download?path=/big.bin");
    assert.equal(whole.status, 200);
    assert.equal(whole.headers.get("content-length"), String(size));
    assert.ok(Buffer.from(await whole.arrayBuffer()).equals(want));
    const past = await app.request("/api/fs/download?path=/big.bin", { headers: { range: `bytes=${size}-` } });
    assert.equal(past.status, 416);
    assert.equal(past.headers.get("content-range"), `bytes */${size}`);
  }),
);

const notRoot = process.getuid?.() !== 0;

contractTest("one item that cannot be read gives 403 and does not stop the others", (t) => {
  if (!notRoot) return void t.skip("root reads everything");
  return withAgent(
    {
      setup: (root) => {
        fs.mkdirSync(path.join(root, "d/locked"), { recursive: true });
        fs.writeFileSync(path.join(root, "d/locked/in"), "x");
        fs.writeFileSync(path.join(root, "d/ok.txt"), "ok");
        fs.writeFileSync(path.join(root, "d/hidden.txt"), "no");
        fs.chmodSync(path.join(root, "d/hidden.txt"), 0);
        fs.chmodSync(path.join(root, "d/locked"), 0);
      },
      prefix: "fd-page-",
    },
    async (app, root) => {
      try {
        assert.equal((await app.request("/api/fs/read?path=/d/hidden.txt")).status, 403);
        assert.equal((await app.request("/api/fs/text?path=/d/hidden.txt")).status, 403);
        assert.equal((await app.request("/api/fs/list?path=/d/locked")).status, 403);
        assert.equal((await app.request("/api/fs/list?path=/d/locked&stream=1")).status, 403);
        assert.equal(await (await app.request("/api/fs/read?path=/d/ok.txt")).text(), "ok");
        const l = await getJson(app, "/api/fs/list?path=/d");
        assert.deepEqual(l.body.entries.map((e: { name: string }) => e.name).sort(), ["hidden.txt", "locked", "ok.txt"], "the folder still lists");
      } finally {
        fs.chmodSync(path.join(root, "d/locked"), 0o755);
        fs.chmodSync(path.join(root, "d/hidden.txt"), 0o644);
      }
    },
  );
});
