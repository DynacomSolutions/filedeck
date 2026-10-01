import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createAgent } from "../src/agent.ts";
import { loadConfig } from "../src/config.ts";
import { parseReadOnly } from "../src/readonly.ts";

test("parseReadOnly keeps absolute prefixes only", () => {
  assert.deepEqual(parseReadOnly(" /mnt/a/, rel ,/ , /x"), ["/mnt/a", "/", "/x"]);
  assert.deepEqual(parseReadOnly(undefined), []);
});

test("read-only prefixes block every change under them, reads and outside writes pass", async () => {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "filedeck-ro-")));
  try {
    fs.mkdirSync(path.join(tmp, "ro/sub"), { recursive: true });
    fs.mkdirSync(path.join(tmp, "rw"));
    fs.writeFileSync(path.join(tmp, "ro/a.txt"), "x");
    fs.symlinkSync("../ro", path.join(tmp, "rw/into-ro"));
    const app = createAgent(loadConfig({ FILEDECK_ROOT: tmp, FILEDECK_NODE: "t", FILEDECK_READONLY: "/ro" } as never));
    const post = (u: string, b: unknown) => app.request(u, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) });
    const denied = async (r: Response | Promise<Response>) => {
      const x = await r;
      assert.equal(x.status, 403);
      assert.equal(((await x.json()) as { error: string }).error, "read-only volume");
    };
    assert.equal((await app.request("/api/fs/list?path=/ro")).status, 200);
    assert.equal((await app.request("/api/fs/read?path=/ro/a.txt")).status, 200);
    await denied(post("/api/fs/mkdir", { path: "/ro/new" }));
    await denied(post("/api/fs/delete", { paths: ["/ro/a.txt"] }));
    await denied(post("/api/fs/trash", { paths: ["/ro/a.txt"] }));
    await denied(post("/api/fs/rename", { from: "/ro/a.txt", to: "/rw/a.txt" }));
    await denied(post("/api/fs/rename", { from: "/rw/x", to: "/ro/x" }));
    await denied(post("/api/fs/move", { from: ["/ro/a.txt"], toDir: "/rw" }));
    await denied(post("/api/fs/copy", { from: ["/rw"], toDir: "/ro" }));
    await denied(post("/api/fs/perms", { path: "/ro/a.txt", mode: 0o600 }));
    await denied(post("/api/fs/mkdir", { path: "/rw/into-ro/viasym" }));
    await denied(app.request("/api/fs/upload?dir=/ro&name=u", { method: "PUT", body: "x" }));
    await denied(app.request("/api/fs/write?path=/ro/a.txt", { method: "PUT", headers: { "if-match": "x" }, body: "y" }));
    await denied(app.request("/api/fs/write?path=/rw/into-ro/a.txt", { method: "PUT", headers: { "if-match": "x" }, body: "y" }));
    assert.equal(fs.readFileSync(path.join(tmp, "ro/a.txt"), "utf8"), "x");
    assert.ok(!fs.existsSync(path.join(tmp, "ro/new")));
    // copying out of a read-only volume is a read
    assert.equal((await post("/api/fs/copy", { from: ["/ro/a.txt"], toDir: "/rw" })).status, 200);
    assert.equal((await post("/api/fs/mkdir", { path: "/rw/ok" })).status, 201);
    assert.equal((await app.request("/api/fs/upload?dir=/rw&name=u", { method: "PUT", body: "x" })).status, 201);
    const info = (await (await app.request("/api/info")).json()) as { readOnly: string[] };
    assert.deepEqual(info.readOnly, ["/ro"]);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
