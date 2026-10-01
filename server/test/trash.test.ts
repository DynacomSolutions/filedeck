import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createAgent } from "../src/agent.ts";
import { loadConfig } from "../src/config.ts";

let tmp: string, app: ReturnType<typeof createAgent>;
before(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "filedeck-trash-")));
  app = createAgent(loadConfig({ FILEDECK_ROOT: tmp, FILEDECK_NODE: "t" } as never));
});
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const post = (url: string, body: unknown) => app.request(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
type Item = { id: string; name: string; originalPath: string; orphan?: boolean; deletedAt: number };
const list = async () => ((await (await app.request("/api/trash/list")).json()) as { volumes: { volume: string; items: Item[] }[] }).volumes;
const trashed = async (p: string) => {
  const r = (await (await post("/api/fs/trash", { paths: [p] })).json()) as { items: { id: string }[] };
  return r.items[0]!.id;
};
const results = async (r: Response) => ((await r.json()) as { results: { id: string; ok: boolean; path?: string; error?: string; conflict?: boolean }[] }).results;

test("trashed items are listed per volume with their original path", async () => {
  fs.mkdirSync(path.join(tmp, "d/sub"), { recursive: true });
  fs.writeFileSync(path.join(tmp, "d/a.txt"), "A");
  fs.writeFileSync(path.join(tmp, "d/sub/b.txt"), "B");
  await trashed("/d/a.txt");
  await trashed("/d/sub");
  const v = await list();
  assert.equal(v.length, 1);
  assert.equal(v[0]!.volume, "/");
  assert.deepEqual(v[0]!.items.map((i) => i.originalPath).sort(), ["/d/a.txt", "/d/sub"]);
});

test("restore puts the item back, recreating a missing parent", async () => {
  const item = (await list())[0]!.items.find((i) => i.originalPath === "/d/sub")!;
  fs.rmSync(path.join(tmp, "d"), { recursive: true });
  const r = await results(await post("/api/trash/restore", { volume: "/", ids: [item.id] }));
  assert.deepEqual(r.map((x) => [x.ok, x.path]), [[true, "/d/sub"]]);
  assert.equal(fs.readFileSync(path.join(tmp, "d/sub/b.txt"), "utf8"), "B");
  assert.ok(!(await list())[0]!.items.some((i) => i.id === item.id));
});

test("conflicts: refused by default, then keep both or replace (the replaced item goes to the trash)", async () => {
  const item = (await list())[0]!.items.find((i) => i.originalPath === "/d/a.txt")!;
  fs.writeFileSync(path.join(tmp, "d/a.txt"), "NEW");
  const [fail] = await results(await post("/api/trash/restore", { volume: "/", ids: [item.id] }));
  assert.equal(fail!.ok, false);
  assert.equal(fail!.conflict, true);
  assert.equal(fs.readFileSync(path.join(tmp, "d/a.txt"), "utf8"), "NEW");
  const [ren] = await results(await post("/api/trash/restore", { volume: "/", ids: [item.id], conflict: "rename" }));
  assert.equal(ren!.ok, true);
  assert.equal(ren!.path, "/d/a (copy).txt");
  assert.equal(fs.readFileSync(path.join(tmp, "d/a (copy).txt"), "utf8"), "A");
  // replace: something else now sits at the destination; it must end up in the trash, not vanish
  const again = await trashed("/d/a (copy).txt");
  fs.writeFileSync(path.join(tmp, "d/a (copy).txt"), "Z");
  const [rep] = await results(await post("/api/trash/restore", { volume: "/", ids: [again], conflict: "replace" }));
  assert.equal(rep!.ok, true);
  assert.equal(fs.readFileSync(path.join(tmp, "d/a (copy).txt"), "utf8"), "A");
  const kept = (await list())[0]!.items.find((i) => i.originalPath === "/d/a (copy).txt")!;
  assert.equal(fs.readFileSync(path.join(tmp, ".filedeck-trash", kept.id, "data"), "utf8"), "Z");
});

test("restore into another folder keeps the name", async () => {
  fs.mkdirSync(path.join(tmp, "other"));
  fs.writeFileSync(path.join(tmp, "d/m.txt"), "M");
  const id = await trashed("/d/m.txt");
  const [r] = await results(await post("/api/trash/restore", { volume: "/", ids: [id], toDir: "/other" }));
  assert.equal(r!.path, "/other/m.txt");
  assert.equal(fs.readFileSync(path.join(tmp, "other/m.txt"), "utf8"), "M");
});

test("permanent delete, empty and age filter", async () => {
  for (const n of ["x1", "x2", "x3"]) fs.writeFileSync(path.join(tmp, n), n);
  const ids = [await trashed("/x1"), await trashed("/x2"), await trashed("/x3")];
  const [d] = await results(await post("/api/trash/delete", { volume: "/", ids: [ids[0]] }));
  assert.equal(d!.ok, true);
  assert.ok(!fs.existsSync(path.join(tmp, ".filedeck-trash", ids[0]!)));
  const young = await (await post("/api/trash/empty", { volume: "/", olderThanDays: 1 })).json();
  assert.deepEqual(young, { removed: 0, failed: 0 });
  // age one item by rewriting its meta
  const mp = path.join(tmp, ".filedeck-trash", ids[1]!, "meta.json");
  const meta = JSON.parse(fs.readFileSync(mp, "utf8"));
  fs.writeFileSync(mp, JSON.stringify({ ...meta, deletedAt: Date.now() - 3 * 86400_000 }));
  assert.deepEqual(await (await post("/api/trash/empty", { volume: "/", olderThanDays: 1 })).json(), { removed: 1, failed: 0 });
  assert.ok(fs.existsSync(path.join(tmp, ".filedeck-trash", ids[2]!)));
  const all = (await (await post("/api/trash/empty", { volume: "/" })).json()) as { removed: number };
  assert.ok(all.removed >= 1);
  assert.deepEqual(fs.readdirSync(path.join(tmp, ".filedeck-trash")), []);
});

test("guards: bad ids, unknown volume, orphans", async () => {
  assert.equal((await post("/api/trash/delete", { volume: "/", ids: ["../../etc"] })).status, 400);
  assert.equal((await post("/api/trash/delete", { volume: "/", ids: [] })).status, 400);
  assert.equal((await post("/api/trash/empty", { volume: "/nope" })).status, 404);
  const id = "11111111-2222-3333-4444-555555555555";
  fs.mkdirSync(path.join(tmp, ".filedeck-trash", id));
  fs.writeFileSync(path.join(tmp, ".filedeck-trash", id, "data"), "x");
  const item = (await list())[0]!.items.find((i) => i.id === id)!;
  assert.equal(item.orphan, true);
  const [r] = await results(await post("/api/trash/restore", { volume: "/", ids: [id] }));
  assert.equal(r!.ok, false);
  assert.equal((await results(await post("/api/trash/delete", { volume: "/", ids: [id] })))[0]!.ok, true);
  // the trash directory is never reachable through the normal file API
  assert.equal((await post("/api/fs/delete", { paths: ["/.filedeck-trash"] })).status, 403);
});
