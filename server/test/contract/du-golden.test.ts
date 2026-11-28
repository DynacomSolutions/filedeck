import { before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { agentUnderTest, contractMode, contractTest, dropFixtureRoot, fixtureRoot } from "./agent-under-test.ts";

// Golden du answers. The files in server/test/contract/golden/du/ were captured from the TS agent (FILEDECK_GOLDEN_UPDATE=1 with no
// FILEDECK_CONTRACT_SPAWN). Every agent must give the same JSON for the same five fixture trees.
// `scannedAt` and `ageMs` (clock) and `diskBytes` (blocks: they depend on the file system the test runs on) are left out of the comparison.
// Entries of `all=1` are sorted by path (a folder is read in the order the file system gives it).
const goldenDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "golden/du");
const update = process.env.FILEDECK_GOLDEN_UPDATE === "1";

let tmp: string;
const put = (rel: string, bytes: number) => {
  const f = path.join(tmp, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, "x".repeat(bytes));
};
const dir = (rel: string) => fs.mkdirSync(path.join(tmp, rel), { recursive: true });

const TREES: Record<string, () => void> = {
  nested() {
    put("nested/f0", 1);
    put("nested/d1/f", 10);
    put("nested/d1/d2/f", 100);
    dir("nested/d1/d2/d3");
    dir("nested/e");
    put("nested/e2/x", 0);
  },
  links() {
    put("links/a", 7);
    fs.linkSync(path.join(tmp, "links/a"), path.join(tmp, "links/b"));
    put("links/d/f", 3);
    fs.symlinkSync("d", path.join(tmp, "links/dirlink"));
    fs.symlinkSync("/does/not/exist", path.join(tmp, "links/broken"));
    fs.symlinkSync("self", path.join(tmp, "links/self"));
    put("links/.filedeck-trash/x", 999);
    put("links/.filedeck-work-123/y", 55);
    put("links/.filedeck-work/z", 5);
  },
  names() {
    for (const n of ["x", "x-1", "x.y", "x y", "é", "日本", "Z", "a", "a-b", "a b"]) put(`names/${n}/in/f`, n.length);
    for (let i = 0; i < 300; i++) put(`names/many/f${i}`, i % 7);
    for (let i = 0; i < 60; i++) put(`names/dirs/d${i}/g`, 2);
  },
  deep() {
    let p = "deep";
    for (let n = 1; n <= 40; n++) {
      p += "/l";
      put(`${p}/f${n}`, n);
    }
  },
  odd() {
    dir("odd/empty");
    put("odd/zero", 0);
    put("odd/four", 4097);
    const f = path.join(tmp, "odd/sparse");
    fs.writeFileSync(f, "");
    fs.truncateSync(f, 1 << 20);
  },
};

before(() => {
  tmp = fixtureRoot("filedeck-golden-");
  for (const build of Object.values(TREES)) build();
});
after(() => dropFixtureRoot(tmp));

const QUERIES = ["depth=0&fresh=1", "depth=1&fresh=1", "depth=3&fresh=1", "depth=2&all=1&fresh=1", "depth=1&cachedOnly=1"];

function normalise(v: unknown, all: boolean): unknown {
  const a = JSON.parse(JSON.stringify(v)) as { entries: { path: string; scannedAt?: number; diskBytes?: number }[]; ageMs?: number };
  delete a.ageMs;
  for (const e of a.entries) {
    delete e.scannedAt;
    delete e.diskBytes;
  }
  if (all) a.entries.sort((x, y) => (x.path < y.path ? -1 : 1));
  return a;
}

for (const name of Object.keys(TREES)) {
  contractTest(`golden du answers: ${name}`, async () => {
    const app = await agentUnderTest({ root: tmp, env: { FILEDECK_DU_WAIT_MS: "60000" } });
    try {
      const got: { q: string; answer: unknown }[] = [];
      for (const q of QUERIES) {
        const r = await app.request(`/api/du?path=/${name}&${q}`);
        assert.equal(r.status, 200, q);
        got.push({ q, answer: normalise(await r.json(), q.includes("all=1")) });
      }
      const file = path.join(goldenDir, `${name}.json`);
      if (update) {
        assert.equal(contractMode(), "spawn", "capture golden files from the TS agent in spawn mode, with no FILEDECK_CONTRACT_SPAWN");
        assert.ok(!process.env.FILEDECK_CONTRACT_SPAWN, "capture golden files from the TS agent only");
        fs.mkdirSync(goldenDir, { recursive: true });
        fs.writeFileSync(file, JSON.stringify({ tree: name, queries: got }, null, 2) + "\n");
        return;
      }
      const want = JSON.parse(fs.readFileSync(file, "utf8")) as { tree: string; queries: typeof got };
      assert.equal(want.tree, name);
      assert.deepEqual(got, want.queries);
    } finally {
      await app.close();
    }
  });
}
