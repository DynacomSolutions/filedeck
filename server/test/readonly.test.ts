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
    await denied(post("/api/fs/symlink", { path: "/ro/ln", target: "a.txt" }));
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

test("an ancestor of a read-only prefix cannot be removed, moved or changed recursively", async () => {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "filedeck-roanc-")));
  try {
    fs.mkdirSync(path.join(tmp, "srv/backup"), { recursive: true });
    fs.mkdirSync(path.join(tmp, "srv/other"));
    fs.writeFileSync(path.join(tmp, "srv/backup/a.txt"), "x");
    fs.symlinkSync("srv", path.join(tmp, "lnk"));
    const app = createAgent(loadConfig({ FILEDECK_ROOT: tmp, FILEDECK_NODE: "t", FILEDECK_READONLY: "/srv/backup" } as never));
    const post = (u: string, b: unknown) => app.request(u, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) });
    const denied = async (r: Promise<Response>) => {
      const x = await r;
      assert.equal(x.status, 403);
      assert.equal(((await x.json()) as { error: string }).error, "read-only volume");
    };
    await denied(post("/api/fs/delete", { paths: ["/srv"] }));
    await denied(post("/api/fs/delete", { paths: ["/srv/other", "/srv"] }));
    await denied(post("/api/fs/trash", { paths: ["/srv"] }));
    await denied(post("/api/fs/rename", { from: "/srv", to: "/srv2" }));
    await denied(post("/api/fs/rename", { from: "/srv/other", to: "/srv", overwrite: true }));
    await denied(post("/api/fs/move", { from: ["/srv"], toDir: "/" }));
    await denied(post("/api/fs/perms", { path: "/srv", mode: 0o700, recursive: true }));
    await denied(post("/api/fs/perms", { path: "/lnk", mode: 0o700, recursive: true }));
    assert.ok(fs.existsSync(path.join(tmp, "srv/backup/a.txt")));
    // not under, not above: allowed
    assert.equal((await post("/api/fs/perms", { path: "/srv", mode: 0o755 })).status, 200, "not recursive");
    assert.equal((await post("/api/fs/perms", { path: "/srv/other", mode: 0o755, recursive: true })).status, 202);
    assert.equal((await post("/api/fs/rename", { from: "/srv/other", to: "/srv/other2" })).status, 200);
    assert.equal((await post("/api/fs/delete", { paths: ["/lnk"] })).status, 200, "removing a link removes the link only");
    assert.ok(fs.existsSync(path.join(tmp, "srv/backup/a.txt")));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("trash restore checks the computed destination and the item it would replace", async () => {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "filedeck-rorestore-")));
  try {
    const env = { FILEDECK_ROOT: tmp, FILEDECK_NODE: "t", FILEDECK_PROC_MOUNTS: path.join(tmp, "no-mount-table") };
    const free = createAgent(loadConfig(env as never));
    const ro = createAgent(loadConfig({ ...env, FILEDECK_READONLY: "/srv/backup" } as never));
    const post = (a: typeof free, u: string, b: unknown) => a.request(u, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) });
    fs.mkdirSync(path.join(tmp, "srv/backup"), { recursive: true });
    fs.mkdirSync(path.join(tmp, "rw"));
    fs.writeFileSync(path.join(tmp, "srv/backup/a.txt"), "x");
    fs.writeFileSync(path.join(tmp, "srv/b.txt"), "y");
    // trashed while the volume was still writable: the stored original paths are inside / above the read-only prefix
    assert.equal((await post(free, "/api/fs/trash", { paths: ["/srv/backup/a.txt"] })).status, 200);
    assert.equal((await post(free, "/api/fs/trash", { paths: ["/srv/b.txt"] })).status, 200);
    const list = async () => ((await (await free.request("/api/trash/list")).json()) as { volumes: { volume: string; items: { id: string; name: string }[] }[] }).volumes[0]!;
    const vol = await list();
    const id = (n: string) => vol.items.find((i) => i.name === n)!.id;
    const restore = async (a: typeof free, b: object) => ((await (await post(a, "/api/trash/restore", { volume: vol.volume, ...b })).json()) as { results: { ok: boolean; error?: string }[] }).results[0]!;
    // to the original place inside the read-only prefix
    let r = await restore(ro, { ids: [id("a.txt")] });
    assert.deepEqual([r.ok, r.error], [false, "read-only volume"]);
    // to a chosen folder inside it (refused before the route runs)
    assert.equal((await post(ro, "/api/trash/restore", { volume: vol.volume, ids: [id("b.txt")], toDir: "/srv/backup" })).status, 403);
    assert.ok(!fs.existsSync(path.join(tmp, "srv/backup/a.txt")) && !fs.existsSync(path.join(tmp, "srv/backup/b.txt")));
    // replacing the folder that holds the read-only prefix would trash it
    fs.writeFileSync(path.join(tmp, "rw/srv"), "z");
    assert.equal((await post(free, "/api/fs/trash", { paths: ["/rw/srv"] })).status, 200);
    const z = (await list()).items.find((i) => i.name === "srv")!;
    fs.rmSync(path.join(tmp, "rw/srv"), { force: true });
    r = await restore(ro, { ids: [z.id], toDir: "/", conflict: "replace" });
    assert.deepEqual([r.ok, r.error], [false, "read-only volume"]);
    assert.ok(fs.existsSync(path.join(tmp, "srv")));
    // outside the prefix it still works
    r = await restore(ro, { ids: [id("b.txt")], toDir: "/rw" });
    assert.equal(r.ok, true);
    assert.ok(fs.existsSync(path.join(tmp, "rw/b.txt")));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
