import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createAgent } from "../src/agent.ts";
import { loadConfig } from "../src/config.ts";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { serve } from "@hono/node-server";
import type { AddressInfo } from "node:net";
import { createHub } from "../src/hub.ts";
import { hitsReadOnly, jobMayWrite, parseReadOnly, reachesReadOnly, readOnlyForms } from "../src/readonly.ts";

test("parseReadOnly keeps absolute prefixes only", () => {
  assert.deepEqual(parseReadOnly(" /mnt/a/, /,, /x"), ["/mnt/a", "/", "/x"]);
  assert.deepEqual(parseReadOnly(undefined), []);
  // doubled and dotted segments are cleaned, so the entry protects what it says
  assert.deepEqual(parseReadOnly("//srv/./backup/, /a/b/../c//"), ["/srv/backup", "/a/c"]);
  // an entry that cannot be made an absolute path inside the root stops the start with a message
  for (const bad of ["rel", "mnt/a", "/..", "/a/../../b", "/a\0b"]) assert.throws(() => parseReadOnly(bad), /FILEDECK_READONLY: ".*" is not an absolute path/, bad);
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
    const denied = async (r: Response | Promise<Response>) => {
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

test("a copy, move or extract that would merge into or replace a folder holding a read-only prefix is refused", async () => {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "filedeck-romerge-")));
  try {
    fs.mkdirSync(path.join(tmp, "srv/backup"), { recursive: true });
    fs.writeFileSync(path.join(tmp, "srv/backup/a.txt"), "protected");
    fs.mkdirSync(path.join(tmp, "rw/srv/backup"), { recursive: true });
    fs.writeFileSync(path.join(tmp, "rw/srv/backup/a.txt"), "other");
    fs.writeFileSync(path.join(tmp, "rw/srv/new.txt"), "n");
    execFileSync("tar", ["-cf", path.join(tmp, "rw/srv.tar"), "-C", path.join(tmp, "rw"), "srv"]);
    const app = createAgent(loadConfig({ FILEDECK_ROOT: tmp, FILEDECK_NODE: "t", FILEDECK_READONLY: "/srv/backup" } as never));
    const post = (u: string, b: unknown) => app.request(u, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) });
    const kept = () => fs.readFileSync(path.join(tmp, "srv/backup/a.txt"), "utf8") === "protected" && !fs.existsSync(path.join(tmp, "srv/new.txt"));
    const denied = async (r: Response | Promise<Response>) => {
      assert.equal((await r).status, 403);
      assert.ok(kept());
    };
    await denied(post("/api/fs/copy", { from: ["/rw/srv"], toDir: "/", overwrite: true }));
    await denied(post("/api/fs/move", { from: ["/rw/srv"], toDir: "/" }));
    await denied(post("/api/jobs/extract", { path: "/rw/srv.tar", destDir: "/", overwrite: "overwrite" })); // lands in /srv
    await denied(post("/api/jobs/extract", { path: "/rw/srv.tar", destDir: "/srv", subfolder: false, overwrite: "overwrite" }));
    await denied(post("/api/jobs/extract", { path: "/rw/srv.tar", destDir: "/srv", subfolder: false, overwrite: "skip" }));
    // keep-both only ever picks a free name: allowed, and the protected folder is untouched
    assert.equal((await post("/api/fs/copy", { from: ["/rw/srv"], toDir: "/" })).status, 200);
    const ex = await post("/api/jobs/extract", { path: "/rw/srv.tar", destDir: "/srv", subfolder: false, overwrite: "rename" });
    assert.equal(ex.status, 202);
    for (let i = 0; i < 100; i++) {
      const j = (await (await app.request(`/api/jobs/${((await ex.clone().json()) as { id: string }).id}`)).json()) as { state: string };
      if (j.state !== "running" && j.state !== "queued") break;
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.equal(fs.readFileSync(path.join(tmp, "srv/backup/a.txt"), "utf8"), "protected");
    // an overwrite that does not reach the prefix still works
    fs.mkdirSync(path.join(tmp, "rw/dst"));
    assert.equal((await post("/api/fs/copy", { from: ["/rw/srv"], toDir: "/rw/dst", overwrite: true })).status, 200);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("the hub's job queue cannot merge or replace into a folder holding a read-only prefix", async () => {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "filedeck-rohub-")));
  const open = (app: { fetch: never }) =>
    new Promise<ReturnType<typeof serve>>((res) => {
      const s: ReturnType<typeof serve> = serve({ fetch: app.fetch, port: 0 }, () => res(s));
    });
  const servers: ReturnType<typeof serve>[] = [];
  try {
    fs.mkdirSync(path.join(tmp, "srv/backup"), { recursive: true });
    fs.writeFileSync(path.join(tmp, "srv/backup/a.txt"), "protected");
    fs.mkdirSync(path.join(tmp, "rw/srv/backup"), { recursive: true });
    fs.writeFileSync(path.join(tmp, "rw/srv/backup/a.txt"), "other");
    fs.writeFileSync(path.join(tmp, "rw/srv/new.txt"), "n");
    const agent = await open(createAgent(loadConfig({ FILEDECK_ROOT: tmp, FILEDECK_NODE: "t", FILEDECK_READONLY: "/srv/backup" } as never)) as never);
    servers.push(agent);
    const hubSrv = await open(createHub(loadConfig({ FILEDECK_MODE: "hub", NODES: `t=http://127.0.0.1:${(agent.address() as AddressInfo).port}`, FILEDECK_STATIC: tmp } as never)) as never);
    servers.push(hubSrv);
    const hub = `http://127.0.0.1:${(hubSrv.address() as AddressInfo).port}`;
    for (const op of ["copy", "move"]) {
      const r = await fetch(`${hub}/api/ops/jobs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ op, items: [{ node: "t", path: "/rw/srv" }], dst: { node: "t", dir: "/" }, conflict: "overwrite" }),
      });
      assert.equal(r.status, 202);
      const id = ((await r.json()) as { id: string }).id;
      let state = "";
      for (let i = 0; i < 200 && !["done", "failed", "canceled"].includes(state); i++) {
        await new Promise((res) => setTimeout(res, 50));
        state = ((await (await fetch(`${hub}/api/ops/jobs/${id}`)).json()) as { state: string }).state;
      }
      assert.equal(state, "failed", op); // files beside the prefix may be written, the prefix itself is refused
      assert.equal(fs.readFileSync(path.join(tmp, "srv/backup/a.txt"), "utf8"), "protected", op);
      assert.ok(fs.existsSync(path.join(tmp, "rw/srv/new.txt")), "the source is kept");
    }
  } finally {
    for (const s of servers) s.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("extract is judged on the resolved destination and the real archive name", async () => {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "filedeck-roextract-")));
  try {
    fs.mkdirSync(path.join(tmp, "srv/backup"), { recursive: true });
    fs.writeFileSync(path.join(tmp, "srv/backup/a.txt"), "protected");
    fs.mkdirSync(path.join(tmp, "rw/src/backup"), { recursive: true });
    fs.writeFileSync(path.join(tmp, "rw/src/backup/a.txt"), "EVIL");
    execFileSync("tar", ["-cf", path.join(tmp, "rw/srv.tar"), "-C", path.join(tmp, "rw/src"), "backup"]);
    fs.symlinkSync("/srv", path.join(tmp, "rw/lnk")); // a link to the ancestor of the prefix
    fs.symlinkSync("/rw/srv.tar", path.join(tmp, "rw/harmless.tar")); // a link to an archive whose own name is "srv"
    const app = createAgent(loadConfig({ FILEDECK_ROOT: tmp, FILEDECK_NODE: "t", FILEDECK_READONLY: "/srv/backup" } as never));
    const post = (u: string, b: unknown) => app.request(u, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) });
    const kept = () => fs.readFileSync(path.join(tmp, "srv/backup/a.txt"), "utf8") === "protected";
    for (const overwrite of ["overwrite", "skip"]) {
      assert.equal((await post("/api/jobs/extract", { path: "/rw/srv.tar", destDir: "/rw/lnk", subfolder: false, overwrite })).status, 403, `link to the ancestor, ${overwrite}`);
    }
    assert.equal((await post("/api/jobs/extract", { path: "/rw/harmless.tar", destDir: "/", overwrite: "overwrite" })).status, 403, "the subfolder is named after the real archive");
    assert.equal((await post("/api/jobs/extract", { path: "/rw/harmless.tar", destDir: "/rw/lnk/../", overwrite: "overwrite" })).status < 500, true);
    assert.ok(kept());
    // keep-both and a destination away from the prefix are not affected
    assert.equal((await post("/api/jobs/extract", { path: "/rw/srv.tar", destDir: "/rw/lnk", subfolder: false, overwrite: "rename" })).status, 202);
    fs.mkdirSync(path.join(tmp, "rw/out"));
    assert.equal((await post("/api/jobs/extract", { path: "/rw/harmless.tar", destDir: "/rw/out", overwrite: "overwrite" })).status, 202);
    await new Promise((r) => setTimeout(r, 300));
    assert.ok(kept());
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("a prefix that is itself a link protects the place it leads to, and a file prefix cannot be replaced by an upload", async () => {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "filedeck-rolink-")));
  try {
    fs.mkdirSync(path.join(tmp, "mnt/disk"), { recursive: true });
    fs.writeFileSync(path.join(tmp, "mnt/disk/a.txt"), "protected");
    fs.symlinkSync("/mnt/disk", path.join(tmp, "ro"));
    fs.mkdirSync(path.join(tmp, "srv"));
    fs.writeFileSync(path.join(tmp, "srv/conf.yaml"), "protected");
    const app = createAgent(loadConfig({ FILEDECK_ROOT: tmp, FILEDECK_NODE: "t", FILEDECK_READONLY: "/ro,/srv/conf.yaml" } as never));
    const post = (u: string, b: unknown) => app.request(u, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) });
    assert.equal((await post("/api/fs/mkdir", { path: "/ro/newdir" })).status, 403);
    assert.equal((await post("/api/fs/delete", { paths: ["/ro/a.txt"] })).status, 403);
    assert.equal((await post("/api/fs/delete", { paths: ["/mnt/disk/a.txt"] })).status, 403, "by its real name too");
    assert.equal((await post("/api/fs/mkdir", { path: "/mnt/disk/newdir" })).status, 403);
    assert.ok(fs.existsSync(path.join(tmp, "mnt/disk/a.txt")) && !fs.existsSync(path.join(tmp, "mnt/disk/newdir")));
    // retargeting the link is followed at the next request
    fs.mkdirSync(path.join(tmp, "mnt/other"));
    fs.rmSync(path.join(tmp, "ro"));
    fs.symlinkSync("/mnt/other", path.join(tmp, "ro"));
    assert.equal((await post("/api/fs/mkdir", { path: "/mnt/other/x" })).status, 403);
    assert.equal((await post("/api/fs/mkdir", { path: "/mnt/disk/free" })).status, 201);
    // a file prefix: replacing it through its folder
    const put = (u: string, headers: Record<string, string> = {}) => app.request(u, { method: "PUT", headers, body: "EVIL" });
    assert.equal((await put("/api/fs/upload?dir=/srv&name=conf.yaml&overwrite=1", { "content-type": "application/octet-stream" })).status, 403);
    assert.equal((await app.request("/api/upload/chunk?dir=/srv&name=conf.yaml&id=0123456789abcdef&offset=0&total=4&overwrite=1", { method: "PATCH", body: "EVIL" })).status, 403);
    assert.equal((await put("/api/fs/write?path=/srv/conf.yaml", { "if-match": "x" })).status, 403);
    assert.equal(fs.readFileSync(path.join(tmp, "srv/conf.yaml"), "utf8"), "protected");
    assert.equal((await put("/api/fs/upload?dir=/srv&name=other.yaml")).status, 201, "other names in the folder are free");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("on a case-insensitive filesystem a prefix is matched without regard to case", () => {
  const forms = [{ p: "/mnt/Vfat/Ro", fold: true }, { p: "/mnt/ext/ro", fold: false }];
  assert.equal(hitsReadOnly("/nonexistent-root", [], "/MNT/vfat/RO/a.txt", forms), true);
  assert.equal(hitsReadOnly("/nonexistent-root", [], "/mnt/vfat/ro", forms), true);
  assert.equal(hitsReadOnly("/nonexistent-root", [], "/mnt/EXT/RO/a.txt", forms), false, "a case-sensitive place stays exact");
  assert.equal(reachesReadOnly("/nonexistent-root", [], "/MNT/VFAT", false, forms), true, "an ancestor, in any case");
  // the probe is real: a folder on this (case-sensitive) filesystem is not folded
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "filedeck-rocase-")));
  try {
    fs.mkdirSync(path.join(tmp, "Ro"));
    const f = readOnlyForms(tmp, ["/Ro"]);
    assert.deepEqual(f, [{ p: "/Ro", fold: false }]);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

function agentFor(tmp: string, extra: Record<string, string>) {
  return createAgent(loadConfig({ FILEDECK_ROOT: tmp, FILEDECK_NODE: "t", FILEDECK_PROC_MOUNTS: path.join(tmp, "no-mount-table"), ...extra } as never));
}
type App = ReturnType<typeof createAgent>;
const postTo = (app: App, u: string, b: unknown) => app.request(u, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) });
async function jobEnd(app: App, id: string): Promise<{ state: string; error?: string }> {
  for (let i = 0; i < 400; i++) {
    const j = (await (await app.request(`/api/jobs/${id}`)).json()) as { state: string; error?: string };
    if (j.state !== "running" && j.state !== "queued") return j;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("job did not end");
}

test("a link, folder or file on the way to a prefix cannot be replaced or removed, in the written or the resolved form", async () => {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "filedeck-rocomp-")));
  try {
    fs.mkdirSync(path.join(tmp, "mnt/data/ro"), { recursive: true });
    fs.writeFileSync(path.join(tmp, "mnt/data/ro/a.txt"), "protected");
    fs.mkdirSync(path.join(tmp, "other/ro"), { recursive: true });
    fs.mkdirSync(path.join(tmp, "rw/data"), { recursive: true });
    fs.symlinkSync("/mnt/data", path.join(tmp, "data"));
    const app = agentFor(tmp, { FILEDECK_READONLY: "/data/ro" });
    const kept = () => fs.readFileSync(path.join(tmp, "mnt/data/ro/a.txt"), "utf8") === "protected" && fs.readlinkSync(path.join(tmp, "data")) === "/mnt/data";
    // the middle link retargeted by a symlink that overwrites it
    assert.equal((await postTo(app, "/api/fs/symlink", { path: "/data", target: "/other", overwrite: true })).status, 403);
    assert.equal((await postTo(app, "/api/fs/symlink", { path: "/mnt/data", target: "/other", overwrite: true })).status, 403, "resolved form");
    // rename or move something onto it, or it away
    assert.equal((await postTo(app, "/api/fs/rename", { from: "/rw/data", to: "/data", overwrite: true })).status, 403);
    assert.equal((await postTo(app, "/api/fs/rename", { from: "/data", to: "/data2" })).status, 403);
    assert.equal((await postTo(app, "/api/fs/move", { from: ["/rw/data"], toDir: "/" })).status, 403);
    assert.equal((await postTo(app, "/api/fs/copy", { from: ["/rw/data"], toDir: "/", overwrite: true })).status, 403);
    assert.equal((await postTo(app, "/api/fs/delete", { paths: ["/data"] })).status, 403);
    assert.equal((await postTo(app, "/api/fs/trash", { paths: ["/mnt/data"] })).status, 403);
    // a link that is not on the way is free to change
    assert.equal((await postTo(app, "/api/fs/symlink", { path: "/free", target: "/other" })).status, 201);
    assert.equal((await postTo(app, "/api/fs/symlink", { path: "/free", target: "/mnt", overwrite: true })).status, 201);
    assert.ok(kept());
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("a prefix link made after the start, and a restore into the resolved form, are refused", async () => {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "filedeck-rolate-")));
  try {
    fs.mkdirSync(path.join(tmp, "mnt/disk"), { recursive: true });
    fs.writeFileSync(path.join(tmp, "mnt/disk/a.txt"), "orig");
    const free = agentFor(tmp, {});
    await postTo(free, "/api/fs/trash", { paths: ["/mnt/disk/a.txt"] }); // trashed from the resolved form while nothing was protected
    const app = agentFor(tmp, { FILEDECK_READONLY: "/ro" });
    fs.symlinkSync("/mnt/disk", path.join(tmp, "ro")); // made by the operator after the agent started
    fs.writeFileSync(path.join(tmp, "mnt/disk/b.txt"), "protected");
    assert.equal((await postTo(app, "/api/fs/delete", { paths: ["/mnt/disk/b.txt"] })).status, 403, "protected from the moment the link exists");
    const vol = ((await (await free.request("/api/trash/list")).json()) as { volumes: { volume: string; items: { id: string }[] }[] }).volumes[0]!;
    const r = (await (await postTo(app, "/api/trash/restore", { volume: vol.volume, ids: [vol.items[0]!.id] })).json()) as { results: { ok: boolean; error?: string }[] };
    assert.deepEqual([r.results[0]!.ok, r.results[0]!.error], [false, "read-only volume"]);
    assert.ok(!fs.existsSync(path.join(tmp, "mnt/disk/a.txt")));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("a file prefix cannot be replaced through a link to its folder", async () => {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "filedeck-rofile-")));
  try {
    fs.mkdirSync(path.join(tmp, "srv"));
    fs.mkdirSync(path.join(tmp, "rw"));
    fs.writeFileSync(path.join(tmp, "srv/conf.yaml"), "protected");
    fs.writeFileSync(path.join(tmp, "rw/conf.yaml"), "EVIL");
    fs.symlinkSync("/srv", path.join(tmp, "rw/lnk"));
    const app = agentFor(tmp, { FILEDECK_READONLY: "/srv/conf.yaml" });
    const codes = [
      (await app.request("/api/fs/upload?dir=/srv/&name=conf.yaml&overwrite=1", { method: "PUT", body: "EVIL" })).status,
      (await app.request("/api/fs/upload?dir=/rw/lnk&name=conf.yaml&overwrite=1", { method: "PUT", body: "EVIL" })).status,
      (await app.request("/api/upload/chunk?dir=/srv&name=conf.yaml&id=0123456789abcdef&offset=0&total=4&overwrite=1", { method: "PATCH", body: "EVIL" })).status,
      (await app.request("/api/fs/write?path=/rw/lnk/conf.yaml", { method: "PUT", body: "EVIL", headers: { "if-match": "x" } })).status,
      (await postTo(app, "/api/fs/copy", { from: ["/rw/conf.yaml"], toDir: "/rw/lnk", overwrite: true })).status,
      (await postTo(app, "/api/fs/rename", { from: "/rw/conf.yaml", to: "/rw/lnk/conf.yaml", overwrite: true })).status,
    ];
    assert.deepEqual(codes, [403, 403, 403, 403, 403, 403]);
    assert.equal(fs.readFileSync(path.join(tmp, "srv/conf.yaml"), "utf8"), "protected");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

/** A job slot held by a long compression (seconds, against the milliseconds the test needs), so that the jobs queued behind it start only when it is cancelled. */
async function holdSlot(app: App, tmp: string) {
  fs.mkdirSync(path.join(tmp, "rw/big"), { recursive: true });
  // Incompressible data: gzip at level 9 needs seconds for it, where a sparse file of zeros is archived in milliseconds.
  fs.writeFileSync(path.join(tmp, "rw/big/noise"), crypto.randomBytes(192 * 1024 * 1024));
  const blocker = (await (await postTo(app, "/api/jobs/compress", { dir: "/rw/big", names: ["noise"], format: "tar.gz", level: 9 })).json()) as { id: string };
  for (let i = 0; i < 200; i++) {
    const j = (await (await app.request(`/api/jobs/${blocker.id}`)).json()) as { state: string };
    if (j.state === "running") break; // the slot is taken only once the blocker really runs
    await new Promise((r) => setTimeout(r, 10));
  }
  const state = async (id: string) => ((await (await app.request(`/api/jobs/${id}`)).json()) as { state: string; error?: string });
  return {
    /** the job behind it must still be waiting, and the blocker still running, when the folder is swapped */
    held: async (id: string) => {
      const [b, q] = [await state(blocker.id), await state(id)];
      assert.deepEqual([b.state, q.state], ["running", "queued"], JSON.stringify({ b, q }));
      return `${b.state}/${q.state}`;
    },
    release: () => postTo(app, `/api/jobs/${blocker.id}/cancel`, {}),
  };
}

test("a queued extract is checked again where its destination really is when it starts", async () => {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "filedeck-roqueue-")));
  try {
    fs.mkdirSync(path.join(tmp, "srv/backup"), { recursive: true });
    fs.writeFileSync(path.join(tmp, "srv/backup/a.txt"), "protected");
    fs.mkdirSync(path.join(tmp, "rw/src/backup"), { recursive: true });
    fs.writeFileSync(path.join(tmp, "rw/src/backup/a.txt"), "EVIL");
    fs.mkdirSync(path.join(tmp, "rw/x"));
    execFileSync("tar", ["-cf", path.join(tmp, "rw/x.tar"), "-C", path.join(tmp, "rw/src"), "backup"]);
    const app = agentFor(tmp, { FILEDECK_READONLY: "/srv/backup", FILEDECK_JOB_CONCURRENCY: "1" });
    const slot = await holdSlot(app, tmp);
    const queued = await postTo(app, "/api/jobs/extract", { path: "/rw/x.tar", destDir: "/rw/x", subfolder: false, overwrite: "overwrite" });
    assert.equal(queued.status, 202);
    const qj = (await queued.json()) as { id: string; state: string };
    assert.equal(qj.state, "queued", "the job waits behind the blocker");
    const id = qj.id;
    // swap the destination for a link to the parent of the protected folder
    assert.equal((await postTo(app, "/api/fs/rename", { from: "/rw/x", to: "/rw/x-old" })).status, 200);
    assert.equal((await postTo(app, "/api/fs/symlink", { path: "/rw/x", target: "../srv" })).status, 201);
    const held = await slot.held(id);
    await slot.release();
    const end = await jobEnd(app, id);
    assert.equal(end.state, "failed", JSON.stringify(end));
    assert.match(end.error ?? "", /read-only/, held + JSON.stringify(end));
    assert.equal(fs.readFileSync(path.join(tmp, "srv/backup/a.txt"), "utf8"), "protected");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("a queued recursive permissions change is checked again where its target really is when it starts", async () => {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "filedeck-roqperms-")));
  try {
    fs.mkdirSync(path.join(tmp, "srv/backup"), { recursive: true });
    fs.writeFileSync(path.join(tmp, "srv/backup/a.txt"), "protected");
    fs.chmodSync(path.join(tmp, "srv/backup/a.txt"), 0o644);
    fs.mkdirSync(path.join(tmp, "rw/x"), { recursive: true });
    const app = agentFor(tmp, { FILEDECK_READONLY: "/srv/backup", FILEDECK_JOB_CONCURRENCY: "1" });
    const slot = await holdSlot(app, tmp);
    const queued = await postTo(app, "/api/fs/perms", { path: "/rw/x", mode: 0o700, recursive: true });
    assert.equal(queued.status, 202);
    const qj = (await queued.json()) as { id: string; state: string };
    assert.equal(qj.state, "queued", "the job waits behind the blocker");
    const id = qj.id;
    assert.equal((await postTo(app, "/api/fs/rename", { from: "/rw/x", to: "/rw/x-old" })).status, 200);
    assert.equal((await postTo(app, "/api/fs/symlink", { path: "/rw/x", target: "../srv" })).status, 201);
    const held = await slot.held(id);
    await slot.release();
    const end = await jobEnd(app, id);
    assert.equal(end.state, "failed", JSON.stringify(end));
    assert.match(end.error ?? "", /read-only/, held + JSON.stringify(end));
    assert.equal(fs.statSync(path.join(tmp, "srv/backup/a.txt")).mode & 0o777, 0o644);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("jobMayWrite resolves the location at the moment it is asked", () => {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "filedeck-rojmw-")));
  try {
    fs.mkdirSync(path.join(tmp, "srv/backup"), { recursive: true });
    fs.mkdirSync(path.join(tmp, "rw/x"), { recursive: true });
    const ro = ["/srv/backup"];
    assert.equal(jobMayWrite(tmp, ro, path.join(tmp, "rw/x"), { contains: true }), true);
    fs.rmSync(path.join(tmp, "rw/x"), { recursive: true });
    fs.symlinkSync(path.join(tmp, "srv"), path.join(tmp, "rw/x"));
    assert.equal(jobMayWrite(tmp, ro, path.join(tmp, "rw/x"), { contains: true }), false, "it holds the prefix");
    assert.equal(jobMayWrite(tmp, ro, path.join(tmp, "rw/x"), { contains: false }), true, "adding a file beside the prefix is not a change to it");
    assert.equal(jobMayWrite(tmp, ro, path.join(tmp, "rw/x/backup"), { contains: false }), false, "it is the prefix");
    assert.equal(jobMayWrite(tmp, ro, path.join(tmp, "rw/x"), { contains: true, follow: false }), true, "the link itself, not followed");
    assert.equal(jobMayWrite(tmp, ro, path.join(tmp, "gone"), { contains: true }), true, "missing: the job fails by itself");
    assert.equal(jobMayWrite(tmp, [], path.join(tmp, "rw/x"), { contains: true }), true);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
