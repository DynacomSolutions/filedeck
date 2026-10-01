import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createAgent } from "../src/agent.ts";
import { loadConfig } from "../src/config.ts";
import { safeRegex } from "../src/search.ts";

let tmp: string, outside: string, agent: ReturnType<typeof createAgent>;
const write = (rel: string, data: string | Buffer) => {
  fs.mkdirSync(path.dirname(path.join(tmp, rel)), { recursive: true });
  fs.writeFileSync(path.join(tmp, rel), data);
};

before(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "filedeck-search-")));
  outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "filedeck-search-out-")));
  fs.writeFileSync(path.join(outside, "secret.txt"), "needle outside");
  write("s/Readme.md", "hello\nthe Needle is here\nbye\n");
  write("s/src/main.ts", "const a = 1;\n// needle two\n// needle three\n");
  write("s/src/deep/util.ts", "nothing");
  write("s/notes.txt", "x".repeat(100) + "\nneedle at line two\n");
  write("s/.hidden/h.txt", "needle hidden");
  write("s/bin.dat", Buffer.concat([Buffer.from([0, 1, 2]), Buffer.from("needle")]));
  write("s/big.txt", "needle " + "y".repeat(2000));
  fs.symlinkSync(outside, path.join(tmp, "s/out"));
  fs.symlinkSync(path.join(outside, "secret.txt"), path.join(tmp, "s/link.txt"));
  agent = createAgent(loadConfig({ FILEDECK_ROOT: tmp, FILEDECK_NODE: "t", FILEDECK_SEARCH_MAX_FILE: "1000" } as never));
});
after(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
});

interface Line {
  e?: { h: { p: string; t: string; l?: number; x?: string; n?: number }[]; sc: number };
  done?: { scanned: number; grepped: number; skipped: number; capped: boolean; truncated: boolean; depthLimited: boolean };
  error?: string;
}
async function search(qs: string) {
  const r = await agent.request("/api/fs/search?" + qs);
  if (r.status !== 200) return { status: r.status, hits: [], done: undefined };
  const lines = (await r.text()).trim().split("\n").map((l) => JSON.parse(l) as Line);
  return { status: 200, hits: lines.flatMap((l) => l.e?.h ?? []), done: lines.at(-1)?.done, lines };
}
const names = (h: { p: string }[]) => h.map((x) => x.p).sort();

test("name search: substring (case-insensitive by default), case-sensitive, types", async () => {
  assert.deepEqual(names((await search("path=/s&q=MAIN")).hits), ["src/main.ts"]);
  assert.deepEqual(names((await search("path=/s&q=MAIN&ic=0")).hits), []);
  assert.deepEqual(names((await search("path=/s&q=src&types=dir")).hits), ["src"]);
  assert.deepEqual(names((await search("path=/s&q=util&types=file")).hits), ["src/deep/util.ts"]);
  const r = await search("path=/s&q=e");
  assert.ok(r.done && r.done.scanned > 5);
});

test("glob and regex name search", async () => {
  assert.deepEqual(names((await search("path=/s&q=*.ts&mode=glob")).hits), ["src/deep/util.ts", "src/main.ts"]);
  assert.deepEqual(names((await search("path=/s&q=src/*.ts&mode=glob")).hits), ["src/main.ts"]);
  assert.deepEqual(names((await search("path=/s&q=" + encodeURIComponent("^(main|util)\\.ts$") + "&mode=regex")).hits), ["src/deep/util.ts", "src/main.ts"]);
  assert.equal((await search("path=/s&q=" + encodeURIComponent("(") + "&mode=regex")).status, 400);
  assert.equal((await search("path=/s&q=" + encodeURIComponent("(a+)+$") + "&mode=regex")).status, 400);
  assert.equal((await search("path=/s&q=" + encodeURIComponent("a".repeat(500)) + "&mode=regex")).status, 400);
  assert.throws(() => safeRegex("(x*)*", ""));
  assert.throws(() => safeRegex("(a)\\1", ""));
  assert.ok(safeRegex("^[a-z]+\\.(ts|js)$", "i").test("A.TS"));
});

test("content search: lines, counts, binary and oversized files skipped, hidden only on request", async () => {
  const r = await search("path=/s&content=needle");
  const by = Object.fromEntries(r.hits.map((h) => [h.p, h]));
  assert.deepEqual(names(r.hits), ["Readme.md", "notes.txt", "src/main.ts"]);
  assert.equal(by["Readme.md"]!.l, 2);
  assert.match(by["Readme.md"]!.x!, /Needle is here/);
  assert.equal(by["src/main.ts"]!.n, 2);
  assert.equal(by["notes.txt"]!.l, 2);
  assert.equal(r.done!.skipped, 2, "binary + oversized"); // bin.dat, big.txt (> 1000 bytes)
  assert.deepEqual(names((await search("path=/s&content=needle&hidden=1")).hits), [".hidden/h.txt", "Readme.md", "notes.txt", "src/main.ts"]);
  assert.deepEqual(names((await search("path=/s&content=NEEDLE&cic=0")).hits), []);
  assert.deepEqual(names((await search("path=/s&content=" + encodeURIComponent("needle \\w+$") + "&cre=1")).hits), ["src/main.ts"]);
  // name filter + content together
  assert.deepEqual(names((await search("path=/s&q=*.md&mode=glob&content=needle")).hits), ["Readme.md"]);
});

test("symlinks are never followed or read, and the walk stays under the start folder", async () => {
  const all = await search("path=/s&q=&types=file");
  assert.ok(names(all.hits).includes("link.txt"));
  const r = await search("path=/s&content=outside&hidden=1");
  assert.deepEqual(r.hits, []);
  assert.equal((await search("path=/../x&q=a")).status, 400);
  assert.equal((await search("path=/s/notes.txt&q=a")).status, 400);
  assert.equal((await search("path=/nope&q=a")).status, 404);
  assert.equal((await search("path=/s")).status, 400); // empty search
});

test("caps: result cap, entry cap, depth cap", async () => {
  const a = await search("path=/s&q=e&maxResults=2");
  assert.equal(a.hits.length, 2);
  assert.equal(a.done!.capped, true);
  const b = await search("path=/s&q=e&max=3");
  assert.equal(b.done!.truncated, true);
  const c = await search("path=/s&q=util&depth=2");
  assert.deepEqual(c.hits, []);
  assert.equal(c.done!.depthLimited, true);
});

test("total content byte budget ends the search early", async () => {
  const tiny = createAgent(loadConfig({ FILEDECK_ROOT: tmp, FILEDECK_NODE: "t", FILEDECK_SEARCH_MAX_BYTES: "60" } as never));
  const r = await tiny.request("/api/fs/search?path=/s&content=needle");
  const lines = (await r.text()).trim().split("\n").map((l) => JSON.parse(l) as Line);
  assert.equal(lines.at(-1)!.done!.capped, true);
});

test("a cancelled request stops the walk", async () => {
  for (let i = 0; i < 300; i++) write(`many/d${i % 10}/f${i}.txt`, "x");
  const ac = new AbortController();
  const r = await agent.request("/api/fs/search?path=/many&q=f", { signal: ac.signal });
  const reader = r.body!.getReader();
  await reader.read();
  ac.abort();
  await reader.cancel().catch(() => undefined);
  // a new search still works (the gate slot was released)
  assert.equal((await search("path=/many&q=f1")).status, 200);
});

test("concurrency gate answers 429 beyond the limit", async () => {
  const one = createAgent(loadConfig({ FILEDECK_ROOT: tmp, FILEDECK_NODE: "t", FILEDECK_SEARCH_CONCURRENCY: "1" } as never));
  const first = await one.request("/api/fs/search?path=/many&q=f");
  const rd = first.body!.getReader();
  await rd.read();
  const second = await one.request("/api/fs/search?path=/many&q=f");
  assert.equal(second.status, 429);
  await rd.cancel();
});
