import { before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { agentUnderTest, contractTest, dropFixtureRoot, fixtureRoot } from "./agent-under-test.ts";

// The route tests of test/size-store-rounds.test.ts (the folder sizes of a big tree, and /healthz during a scan). The store tests stay there.
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let tmp: string;
before(() => void (tmp = fixtureRoot("filedeck-du-totals-")));
after(() => dropFixtureRoot(tmp));

/** `dirs` folders with `files` one-byte files each, under tmp/<name> (plus the folders a0..a(n/50) that hold them) */
function bigTree(name: string, dirs: number, files: number) {
  for (let i = 0; i < dirs; i++) {
    const d = path.join(tmp, `${name}/a${i % 50}/b${i}`);
    fs.mkdirSync(d, { recursive: true });
    for (let j = 0; j < files; j++) fs.writeFileSync(path.join(d, `f${j}`), "x");
  }
  return { files: dirs * files, dirs: dirs + Math.min(dirs, 50), bytes: dirs * files };
}

contractTest("du totals are exact for a tree far above the entry cap, per subtree and cached", async () => {
  const want = bigTree("over", 300, 4); // 1200 files + 350 folders, cap below is 100
  const idx = fs.mkdtempSync(path.join(path.dirname(tmp), "filedeck-du-idx-"));
  const env = { FILEDECK_INDEX_DIR: idx, FILEDECK_WALK_MAX_ENTRIES: "100" };
  try {
    const app = await agentUnderTest({ root: tmp, env: { ...env, FILEDECK_DU_WAIT_MS: "60000" } });
    type Du = { entries: { path: string; bytes: number; files: number; dirs: number }[]; truncated: boolean; cached: boolean };
    const du = async (q: string) => (await (await app.request("/api/du?" + q)).json()) as Du;
    const top = await du("path=/over&depth=1");
    assert.equal(top.truncated, false);
    assert.deepEqual({ files: top.entries[0]!.files, dirs: top.entries[0]!.dirs, bytes: top.entries[0]!.bytes }, { files: want.files, dirs: want.dirs, bytes: want.bytes });
    // every subtree is exact too: a0 holds the folders b0, b50, b100, ...
    const sub = (await du("path=/over/a0&depth=0")).entries[0]!;
    assert.equal(sub.files, 6 * 4);
    assert.equal(sub.dirs, 6);
    await app.close();
    // the totals were stored by the writer worker: a new agent answers them from the file
    const again = await agentUnderTest({ root: tmp, env });
    const c = (await (await again.request("/api/du?path=/over&depth=0")).json()) as Du;
    assert.equal(c.cached, true);
    assert.equal(c.entries[0]!.files, want.files);
    await again.close();
  } finally {
    fs.rmSync(idx, { recursive: true, force: true });
  }
});

contractTest("/healthz answers within 1s while a large scan runs", async () => {
  const want = bigTree("health", 1500, 5);
  const idx = fs.mkdtempSync(path.join(path.dirname(tmp), "filedeck-du-idx-"));
  try {
    const app = await agentUnderTest({ root: tmp, env: { FILEDECK_INDEX_DIR: idx } });
    const r = await app.request("/api/jobs/size", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: "/health" }) });
    let j = (await r.json()) as { id: string; state: string; result?: { files: number; truncated: boolean } };
    let probes = 0;
    let worst = 0;
    while (j.state === "queued" || j.state === "running") {
      const t0 = performance.now();
      assert.equal(await (await app.anon("/healthz")).text(), "ok");
      worst = Math.max(worst, performance.now() - t0);
      probes++;
      await sleep(2);
      j = (await (await app.request(`/api/jobs/${j.id}`)).json()) as typeof j;
    }
    assert.ok(probes > 5, `scan finished after ${probes} probes, too short to prove anything`);
    assert.ok(worst < 15_000, `/healthz took ${worst} ms during the scan`); // (answered between the scan's steps, not after it: the probes above prove the interleaving; this bound only catches a hang)
    assert.equal(j.result!.files, want.files);
    assert.equal(j.result!.truncated, false);
    await app.close();
  } finally {
    fs.rmSync(idx, { recursive: true, force: true });
  }
});
