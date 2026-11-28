import { before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ContractUnsupported, agentUnderTest, contractMode, contractTest, dropFixtureRoot, fixtureRoot, type AgentUnderTest } from "./agent-under-test.ts";

// The folder size job and the du route, from test/props.test.ts. The permission and props tests stay there (write phase).
let tmp: string, outside: string, app: AgentUnderTest;

before(async () => {
  tmp = fixtureRoot("filedeck-props-");
  outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "filedeck-props-out-")));
  fs.mkdirSync(path.join(tmp, "tree/sub/deep"), { recursive: true });
  fs.writeFileSync(path.join(tmp, "tree/a.txt"), "12345");
  fs.writeFileSync(path.join(tmp, "tree/sub/b.txt"), "1234567890");
  fs.writeFileSync(path.join(tmp, "tree/sub/deep/c.txt"), "x");
  fs.writeFileSync(path.join(outside, "target.txt"), "outside");
  fs.symlinkSync(path.join(outside, "target.txt"), path.join(tmp, "tree/link"));
  fs.mkdirSync(path.join(tmp, "tree/.filedeck-trash/x"), { recursive: true });
  fs.writeFileSync(path.join(tmp, "tree/.filedeck-trash/x/data"), "T".repeat(1000));
  app = await agentUnderTest({ root: tmp }); // the default entry cap is 500000
});
after(async () => {
  await app.close();
  dropFixtureRoot(tmp);
  fs.rmSync(outside, { recursive: true, force: true });
});

const post = (url: string, body: unknown, a: AgentUnderTest = app) => a.request(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
type Job = { id: string; state: string; result?: Record<string, number | boolean | string>; error?: string };
async function finish(r: Response, a: AgentUnderTest = app): Promise<Job> {
  assert.equal(r.status, 202, await r.clone().text());
  let j = (await r.json()) as Job;
  for (let i = 0; i < 200 && (j.state === "queued" || j.state === "running"); i++) {
    await new Promise((res) => setTimeout(res, 20));
    j = (await (await a.request(`/api/jobs/${j.id}`)).json()) as Job;
  }
  return j;
}

contractTest("folder size job counts files, folders, links, skips the trash store and never follows links", async () => {
  const j = await finish(await post("/api/jobs/size", { path: "/tree" }));
  assert.equal(j.state, "done");
  assert.equal(j.result!.files, 3);
  assert.equal(j.result!.dirs, 2);
  assert.equal(j.result!.symlinks, 1);
  assert.equal(j.result!.bytes, 5 + 10 + 1);
  assert.equal(j.result!.truncated, false);
  assert.ok((j.result!.diskBytes as number) >= 0);
});

contractTest("two size requests for one path share one job and one walk", async () => {
  const [a, b] = await Promise.all([post("/api/jobs/size", { path: "/tree/sub" }), post("/api/jobs/size", { path: "/tree/sub" })]);
  const [ja, jb] = [(await a.json()) as Job, (await b.json()) as Job];
  assert.equal(ja.id, jb.id);
  assert.equal(((await (await app.request("/api/jobs")).json()) as { jobs: (Job & { kind: string })[] }).jobs.filter((j) => j.kind === "size" && j.id === ja.id).length, 1);
  assert.equal((await finish(await post("/api/jobs/size", { path: "/tree/sub" }))).state, "done");
});

contractTest("a size job starts with the previous scan as its expected total", async () => {
  const first = await finish(await post("/api/jobs/size", { path: "/tree" }));
  const r = first.result as Record<string, number>;
  const sum = r.files! + r.dirs! + r.symlinks! + r.other!;
  const again = (await finish(await post("/api/jobs/size", { path: "/tree" }))) as Job & { progress: { totalEntries: number; totalBytes: number } };
  assert.equal(again.progress.totalEntries, sum);
  assert.equal(again.progress.totalBytes, r.bytes);
});

contractTest("folder size job is not cut short by the entry cap", async () => {
  const small = await agentUnderTest({ root: tmp, env: { FILEDECK_WALK_MAX_ENTRIES: "3" } });
  try {
    const r = await post("/api/jobs/size", { path: "/tree" }, small);
    let j = (await r.json()) as Job;
    for (let i = 0; i < 100 && (j.state === "queued" || j.state === "running"); i++) {
      await new Promise((res) => setTimeout(res, 20));
      j = (await (await small.request(`/api/jobs/${j.id}`)).json()) as Job;
    }
    assert.equal(j.result!.truncated, false);
    assert.equal(j.result!.bytes, 5 + 10 + 1);
  } finally {
    await small.close();
  }
});

contractTest("two du requests for one path, even with other options, join one job and one walk", async () => {
  if (contractMode() === "url") throw new ContractUnsupported("counts all jobs of the agent, so it needs an agent that no earlier test used");
  const dedupe = await agentUnderTest({ root: tmp });
  try {
    const get = (q: string) => dedupe.request(`/api/du?path=/tree/sub&${q}`);
    const [a, b] = await Promise.all([get("depth=0"), get("depth=1")]);
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    assert.equal(((await (await dedupe.request("/api/jobs")).json()) as { jobs: unknown[] }).jobs.length, 1, "one walk");
    assert.ok(((await b.json()) as { entries: unknown[] }).entries.length > 1);
  } finally {
    await dedupe.close();
  }
});
