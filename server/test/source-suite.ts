import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { serve } from "@hono/node-server";
import type { AddressInfo } from "node:net";
import { createAgent } from "../src/agent.ts";
import { createHub } from "../src/hub.ts";
import { loadConfig } from "../src/config.ts";

/** What a backend fixture hands the shared suite. Sources must be named `nas` (good credentials) and `badnas` (wrong ones). */
export interface Fixture {
  sources: Record<string, unknown>[];
  /** directory on disk that the source `nas` shows as "/" */
  diskRoot: string;
  /** strings that must never appear in any API response */
  leaks: string[];
  /** false when the backend cannot hold empty-directory-free trees or part files (skips the .part scan) */
  close(): Promise<void>;
}
export type FixtureFactory = (tmp: string, secrets: string) => Promise<Fixture>;

const open = (app: { fetch: never }) =>
  new Promise<ReturnType<typeof serve>>((res) => {
    const s: ReturnType<typeof serve> = serve({ fetch: app.fetch, port: 0 }, () => res(s));
  });
const portOf = (s: ReturnType<typeof serve>) => (s.address() as AddressInfo).port;

/** The whole HTTP behaviour a network source must have, run against one backend through the hub. */
export function defineSourceSuite(type: string, factory: FixtureFactory) {
  let hubApp: { close(): Promise<void> };
  let tmp: string, fx: Fixture, agentSrv: ReturnType<typeof serve>, hubSrv: ReturnType<typeof serve>, hub: string, agentRoot: string;
  let remote: string;

  before(async () => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "filedeck-src-")));
    agentRoot = path.join(tmp, "agent");
    fs.mkdirSync(agentRoot);
    const secrets = path.join(tmp, "secrets");
    fx = await factory(tmp, secrets);
    remote = path.dirname(fx.diskRoot); // tests below address files as `share/...` under `remote`
    agentSrv = await open(createAgent(loadConfig({ FILEDECK_ROOT: agentRoot, FILEDECK_NODE: "n1" } as never)) as never);
    hubApp = createHub(
      loadConfig({
        FILEDECK_MODE: "hub",
        NODES: `n1=http://127.0.0.1:${portOf(agentSrv)}`,
        FILEDECK_STATIC: tmp,
        FILEDECK_SOURCES: JSON.stringify(fx.sources),
        FILEDECK_SOURCE_SECRETS: secrets,
      } as never),
    );
    hubSrv = await open(hubApp as never);
    hub = `http://127.0.0.1:${portOf(hubSrv)}`;
  });
  after(async () => {
    await hubApp.close();
    for (const sv of [hubSrv, agentSrv]) {
      (sv as unknown as import("node:http").Server).closeAllConnections();
      sv.close();
    }
    await fx.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const S = (p: string) => `${hub}/api/nodes/nas${p}`;
  const N = (p: string) => `${hub}/api/nodes/n1${p}`;
  const post = (url: string, body: unknown) => fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const put = (url: string, body: string | Buffer) => fetch(url, { method: "PUT", body: body as BodyInit });
  const same = (a: Buffer, b: Buffer, what = "content") => assert.ok(a.equals(b), `${what} differs (${a.length} vs ${b.length} bytes)`);
  const bufOf = (n: number) => Buffer.from(Array.from({ length: n }, (_, i) => (i * 7) & 255));

  test(`${type}: sources are listed with reachability and never expose credentials`, async () => {
    const r = await fetch(`${hub}/api/nodes`);
    const text = await r.text();
    const j = JSON.parse(text) as { nodes: unknown[]; sources: { name: string; type: string; host: string; online: boolean }[] };
    assert.deepEqual(j.sources.map((s) => [s.name, s.type, s.online]), [["nas", type, true], ["badnas", type, false]]);
    for (const l of fx.leaks) assert.equal(text.includes(l), false, "response leaks a credential");
    assert.equal(j.nodes.length, 1);
  });

  test(`${type}: wrong credentials fail without leaking them`, async () => {
    const r = await fetch(`${hub}/api/nodes/badnas/api/fs/list?path=/`);
    const t = await r.text();
    assert.equal(r.status, 502);
    assert.match(t, /authentication failed/);
    for (const l of fx.leaks) assert.equal(t.includes(l), false);
  });

  test(`${type}: list, stat, upload, ranged read, text edit with etag`, async () => {
    const data = bufOf(300_000);
    const up = await put(S("/api/fs/upload?dir=/&name=a.bin"), data);
    assert.equal(up.status, 201);
    same(fs.readFileSync(path.join(remote, "share/a.bin")), data);
    assert.deepEqual(fs.readdirSync(path.join(remote, "share")).filter((n) => n.endsWith(".part")), []);

    const ls = (await (await fetch(S("/api/fs/list?path=/"))).json()) as { entries: { name: string; size: number; type: string; path: string }[] };
    assert.deepEqual(ls.entries.map((e) => [e.name, e.size, e.type, e.path]), [["a.bin", 300_000, "file", "/a.bin"]]);
    const st = (await (await fetch(S("/api/fs/stat?path=/a.bin"))).json()) as { size: number };
    assert.equal(st.size, 300_000);

    const full = await fetch(S("/api/fs/read?path=/a.bin"));
    assert.equal(full.status, 200);
    same(Buffer.from(await full.arrayBuffer()), data);
    const part = await fetch(S("/api/fs/read?path=/a.bin"), { headers: { range: "bytes=100000-100009" } });
    assert.equal(part.status, 206);
    assert.equal(part.headers.get("content-range"), "bytes 100000-100009/300000");
    same(Buffer.from(await part.arrayBuffer()), data.subarray(100000, 100010));
    const bad = await fetch(S("/api/fs/read?path=/a.bin"), { headers: { range: "bytes=999999-" } });
    assert.equal(bad.status, 416);

    const c = await put(S("/api/fs/write?path=/t.txt&create=1"), "one");
    assert.equal(c.status, 200);
    const t1 = (await (await fetch(S("/api/fs/text?path=/t.txt"))).json()) as { content: string; etag: string };
    assert.equal(t1.content, "one");
    const w = await fetch(S("/api/fs/write?path=/t.txt"), { method: "PUT", headers: { "if-match": t1.etag }, body: "two" });
    assert.equal(w.status, 200);
    assert.equal(fs.readFileSync(path.join(remote, "share/t.txt"), "utf8"), "two");
    const stale = await fetch(S("/api/fs/write?path=/t.txt"), { method: "PUT", headers: { "if-match": t1.etag }, body: "three" });
    assert.equal(stale.status, 409);
    const exist = await put(S("/api/fs/write?path=/t.txt&create=1"), "x");
    assert.equal(exist.status, 409);
  });

  test(`${type}: confinement: traversal rejected, upload exists without overwrite`, async () => {
    assert.equal((await fetch(S("/api/fs/list?path=/../.."))).status, 400);
    assert.equal((await put(S("/api/fs/upload?dir=/&name=..%2Fx"), "x")).status, 400);
    assert.equal(fs.existsSync(path.join(remote, "x")), false);
    assert.equal((await put(S("/api/fs/upload?dir=/&name=t.txt"), "x")).status, 409);
    assert.equal((await put(S("/api/fs/upload?dir=/&name=t.txt&overwrite=1"), "replaced")).status, 201);
    assert.equal(fs.readFileSync(path.join(remote, "share/t.txt"), "utf8"), "replaced");
    assert.equal((await fetch(S("/api/fs/read?path=/nope"))).status, 404);
  });

  test(`${type}: mkdir, rename, move, copy, overwrite copy, hash, walk, delete, no trash`, async () => {
    assert.equal((await post(S("/api/fs/mkdir"), { path: "/d" })).status, 201);
    assert.equal((await post(S("/api/fs/mkdir"), { path: "/d" })).status, 409);
    await put(S("/api/fs/upload?dir=/d&name=f.txt"), "hello");
    assert.equal((await post(S("/api/fs/mkdir"), { path: "/d/sub" })).status, 201);
    await put(S("/api/fs/upload?dir=/d/sub&name=g.txt"), "deep");

    const rn = await post(S("/api/fs/rename"), { from: "/d/f.txt", to: "/d/f2.txt" });
    assert.equal(rn.status, 200);
    assert.equal(fs.existsSync(path.join(remote, "share/d/f2.txt")), true);
    assert.equal((await post(S("/api/fs/rename"), { from: "/d/f2.txt", to: "/d/sub/g.txt" })).status, 409);
    assert.equal((await post(S("/api/fs/rename"), { from: "/d/f2.txt", to: "/d/sub/g.txt", overwrite: true })).status, 200);
    assert.equal(fs.readFileSync(path.join(remote, "share/d/sub/g.txt"), "utf8"), "hello");
    await post(S("/api/fs/rename"), { from: "/d/sub/g.txt", to: "/d/f.txt" });
    await put(S("/api/fs/upload?dir=/d/sub&name=g.txt"), "deep");

    const cp = (await (await post(S("/api/fs/copy"), { from: ["/d"], toDir: "/" })).json()) as { paths: string[] };
    assert.deepEqual(cp.paths, ["/d (copy)"]);
    assert.equal(fs.readFileSync(path.join(remote, "share/d (copy)/sub/g.txt"), "utf8"), "deep");
    assert.equal((await post(S("/api/fs/copy"), { from: ["/d"], toDir: "/d/sub" })).status, 400);
    await put(S("/api/fs/upload?dir=/d (copy)&name=f.txt&overwrite=1"), "different");
    const ow = await post(S("/api/fs/copy"), { from: ["/d/f.txt"], toDir: "/d (copy)", overwrite: true });
    assert.equal(ow.status, 200);
    assert.equal(fs.readFileSync(path.join(remote, "share/d (copy)/f.txt"), "utf8"), "hello");
    const mv = await post(S("/api/fs/move"), { from: ["/d (copy)/f.txt"], toDir: "/d/sub" });
    assert.equal(mv.status, 200);
    assert.equal(fs.existsSync(path.join(remote, "share/d/sub/f.txt")), true);

    const hash = (await (await fetch(S("/api/fs/hash?path=/d/f.txt"))).json()) as { sha256: string };
    assert.equal(hash.sha256, createHash("sha256").update("hello").digest("hex"));
    assert.equal((await fetch(S("/api/fs/hash?path=/d"))).status, 400);

    const walk = await (await fetch(S("/api/fs/walk?path=/d&depth=5"))).text();
    const lines = walk.trim().split("\n").map((l) => JSON.parse(l) as { e?: { p: string; t: string }[]; done?: unknown });
    const paths = lines.flatMap((l) => l.e ?? []).map((e) => `${e.t}:${e.p}`).sort();
    assert.deepEqual(paths, ["dir:sub", "file:f.txt", "file:sub/f.txt", "file:sub/g.txt"]);
    assert.ok(lines.at(-1)?.done);

    const tr = await post(S("/api/fs/trash"), { paths: ["/d"] });
    assert.equal(tr.status, 409);
    assert.equal(fs.existsSync(path.join(remote, "share/d")), true);
    assert.equal((await post(S("/api/fs/delete"), { paths: ["/d", "/d (copy)"] })).status, 200);
    assert.equal(fs.existsSync(path.join(remote, "share/d")), false);
    assert.equal(fs.existsSync(path.join(remote, "share/d (copy)")), false);
    assert.equal((await post(S("/api/fs/delete"), { paths: ["/"] })).status, 400);
  });

  test(`${type}: hub streams between a node and a network source (files and folders), move removes the source`, async () => {
    fs.mkdirSync(path.join(agentRoot, "tree/inner"), { recursive: true });
    const big = bufOf(2_000_000);
    fs.writeFileSync(path.join(agentRoot, "tree/big.bin"), big);
    fs.writeFileSync(path.join(agentRoot, "tree/inner/x.txt"), "x");
    fs.symlinkSync("big.bin", path.join(agentRoot, "tree/link"));

    const t1 = await post(`${hub}/api/transfer`, { src: { node: "n1", path: "/tree" }, dst: { node: "nas", dir: "/" }, op: "copy" });
    assert.equal(t1.status, 201);
    same(fs.readFileSync(path.join(remote, "share/tree/big.bin")), big);
    assert.equal(fs.readFileSync(path.join(remote, "share/tree/inner/x.txt"), "utf8"), "x");
    assert.equal(fs.existsSync(path.join(remote, "share/tree/link")), false);
    assert.deepEqual(fs.readdirSync(path.join(remote, "share/tree")).filter((n) => n.endsWith(".part")), []);

    assert.equal((await post(`${hub}/api/transfer`, { src: { node: "n1", path: "/tree" }, dst: { node: "nas", dir: "/" }, op: "copy" })).status, 409);

    const t2 = await post(`${hub}/api/transfer`, { src: { node: "nas", path: "/tree" }, dst: { node: "n1", dir: "/" }, op: "copy", overwrite: true });
    assert.equal(t2.status, 201);

    const t3 = await post(`${hub}/api/transfer`, { src: { node: "nas", path: "/tree/big.bin" }, dst: { node: "nas", dir: "/tree/inner" }, op: "move" });
    assert.equal(t3.status, 201);
    assert.equal(fs.existsSync(path.join(remote, "share/tree/big.bin")), false);
    same(fs.readFileSync(path.join(remote, "share/tree/inner/big.bin")), big);

    const t4 = await post(`${hub}/api/transfer`, { src: { node: "nas", path: "/tree/inner/big.bin" }, dst: { node: "n1", dir: "/tree" }, op: "move", overwrite: true });
    assert.equal(t4.status, 201);
    assert.equal(fs.existsSync(path.join(remote, "share/tree/inner/big.bin")), false);
    same(fs.readFileSync(path.join(agentRoot, "tree/big.bin")), big);
    assert.equal((await post(`${hub}/api/transfer`, { src: { node: "nas", path: "/nope" }, dst: { node: "n1", dir: "/" }, op: "copy" })).status, 404);
  });

  test(`${type}: folder diff works between a node and a source`, async () => {
    fs.mkdirSync(path.join(agentRoot, "cmp"), { recursive: true });
    fs.writeFileSync(path.join(agentRoot, "cmp/same.txt"), "same");
    fs.writeFileSync(path.join(agentRoot, "cmp/diff.txt"), "aaaa");
    await post(S("/api/fs/mkdir"), { path: "/cmp" });
    await put(S("/api/fs/upload?dir=/cmp&name=same.txt"), "same");
    await put(S("/api/fs/upload?dir=/cmp&name=diff.txt"), "bbbb");
    await put(S("/api/fs/upload?dir=/cmp&name=only.txt"), "o");
    const opts = { mode: "content", toleranceMs: 2000, ignoreCase: false, ignoreHidden: false, include: "", exclude: "", depth: 8, maxEntries: 1000 };
    const j = (await (await post(`${hub}/api/diff/jobs`, { left: { node: "n1", path: "/cmp" }, right: { node: "nas", path: "/cmp" }, options: opts })).json()) as { id: string };
    let state = "";
    for (let i = 0; i < 100 && state !== "done"; i++) {
      state = ((await (await fetch(`${hub}/api/diff/jobs/${j.id}`)).json()) as { state: string }).state;
      if (state === "failed") assert.fail("diff job failed");
      if (state !== "done") await new Promise((r) => setTimeout(r, 50));
    }
    const res = (await (await fetch(`${hub}/api/diff/jobs/${j.id}/result`)).json()) as { rows: { p: string; status: string }[] };
    assert.deepEqual(Object.fromEntries(res.rows.map((r) => [r.p, r.status])), { "same.txt": "identical", "diff.txt": "different", "only.txt": "right-only" });
  });
}
