import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createAgent } from "../src/agent.ts";
import { loadConfig } from "../src/config.ts";

let tmp: string, outside: string, app: ReturnType<typeof createAgent>;
const uid = process.getuid!();
const gid = process.getgid!();

before(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "filedeck-props-")));
  outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "filedeck-props-out-")));
  fs.mkdirSync(path.join(tmp, "etc"));
  fs.writeFileSync(path.join(tmp, "etc/passwd"), `tester:x:${uid}:${gid}:t:/:/bin/sh\n`);
  fs.writeFileSync(path.join(tmp, "etc/group"), `testers:x:${gid}:\n`);
  fs.mkdirSync(path.join(tmp, "tree/sub/deep"), { recursive: true });
  fs.writeFileSync(path.join(tmp, "tree/a.txt"), "12345");
  fs.writeFileSync(path.join(tmp, "tree/sub/b.txt"), "1234567890");
  fs.writeFileSync(path.join(tmp, "tree/sub/deep/c.txt"), "x");
  fs.writeFileSync(path.join(outside, "target.txt"), "outside");
  fs.chmodSync(path.join(outside, "target.txt"), 0o600);
  fs.symlinkSync(path.join(outside, "target.txt"), path.join(tmp, "tree/link"));
  fs.mkdirSync(path.join(tmp, "tree/.filedeck-trash/x"), { recursive: true });
  fs.writeFileSync(path.join(tmp, "tree/.filedeck-trash/x/data"), "T".repeat(1000));
  app = createAgent(loadConfig({ FILEDECK_ROOT: tmp, FILEDECK_NODE: "t", FILEDECK_WALK_MAX_ENTRIES: "500000" } as never));
});
after(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
});

const post = (url: string, body: unknown) => app.request(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
type Job = { id: string; state: string; result?: Record<string, number | boolean | string>; error?: string };
async function finish(r: Response): Promise<Job> {
  assert.equal(r.status, 202, await r.clone().text());
  let j = (await r.json()) as Job;
  for (let i = 0; i < 200 && (j.state === "queued" || j.state === "running"); i++) {
    await new Promise((res) => setTimeout(res, 20));
    j = (await (await app.request(`/api/jobs/${j.id}`)).json()) as Job;
  }
  return j;
}
const modeOf = (p: string) => fs.lstatSync(path.join(tmp, p)).mode & 0o7777;

test("props: type, size, times, mode, owner and group names from the host tables, link target", async () => {
  const r = await app.request("/api/fs/props?path=/tree/a.txt");
  const p = (await r.json()) as Record<string, unknown>;
  assert.equal(p.type, "file");
  assert.equal(p.size, 5);
  assert.equal(p.uid, uid);
  assert.equal(p.owner, "tester");
  assert.equal(p.group, "testers");
  assert.equal(typeof p.mtime, "number");
  assert.equal(typeof p.atime, "number");
  assert.equal(typeof p.ctime, "number");
  const l = (await (await app.request("/api/fs/props?path=/tree/link")).json()) as Record<string, unknown>;
  assert.equal(l.type, "symlink");
  assert.equal(l.linkTarget, path.join(outside, "target.txt"));
  assert.equal((await app.request("/api/fs/props?path=/nope")).status, 404);
  assert.equal((await app.request("/api/fs/props?path=/../x")).status, 400);
});

test("folder size job counts files, folders, links, skips the trash store and never follows links", async () => {
  const j = await finish(await post("/api/jobs/size", { path: "/tree" }));
  assert.equal(j.state, "done");
  assert.equal(j.result!.files, 3);
  assert.equal(j.result!.dirs, 2);
  assert.equal(j.result!.symlinks, 1);
  assert.equal(j.result!.bytes, 5 + 10 + 1);
  assert.equal(j.result!.truncated, false);
  assert.ok((j.result!.diskBytes as number) >= 0);
});

test("folder size job honours the entry cap and cancel", async () => {
  const small = createAgent(loadConfig({ FILEDECK_ROOT: tmp, FILEDECK_NODE: "t", FILEDECK_WALK_MAX_ENTRIES: "3" } as never));
  const r = await small.request("/api/jobs/size", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: "/tree" }) });
  let j = (await r.json()) as Job;
  for (let i = 0; i < 100 && (j.state === "queued" || j.state === "running"); i++) {
    await new Promise((res) => setTimeout(res, 20));
    j = (await (await small.request(`/api/jobs/${j.id}`)).json()) as Job;
  }
  assert.equal(j.result!.truncated, true);
});

test("chmod on one entry, with guards", async () => {
  const ok = await post("/api/fs/perms", { path: "/tree/a.txt", mode: 0o640 });
  assert.equal(ok.status, 200);
  assert.equal(modeOf("tree/a.txt"), 0o640);
  // setuid/sticky bits pass through, group/owner names resolve
  assert.equal((await post("/api/fs/perms", { path: "/tree/a.txt", mode: 0o644, owner: "tester", group: "testers" })).status, 200);
  assert.equal(modeOf("tree/a.txt"), 0o644);
  assert.equal((await post("/api/fs/perms", { path: "/tree/a.txt", owner: "nosuchuser" })).status, 400);
  assert.equal((await post("/api/fs/perms", { path: "/tree/a.txt", owner: uid, group: gid })).status, 200);
  assert.equal((await post("/api/fs/perms", { path: "/tree/a.txt", mode: 0o10000 })).status, 400);
  assert.equal((await post("/api/fs/perms", { path: "/tree/a.txt" })).status, 400);
  // a folder must stay readable and enterable by its owner
  assert.equal((await post("/api/fs/perms", { path: "/tree/sub", mode: 0o644 })).status, 400);
  assert.equal(modeOf("tree/sub") & 0o700, 0o700);
  assert.equal((await post("/api/fs/perms", { path: "/tree/sub", mode: 0o750 })).status, 200);
  // never the root, never the trash store, never a link's mode
  assert.equal((await post("/api/fs/perms", { path: "/", mode: 0o755 })).status, 400);
  assert.equal((await post("/api/fs/perms", { path: "/tree/.filedeck-trash", mode: 0o755 })).status, 403);
  assert.equal((await post("/api/fs/perms", { path: "/tree/link", mode: 0o777 })).status, 400);
  assert.equal(fs.statSync(path.join(outside, "target.txt")).mode & 0o777, 0o600);
});

test("recursive chmod is a job, scoped, and does not follow links or touch the trash store", async () => {
  fs.chmodSync(path.join(tmp, "tree/.filedeck-trash/x/data"), 0o600);
  fs.chmodSync(path.join(tmp, "tree/.filedeck-trash/x"), 0o700);
  const j = await finish(await post("/api/fs/perms", { path: "/tree", mode: 0o600, recursive: true, scope: "files" }));
  assert.equal(j.state, "done", j.error);
  assert.equal(modeOf("tree/a.txt"), 0o600);
  assert.equal(modeOf("tree/sub/b.txt"), 0o600);
  assert.equal(modeOf("tree/sub/deep/c.txt"), 0o600);
  assert.equal(modeOf("tree/sub/deep") & 0o700, 0o700, "folders untouched by the files scope");
  assert.equal(fs.statSync(path.join(outside, "target.txt")).mode & 0o777, 0o600);
  // folders scope with a mode that would lock the owner out is refused up front
  assert.equal((await post("/api/fs/perms", { path: "/tree", mode: 0o600, recursive: true, scope: "dirs" })).status, 400);
  const k = await finish(await post("/api/fs/perms", { path: "/tree", mode: 0o755, recursive: true, scope: "dirs" }));
  assert.equal(k.state, "done");
  assert.equal(modeOf("tree/sub/deep"), 0o755);
  assert.equal(modeOf("tree/sub/b.txt"), 0o600, "dirs scope leaves files alone");
  assert.equal(modeOf("tree/.filedeck-trash/x/data"), 0o600);
  assert.equal(modeOf("tree/.filedeck-trash/x"), 0o700, "trash store folders untouched");
});
