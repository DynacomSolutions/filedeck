import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { Readable } from "node:stream";
import { isReservedName, assertNotTrash, resolveRead, STAGING_PREFIX } from "../src/paths.ts";
import * as pinwalk from "../src/pinwalk.ts";
import * as ops from "../src/fsops.ts";
import { walkTree } from "../src/walk.ts";
import { localReader } from "../src/diff-routes.ts";
import { SizeStore } from "../src/size-store.ts";
import { CompareSession } from "../src/cmp-engine.ts";
import { DEFAULT_OPTIONS, localSource } from "../src/folderdiff.ts";
import { mapPath } from "../src/fanwatch.ts";
import { extractTar, prepareCompress, runCompress, zipStream } from "../src/archive.ts";
import type { JobCtl } from "../src/jobs.ts";

/**
 * Filedeck's own names are one set (paths.ts `isReservedName`): the trash store, `.filedeck-work` and the staging prefix
 * `.filedeck-work-<id>`. Every module that walks or targets a tree must skip or refuse all of them.
 */
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "fd-reserved-")));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const RESERVED = [".filedeck-trash", ".filedeck-work", ".filedeck-work-abc", ".filedeck-work-9f3a-77"];

function tree(name: string): string {
  const root = path.join(tmp, name);
  fs.mkdirSync(path.join(root, "sub"), { recursive: true });
  fs.writeFileSync(path.join(root, "visible.txt"), "v");
  fs.writeFileSync(path.join(root, "sub/inner.txt"), "i");
  for (const r of RESERVED) for (const where of [root, path.join(root, "sub")]) {
    fs.mkdirSync(path.join(where, r));
    fs.writeFileSync(path.join(where, r, "hidden.bin"), "X".repeat(1000));
  }
  return root;
}
const none = (names: string[], what: string) => assert.deepEqual(names.filter((n) => RESERVED.includes(n) || n.startsWith(STAGING_PREFIX)), [], what);

test("the one helper knows the trash name, the work name and the staging prefix; pinwalk re-exports it", () => {
  for (const n of RESERVED) assert.ok(isReservedName(n), n);
  for (const n of ["visible.txt", ".filedeck-workshop", ".filedeck", "filedeck-work-abc", ".filedeck-trashy"]) assert.ok(!isReservedName(n), n);
  assert.equal(pinwalk.isReservedName, isReservedName);
  assert.equal(pinwalk.STAGING_PREFIX, STAGING_PREFIX);
});

test("targets and reads are refused for every reserved name", async () => {
  const root = tree("refuse");
  for (const n of RESERVED) {
    assert.throws(() => assertNotTrash(`/sub/${n}/x`), (e: { status?: number }) => e.status === 403, n);
    assert.throws(() => pinwalk.assertNotReserved(`/${n}`), (e: { status?: number }) => e.status === 403, n);
    assert.throws(() => resolveRead(root, `/${n}/hidden.bin`), (e: { status?: number }) => e.status === 403, n);
    await assert.rejects(ops.stat(root, `/${n}`), (e: { status?: number }) => e.status === 403, n);
  }
});

test("listings skip every reserved name", async () => {
  const root = tree("list");
  for (const hidden of [true, false]) {
    const l = (await ops.list(root, "/", hidden)) as unknown as { entries: { name: string }[] };
    none(l.entries.map((e) => e.name), `list hidden=${hidden}`);
    assert.ok(l.entries.some((e) => e.name === "visible.txt"));
    const got: string[] = [];
    for await (const v of ops.listStream(root, "/sub", hidden)) if ("entries" in v) got.push(...v.entries.map((e) => e.name));
    none(got, `listStream hidden=${hidden}`);
  }
  none(await localReader().readDir(root).then((r) => r.map((e) => e.n)), "diff reader");
});

test("walk and search skip every reserved name and what is inside", async () => {
  const root = tree("walk");
  const seen: string[] = [];
  for await (const batch of walkTree(root, "/", { hidden: true, depth: 6, max: 1000, include: [], exclude: [], ignoreCase: false })) if (Array.isArray(batch)) seen.push(...batch.map((e) => e.p));
  assert.ok(seen.some((p) => p.endsWith("inner.txt")));
  assert.deepEqual(seen.filter((p) => p.split("/").some((n) => isReservedName(n))), []);
});

test("size scans leave every reserved name out", async () => {
  const root = tree("size");
  const s = new SizeStore(":memory:", { root, ttlMs: 60_000, maxEntries: 100_000 });
  const r = await s.scan("/");
  assert.equal(r.files, 2);
  assert.equal(r.bytes, 2);
  s.close();
});

test("a comparison skips every reserved name", async () => {
  const l = tree("cmp-l");
  const r = tree("cmp-r");
  fs.writeFileSync(path.join(r, ".filedeck-work-abc/hidden.bin"), "DIFFERENT");
  const sess = new CompareSession(localSource(l, "/"), localSource(r, "/"), { ...DEFAULT_OPTIONS, mode: "content" });
  await sess.run(new AbortController().signal);
  assert.equal(sess.folder("")!.status, "identical");
  none(sess.folder("")!.rows.map((x) => x.p), "compare rows");
  sess.close();
});

test("the change watcher ignores every reserved name", () => {
  for (const n of RESERVED) assert.equal(mapPath(tmp, `${tmp}/x/${n}/y`), null, n);
  assert.equal(mapPath(tmp, `${tmp}/x/visible.txt`), "/x/visible.txt");
});

const ctl = () => ({ signal: new AbortController().signal, progress: { bytes: 0, totalBytes: 0, entries: 0, totalEntries: 0, current: "" } }) as unknown as JobCtl;
function tarEntry(name: string): Buffer {
  const h = Buffer.alloc(512);
  h.write(name, 0, 100);
  h.write("0000644\0" + "0000000\0" + "0000000\0" + "00000000000\0" + "00000000000\0", 100);
  h.write("        ", 148);
  h.write("5", 156);
  h.write("ustar\0" + "00", 257);
  let sum = 0;
  for (const b of h) sum += b;
  h.write(sum.toString(8).padStart(6, "0") + "\0 ", 148);
  return h;
}
test("an archive entry with a reserved name aborts the extraction", async () => {
  for (const n of RESERVED) {
    const st = fs.mkdtempSync(path.join(tmp, "st-"));
    await assert.rejects(
      extractTar(Readable.from([Buffer.concat([tarEntry(`pre/${n}/`), Buffer.alloc(1024)])]), st, { maxEntries: 10, maxBytes: 1 << 20 }, ctl()),
      /reserved name/,
      n,
    );
  }
});

const needTool = { skip: spawnSync("bsdtar", ["--version"]).status === 0 ? false : "bsdtar not installed" };
test("compress and zip download leave every reserved name out", needTool, async () => {
  const root = path.join(tmp, "arch");
  fs.mkdirSync(path.join(root, "src/vol"), { recursive: true });
  fs.mkdirSync(path.join(root, "out"));
  fs.writeFileSync(path.join(root, "src/vol/keep.txt"), "k");
  for (const r of RESERVED) {
    fs.mkdirSync(path.join(root, "src/vol", r));
    fs.writeFileSync(path.join(root, "src/vol", r, "hidden.bin"), "X");
  }
  const lim = { maxEntries: 1000, maxBytes: 1 << 30 };
  const r = await runCompress(await prepareCompress(root, "/src", ["vol"], "tar.gz", "vol", { destDir: "/out" }), lim, ctl());
  const names = spawnSync("bsdtar", ["-tf", path.join(root, r.path)]).stdout.toString().split("\n").filter(Boolean);
  assert.ok(names.some((n) => n.endsWith("keep.txt")), names.join(","));
  assert.deepEqual(names.filter((n) => n.includes(".filedeck-")), []);
  const zip = path.join(tmp, "dl.zip");
  await new Promise<void>((res, rej) => {
    const z = zipStream(path.join(root, "src"), ["vol"], new AbortController().signal);
    const out = fs.createWriteStream(zip);
    z.on("error", rej);
    out.on("close", () => res());
    z.pipe(out);
  });
  const zn = spawnSync("bsdtar", ["-tf", zip]).stdout.toString().split("\n").filter(Boolean);
  assert.ok(zn.some((n) => n.endsWith("keep.txt")));
  assert.deepEqual(zn.filter((n) => n.includes(".filedeck-")), []);
});

test("every module that walks a tree uses the one helper, not its own comparison", () => {
  const dir = path.join(import.meta.dirname, "../src");
  for (const f of ["walk.ts", "size-store.ts", "cmp-engine.ts", "diff-routes.ts", "props.ts", "fsops.ts", "fanwatch.ts", "pinwalk.ts", "archive.ts"]) {
    const text = fs.readFileSync(path.join(dir, f), "utf8");
    assert.ok(/isReservedName|assertNotReserved|assertNotTrash/.test(text), `${f} checks reserved names`);
    assert.ok(!/(===|!==)\s*TRASH_DIR/.test(text.replace(/path\.join\([^)]*TRASH_DIR[^)]*\)/g, "")), `${f} compares a name with the trash name directly`);
  }
});
