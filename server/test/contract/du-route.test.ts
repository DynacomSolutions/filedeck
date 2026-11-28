import { before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { agentUnderTest, contractTest, dropFixtureRoot, fixtureRoot } from "./agent-under-test.ts";

// The du route and the folder size store, at HTTP level: the route cases of test/size-store.test.ts, size-store-depth.test.ts and
// size-store-stream.test.ts that need no change watcher. Where the TS tests call SizeStore, they ask the route.
let tmp: string;
before(() => {
  tmp = fixtureRoot("filedeck-du-route-");
  fs.mkdirSync(path.join(tmp, "a/sub/deep"), { recursive: true });
  fs.writeFileSync(path.join(tmp, "a/f.txt"), "12345");
  fs.writeFileSync(path.join(tmp, "a/sub/g.txt"), "1234567890");
  fs.writeFileSync(path.join(tmp, "a/sub/deep/h.txt"), "x");
  fs.symlinkSync("/etc/passwd", path.join(tmp, "a/link"));
  fs.mkdirSync(path.join(tmp, "a/.filedeck-trash"));
  fs.writeFileSync(path.join(tmp, "a/.filedeck-trash/t"), "T".repeat(1000));
});
after(() => dropFixtureRoot(tmp));

type Entry = { path: string; type: string; bytes: number; diskBytes: number; files: number; dirs: number; scannedAt?: number; partial?: boolean };
type Du = { path: string; entries: Entry[]; cached: boolean; truncated: boolean; watched: boolean; stale?: boolean; partial?: boolean; ageMs?: number; refreshJobId?: string; error?: string };
const idxDir = () => fs.mkdtempSync(path.join(path.dirname(tmp), "filedeck-du-idx-"));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

contractTest("GET /api/du: shape, depth, files with all=1, cached flag, validation, and the store outlives the agent", async () => {
  const idx = idxDir();
  const env = { FILEDECK_INDEX_DIR: idx, FILEDECK_DU_WAIT_MS: "60000" };
  const app = await agentUnderTest({ root: tmp, env });
  try {
    const get = (q: string) => app.request("/api/du?" + q);
    const du = async (q: string) => (await (await get(q)).json()) as Du;
    const first = await du("path=/a&depth=1");
    assert.equal(first.cached, false);
    assert.equal(first.truncated, false);
    assert.equal(first.watched, false);
    assert.equal(first.path, "/a");
    assert.deepEqual(first.entries.map((e) => e.path), ["/a", "/a/sub"]);
    const top = first.entries[0]!;
    assert.deepEqual({ type: top.type, bytes: top.bytes, files: top.files, dirs: top.dirs }, { type: "dir", bytes: 16, files: 3, dirs: 2 });
    assert.equal(typeof top.scannedAt, "number");

    const again = await du("path=/a&depth=1");
    assert.equal(again.cached, true, "an unchanged tree is answered from the store");
    assert.equal(again.entries[0]!.scannedAt, top.scannedAt);
    assert.equal((await du("path=/a&depth=1&fresh=1")).cached, false, "fresh reads again");
    assert.equal((await du("path=/a&depth=0")).entries.length, 1);
    assert.equal((await du("path=/a&depth=5")).entries.length, 3);

    const all = await du("path=/a&depth=1&all=1");
    assert.deepEqual(all.entries.map((e) => `${e.type}:${e.path}`).sort(), ["dir:/a", "dir:/a/sub", "file:/a/f.txt", "symlink:/a/link"]);
    const file = all.entries.find((e) => e.path === "/a/f.txt")!;
    assert.deepEqual({ bytes: file.bytes, files: file.files, dirs: file.dirs }, { bytes: 5, files: 1, dirs: 0 });
    const link = all.entries.find((e) => e.path === "/a/link")!;
    assert.deepEqual({ bytes: link.bytes, files: link.files }, { bytes: 0, files: 0 }, "a link is listed, never followed");

    assert.equal((await get("path=/a&depth=-1")).status, 400);
    assert.equal((await get("path=/a&depth=65")).status, 400);
    assert.equal((await get("path=/a&depth=x")).status, 400);
    assert.equal((await get("path=/a&depth=1.5")).status, 400);
    for (const k of ["all", "fresh", "cachedOnly"]) assert.equal((await get(`path=/a&${k}=2`)).status, 400, k);
    assert.equal((await get("path=/../x")).status, 400);
    assert.equal((await get("path=/nope")).status, 404);
    assert.equal((await get("path=/a/f.txt")).status, 400, "a file is not a folder");
    assert.equal((await get("path=/a/.filedeck-trash")).status, 403, "the trash store is not readable");
    const bad = (await (await get("path=/a/f.txt")).json()) as { error: string };
    assert.equal(bad.error, "not a directory");

    // the store survives the agent: a new agent on the same state folder serves it as cached
    await app.close();
    const app2 = await agentUnderTest({ root: tmp, env });
    try {
      const c = (await (await app2.request("/api/du?path=/a&depth=1")).json()) as Du;
      assert.equal(c.cached, true);
      assert.equal(c.entries[0]!.bytes, 16);
    } finally {
      await app2.close();
    }
  } finally {
    await app.close();
    fs.rmSync(idx, { recursive: true, force: true });
  }
});

contractTest("GET /api/du?cachedOnly=1 answers from the store, says stale and never scans", async () => {
  fs.mkdirSync(path.join(tmp, "co/sub"), { recursive: true });
  fs.writeFileSync(path.join(tmp, "co/sub/f"), "abc");
  const idx = idxDir();
  const app = await agentUnderTest({ root: tmp, env: { FILEDECK_INDEX_DIR: idx, FILEDECK_DU_WAIT_MS: "60000" } });
  try {
    const get = (q: string) => app.request("/api/du?cachedOnly=1&" + q);
    assert.equal((await get("path=/co&depth=1")).status, 204, "unknown: nothing is scanned");
    assert.equal((await get("path=/co&depth=1")).status, 204, "still unknown, so the first call stored nothing");
    assert.equal(((await (await app.request("/api/jobs")).json()) as { jobs: unknown[] }).jobs.length, 0, "no job was started");
    await app.request("/api/du?path=/co&depth=1");
    const r = await get("path=/co&depth=1");
    assert.equal(r.status, 200);
    const j = (await r.json()) as Du;
    assert.deepEqual(j.entries.map((e) => e.path), ["/co", "/co/sub"]);
    assert.equal(j.entries[1]!.bytes, 3);
    assert.equal(j.cached, true);
    assert.equal(j.stale, true, "stored, but nothing vouches that it is current");
    assert.equal(typeof j.ageMs, "number");
    assert.equal((await app.request("/api/du?path=/co&cachedOnly=2")).status, 400);
  } finally {
    await app.close();
    fs.rmSync(idx, { recursive: true, force: true });
  }
});

contractTest("changes are seen: an added file, a removed folder and an expired row; a hard link counts once per link", async () => {
  const root = path.join(tmp, "chg");
  fs.mkdirSync(path.join(root, "one"), { recursive: true });
  fs.mkdirSync(path.join(root, "two"), { recursive: true });
  fs.writeFileSync(path.join(root, "one/f"), "123");
  fs.writeFileSync(path.join(root, "two/f"), "4567");
  fs.linkSync(path.join(root, "one/f"), path.join(root, "two/hard"));
  const app = await agentUnderTest({ root: tmp, env: { FILEDECK_DU_WAIT_MS: "60000" } });
  try {
    const top = async (q = "") => (await (await app.request(`/api/du?path=/chg&depth=0${q}`)).json()) as Du;
    const a = (await top()).entries[0]!;
    assert.deepEqual({ files: a.files, dirs: a.dirs, bytes: a.bytes }, { files: 3, dirs: 2, bytes: 3 + 4 + 3 }, "the hard link counts once per link, unlike du");
    // a new file changes the folder's mtime: the next du sees it without `fresh`
    await sleep(20);
    fs.writeFileSync(path.join(root, "one/new"), "12");
    const b = (await top()).entries[0]!;
    assert.deepEqual({ files: b.files, bytes: b.bytes }, { files: 4, bytes: 12 });
    // a removed folder goes with its subtree
    await sleep(20);
    fs.rmSync(path.join(root, "two"), { recursive: true });
    const c = (await top()).entries[0]!;
    assert.deepEqual({ files: c.files, dirs: c.dirs, bytes: c.bytes }, { files: 2, dirs: 1, bytes: 5 });
    assert.deepEqual(((await (await app.request("/api/du?path=/chg&depth=3")).json()) as Du).entries.map((e) => e.path), ["/chg", "/chg/one"]);
    // an edit in place does not change the folder: only a rescan sees it
    fs.writeFileSync(path.join(root, "one/f"), "123456789");
    assert.equal((await top()).entries[0]!.bytes, 5, "the row of an unchanged folder is reused");
    assert.equal((await top("&fresh=1")).entries[0]!.bytes, 11);
  } finally {
    await app.close();
  }
});

contractTest("an expired row is read again even when the folder is unchanged", async () => {
  const root = path.join(tmp, "ttl");
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, "f"), "123");
  const app = await agentUnderTest({ root: tmp, env: { FILEDECK_INDEX_REVALIDATE_MS: "0", FILEDECK_DU_WAIT_MS: "60000" } });
  try {
    const q = async () => (await (await app.request("/api/du?path=/ttl&depth=0")).json()) as Du;
    assert.equal((await q()).cached, false);
    fs.writeFileSync(path.join(root, "f"), "123456");
    const again = await q();
    assert.equal(again.cached, false, "a row older than the revalidate time is not trusted");
    assert.equal(again.entries[0]!.bytes, 6);
  } finally {
    await app.close();
  }
});

contractTest("the entry cap cuts the answer and says so; the totals of the folder stay exact", async () => {
  const root = path.join(tmp, "cap");
  for (let i = 0; i < 10; i++) fs.mkdirSync(path.join(root, `d${i}`), { recursive: true });
  fs.writeFileSync(path.join(root, "d0/f"), "12345");
  const app = await agentUnderTest({ root: tmp, env: { FILEDECK_WALK_MAX_ENTRIES: "4", FILEDECK_DU_WAIT_MS: "60000" } });
  try {
    const r = (await (await app.request("/api/du?path=/cap&depth=1")).json()) as Du;
    assert.equal(r.truncated, true);
    assert.equal(r.entries.length, 4);
    assert.equal(r.entries[0]!.dirs, 10);
    assert.equal(r.entries[0]!.bytes, 5);
    const one = (await (await app.request("/api/du?path=/cap&depth=0")).json()) as Du;
    assert.equal(one.truncated, false);
  } finally {
    await app.close();
  }
});

contractTest("folders past the depth limit are counted as an error, not entered, and the totals are stable across rescans", async () => {
  const root = path.join(tmp, "deep");
  let p = root;
  for (let i = 0; i < 260; i++) p = path.join(p, "d");
  fs.mkdirSync(p, { recursive: true });
  const app = await agentUnderTest({ root: tmp, env: { FILEDECK_DU_WAIT_MS: "60000" } });
  try {
    const dirs: number[] = [];
    for (let k = 0; k < 3; k++) dirs.push(((await (await app.request("/api/du?path=/deep&depth=0&fresh=1")).json()) as Du).entries[0]!.dirs);
    assert.deepEqual(dirs, [256, 256, 256]);
    // a deeper scan first stores rows below the limit of a scan from the top: the count stays the same
    const sub = "/deep" + "/d".repeat(10);
    await app.request(`/api/du?path=${sub}&depth=0`);
    assert.equal(((await (await app.request("/api/du?path=/deep&depth=0")).json()) as Du).entries[0]!.dirs, 256);
  } finally {
    await app.close();
  }
});

contractTest("a wide folder: totals, removed subfolders dropped, and an unchanged rescan is answered from the store", async () => {
  const root = path.join(tmp, "wide");
  fs.mkdirSync(root, { recursive: true });
  for (let i = 0; i < 3000; i++) fs.writeFileSync(path.join(root, `f${i}`), "ab");
  for (let i = 0; i < 700; i++) fs.mkdirSync(path.join(root, `d${i}`));
  const app = await agentUnderTest({ root: tmp, env: { FILEDECK_DU_WAIT_MS: "60000" } });
  try {
    const du = async (q = "") => (await (await app.request(`/api/du?path=/wide&depth=1${q}`)).json()) as Du;
    const a = await du();
    assert.equal(a.entries.length, 701, "the folder and 700 children, across pages of rows");
    assert.deepEqual({ files: a.entries[0]!.files, dirs: a.entries[0]!.dirs, bytes: a.entries[0]!.bytes }, { files: 3000, dirs: 700, bytes: 6000 });
    assert.equal((await du()).cached, true);
    await sleep(20);
    for (let i = 0; i < 700; i += 2) fs.rmdirSync(path.join(root, `d${i}`));
    const b = await du();
    assert.equal(b.entries.length, 351);
    assert.equal(b.entries[0]!.dirs, 350);
    assert.equal((await du("&fresh=1")).entries.length, 351);
  } finally {
    await app.close();
  }
});

contractTest("the tree lists folders in path order across pages, odd names, and a folder with a name that sorts between", async () => {
  const root = path.join(tmp, "order");
  const names = ["x", "x-1", "x.y", "x y", "é", "日本", "Z", "a", "a-b", "a b"];
  for (const n of names) {
    fs.mkdirSync(path.join(root, n, "in"), { recursive: true });
    fs.writeFileSync(path.join(root, n, "in/f"), n);
  }
  for (let i = 0; i < 300; i++) fs.mkdirSync(path.join(root, `n${String(i).padStart(3, "0")}`));
  const app = await agentUnderTest({ root: tmp, env: { FILEDECK_DU_WAIT_MS: "60000" } });
  try {
    const r = (await (await app.request("/api/du?path=/order&depth=2")).json()) as Du;
    const paths = r.entries.map((e) => e.path);
    const sorted = [...paths].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
    assert.deepEqual(paths, sorted, "path order, byte by byte");
    assert.equal(paths.length, 1 + names.length * 2 + 300);
    assert.ok(paths.indexOf("/order/x-1") < paths.indexOf("/order/x/in"), '"-" sorts before "/", so x-1 comes between x and x/in');
    for (const n of names) assert.equal(r.entries.find((e) => e.path === `/order/${n}`)!.bytes, Buffer.byteLength(n));
  } finally {
    await app.close();
  }
});

contractTest("a size job of a file answers its size and stores nothing", async () => {
  const app = await agentUnderTest({ root: tmp });
  try {
    const r = await app.request("/api/jobs/size", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: "/a/f.txt" }) });
    assert.equal(r.status, 202);
    let j = (await r.json()) as { id: string; state: string; result?: { files: number; bytes: number } };
    for (let i = 0; i < 100 && (j.state === "queued" || j.state === "running"); i++) {
      await sleep(20);
      j = (await (await app.request(`/api/jobs/${j.id}`)).json()) as typeof j;
    }
    assert.equal(j.state, "done");
    assert.deepEqual({ files: j.result!.files, bytes: j.result!.bytes }, { files: 1, bytes: 5 });
    assert.equal((await app.request("/api/du?path=/a/f.txt&cachedOnly=1")).status, 400, "it is still not a folder");
  } finally {
    await app.close();
  }
});

contractTest("size job requests are validated", async () => {
  const app = await agentUnderTest({ root: tmp });
  try {
    const post = (body: string) => app.request("/api/jobs/size", { method: "POST", headers: { "content-type": "application/json" }, body });
    assert.equal((await post("not json")).status, 400);
    assert.equal(((await (await post("not json")).json()) as { error: string }).error, "invalid JSON body");
    assert.equal((await post("{}")).status, 400);
    assert.equal(((await (await post("{}")).json()) as { error: string }).error, "path must be a string");
    assert.equal((await post(JSON.stringify({ path: "/nope" }))).status, 404);
    assert.equal((await post(JSON.stringify({ path: "/a/../b" }))).status, 400);
  } finally {
    await app.close();
  }
});
