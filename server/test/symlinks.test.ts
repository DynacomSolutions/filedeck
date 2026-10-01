import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createAgent } from "../src/agent.ts";
import { loadConfig } from "../src/config.ts";
import { PathError, openChecked, pinDir, pinParent } from "../src/paths.ts";
import * as ops from "../src/fsops.ts";

let tmp: string, root: string, outside: string;
before(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "filedeck-ln-")));
  root = path.join(tmp, "root");
  outside = path.join(tmp, "outside");
  fs.mkdirSync(path.join(root, "d"), { recursive: true });
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(root, "d/f.txt"), "hello");
  fs.writeFileSync(path.join(outside, "secret"), "top secret");
});
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const app = () => createAgent(loadConfig({ FILEDECK_ROOT: root, FILEDECK_NODE: "t" } as never));
const post = (a: ReturnType<typeof app>, u: string, b: unknown) => a.request(u, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) });

test("create, list with target, retarget, broken link display", async () => {
  const a = app();
  const mk = await post(a, "/api/fs/symlink", { path: "/d/rel", target: "f.txt" });
  assert.equal(mk.status, 201);
  const e = (await mk.json()) as ops.Entry;
  assert.equal(e.type, "symlink");
  assert.equal(e.target, "f.txt");
  assert.equal(e.broken, undefined);
  assert.equal(e.linkDir, false);
  assert.equal(fs.readlinkSync(path.join(root, "d/rel")), "f.txt");
  assert.equal(await (await a.request("/api/fs/read?path=/d/rel")).text(), "hello");

  assert.equal((await post(a, "/api/fs/symlink", { path: "/d/rel", target: "x" })).status, 409, "no silent replace");
  assert.equal((await post(a, "/api/fs/symlink", { path: "/d/f.txt", target: "x", overwrite: true })).status, 409, "a file is never replaced");
  const edit = await post(a, "/api/fs/symlink", { path: "/d/rel", target: "gone.txt", overwrite: true });
  assert.equal(edit.status, 201);
  const ed = (await edit.json()) as ops.Entry;
  assert.equal(ed.target, "gone.txt");
  assert.equal(ed.broken, true);
  assert.deepEqual(fs.readdirSync(path.join(root, "d")).filter((n) => n.includes("filedeck")), [], "temp link removed");

  const ls = (await (await a.request("/api/fs/list?path=/d")).json()) as { entries: ops.Entry[] };
  const l = ls.entries.find((x) => x.name === "rel");
  assert.equal(l?.target, "gone.txt");
  assert.equal(l?.broken, true);
  fs.symlinkSync("/", path.join(root, "d/dirlink"));
  const l2 = ((await (await a.request("/api/fs/list?path=/d")).json()) as { entries: ops.Entry[] }).entries.find((x) => x.name === "dirlink");
  assert.equal(l2?.linkDir, true);
  assert.equal(l2?.target, "/");
});

test("bad input", async () => {
  const a = app();
  assert.equal((await post(a, "/api/fs/symlink", { path: "/d/z", target: "" })).status, 400);
  assert.equal((await post(a, "/api/fs/symlink", { path: "/d/z", target: "a\0b" })).status, 400);
  assert.equal((await post(a, "/api/fs/symlink", { path: "/../z", target: "a" })).status, 400);
  assert.equal((await post(a, "/api/fs/symlink", { path: "/", target: "a" })).status, 409);
  assert.equal((await post(a, "/api/fs/symlink", { path: "/d/.filedeck-trash/z", target: "a" })).status, 403);
});

test("a link created with an escaping target cannot be used to read outside", async () => {
  const a = app();
  await post(a, "/api/fs/symlink", { path: "/d/esc", target: path.join(outside, "secret") });
  await post(a, "/api/fs/symlink", { path: "/d/esc2", target: "../../outside/secret" });
  for (const p of ["/d/esc", "/d/esc2"]) assert.equal((await a.request(`/api/fs/read?path=${p}`)).status, 404, p);
});

test("pinned directory: a swap to an outside link after pinning does not redirect the operation", async () => {
  fs.mkdirSync(path.join(root, "victim"));
  const real = path.join(root, "victim");
  await pinDir(root, real, async (at) => {
    fs.renameSync(real, path.join(root, "victim-moved"));
    fs.symlinkSync(outside, real); // attacker swaps the folder for a link out of the root
    await fs.promises.writeFile(path.join(at, "dropped.txt"), "x");
  });
  assert.ok(fs.existsSync(path.join(root, "victim-moved/dropped.txt")), "landed in the original folder");
  assert.ok(!fs.existsSync(path.join(outside, "dropped.txt")), "nothing written outside");
  fs.rmSync(real);
});

test("pinning refuses a folder that already resolves outside the root", async () => {
  fs.symlinkSync(outside, path.join(root, "swapped"));
  await assert.rejects(() => pinDir(root, path.join(root, "swapped"), async () => 1), (e: unknown) => e instanceof PathError && e.status === 403);
  await assert.rejects(() => pinParent(root, path.join(root, "swapped/new"), async () => 1), PathError);
  await assert.rejects(() => openChecked(root, path.join(root, "swapped/secret")), PathError);
  await assert.rejects(() => ops.mkdir(root, "/swapped/x").catch((e) => { throw e; }), Error); // resolver clamps it into root, which has no such folder
  assert.ok(!fs.existsSync(path.join(outside, "x")));
});

test("file open refuses a final link swapped in after resolution", async () => {
  fs.writeFileSync(path.join(root, "late.txt"), "inside");
  fs.symlinkSync(path.join(outside, "secret"), path.join(root, "late-link"));
  await assert.rejects(() => openChecked(root, path.join(root, "late-link")), { code: "ELOOP" });
  const fh = await openChecked(root, path.join(root, "late.txt"));
  assert.equal((await fh.readFile()).toString(), "inside");
  await fh.close();
});
