import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { agentUnderTest, contractTest, inProcessOnly } from "./agent-under-test.ts";

contractTest("/metrics reports the size store as available and not damaged", async () => {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "filedeck-metrics-")));
  fs.mkdirSync(path.join(tmp, "root"));
  const app = await agentUnderTest({ root: path.join(tmp, "root"), env: { FILEDECK_JOBS_FILE: path.join(tmp, "jobs.db"), FILEDECK_AGENT_TOKEN: "secret" } });
  try {
    // no credentials: scraped by pod address
    const r = await app.anon("/metrics");
    assert.equal(r.status, 200);
    const t = await r.text();
    assert.match(t, /^# TYPE filedeck_size_store_available gauge$/m);
    assert.match(t, /^filedeck_size_store_available [01]$/m);
    assert.match(t, /^filedeck_size_store_damaged 0$/m);
    assert.match(t, /^filedeck_jobs_queued 0$/m);
    assert.match(t, /^filedeck_jobs_oldest_queued_seconds 0\.000$/m);
    assert.match(t, /^filedeck_size_lock_oldest_wait_seconds 0\.000$/m);
    assert.match(t, /^filedeck_groups_requests_total 0$/m);
    assert.match(t, /^filedeck_groups_errors_total 0$/m);
    assert.match(t, /^filedeck_groups_last_success_timestamp_seconds 0$/m);
    assert.match(t, /^filedeck_watcher_mounts_covered \d+$/m);
    assert.match(t, /^filedeck_watcher_mounts_unsupported \d+$/m);
    assert.match(t, /^filedeck_watcher_mount_aliases \d+$/m);
    assert.equal(t.split("\n").filter((l) => l && !l.startsWith("#")).length, 70); // (54 of the size store, the watcher and the events, and 16 of the holder table)
    // a job that waits shows in the gauges (it needs the agent's job queue, so it runs in process only)
    if (inProcessOnly()) {
      const jobs = (app.raw as unknown as { jobs: { create(k: string, t: string, run: () => Promise<unknown>, d?: undefined, gate?: () => Promise<void>): unknown } }).jobs;
      jobs.create("du", "t", async () => undefined, undefined, () => new Promise<void>(() => {}));
      await new Promise((r) => setTimeout(r, 30));
      const t2 = await (await app.anon("/metrics")).text();
      assert.match(t2, /^filedeck_jobs_queued 1$/m);
      assert.doesNotMatch(t2, /^filedeck_jobs_oldest_queued_seconds 0\.000$/m);
    }
    // everything else still needs the token
    assert.equal((await app.anon("/api/info")).status, 401);
    assert.equal((await app.anon("/api/metrics")).status, 401);
    assert.equal((await app.anon("/api/info", { headers: { authorization: "Bearer secret" } })).status, 200);
  } finally {
    await app.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
