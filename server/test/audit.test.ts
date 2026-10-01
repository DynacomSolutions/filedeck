import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createAgent } from "../src/agent.ts";
import { loadConfig } from "../src/config.ts";

test("audit log records writes, never reads, never contents", async () => {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "filedeck-audit-")));
  const lines: string[] = [];
  const app = createAgent(loadConfig({ FILEDECK_ROOT: tmp, FILEDECK_NODE: "t" } as never), (l) => lines.push(l));
  try {
    await app.request("/api/fs/list?path=/");
    await app.request("/api/fs/mkdir", { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": "100.64.0.9, 10.0.0.1" }, body: JSON.stringify({ path: "/made" }) });
    await app.request("/api/fs/upload?dir=/&name=secret.txt", { method: "PUT", body: "TOPSECRET-CONTENT" });
    await app.request("/api/fs/delete", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ paths: ["/nope"] }) });
    assert.equal(lines.length, 3, "the list (a read) is not logged");
    const [mk, up, del] = lines.map((l) => JSON.parse(l));
    assert.equal(mk.audit, true);
    assert.equal(mk.who, "agent:t");
    assert.equal(mk.method, "POST");
    assert.equal(mk.route, "/api/fs/mkdir");
    assert.equal(mk.body.path, "/made");
    assert.equal(mk.ip, "100.64.0.9");
    assert.equal(mk.status, 201);
    assert.deepEqual(up.query, { dir: "/", name: "secret.txt" });
    assert.equal(up.status, 201);
    assert.equal(del.status, 404);
    assert.ok(!lines.join("\n").includes("TOPSECRET"));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
