import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createAgent } from "../src/agent.ts";
import { loadConfig } from "../src/config.ts";

test("/api/metrics reports the size store as available and not damaged", async () => {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "filedeck-metrics-")));
  fs.mkdirSync(path.join(tmp, "root"));
  const app = createAgent(loadConfig({ FILEDECK_ROOT: path.join(tmp, "root"), FILEDECK_NODE: "t", FILEDECK_JOBS_FILE: path.join(tmp, "jobs.db") } as never));
  try {
    const r = (await app.request("/api/metrics")) as Response;
    assert.equal(r.status, 200);
    const t = await r.text();
    assert.match(t, /^# TYPE filedeck_size_store_available gauge$/m);
    assert.match(t, /^filedeck_size_store_available [01]$/m);
    assert.match(t, /^filedeck_size_store_damaged 0$/m);
  } finally {
    await (app as unknown as { close(): Promise<void> }).close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
