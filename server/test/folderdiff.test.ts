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
import { compileGlobs, splitPatterns } from "../src/glob.ts";
import { Jobs } from "../src/jobs.ts";
import { DEFAULT_OPTIONS, classify, compareTrees, localSource, normalizeOptions, type DiffOptions, type DiffResult } from "../src/folderdiff.ts";

let tmp: string, outside: string, agent: ReturnType<typeof createAgent>;
const sha = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");

const write = (root: string, rel: string, data: string, mtimeMs?: number) => {
  const f = path.join(root, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, data);
  if (mtimeMs !== undefined) fs.utimesSync(f, mtimeMs / 1000, mtimeMs / 1000);
};
const T0 = Date.UTC(2024, 0, 1);

before(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "filedeck-fd-")));
  outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "filedeck-fd-out-")));
  fs.writeFileSync(path.join(outside, "secret.txt"), "secret");
  fs.writeFileSync(path.join(tmp, "a.txt"), "hello\n");
  fs.mkdirSync(path.join(tmp, "d"));
  fs.symlinkSync(path.join(outside, "secret.txt"), path.join(tmp, "abs-link"));
  fs.symlinkSync("../../../../" + path.relative("/", path.join(outside, "secret.txt")), path.join(tmp, "rel-link"));
  fs.symlinkSync(outside, path.join(tmp, "dirlink"));
  agent = createAgent(loadConfig({ FILEDECK_ROOT: tmp, FILEDECK_NODE: "t" } as never));
});
after(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
});

// ---------------------------------------------------------------- hash endpoint

const hash = (p: string) => agent.request(`/api/fs/hash?path=${encodeURIComponent(p)}`);

test("hash endpoint returns the streamed sha256", async () => {
  const r = await hash("/a.txt");
  assert.equal(r.status, 200);
  const j = (await r.json()) as { sha256: string; size: number; path: string };
  assert.equal(j.sha256, sha("hello\n"));
  assert.equal(j.size, 6);
  assert.equal(j.path, "/a.txt");
});

test("hash endpoint path guard: traversal, directories, missing, symlink escapes", async () => {
  assert.equal((await hash("/../a.txt")).status, 400);
  assert.equal((await hash("/d/../../etc/passwd")).status, 400);
  assert.equal((await hash("/a.txt\0")).status, 400);
  assert.equal((await hash("")).status, 400); // the root is a directory
  assert.equal((await hash("/d")).status, 400);
  assert.equal((await hash("/nope")).status, 404);
  // An absolute link is re-based onto the root, so it cannot read the real /tmp/... file.
  const abs = await hash("/abs-link");
  assert.equal(abs.status, 404);
  assert.ok(!JSON.stringify(await abs.json()).includes(sha("secret")));
  // A relative link climbing above the root is clamped at the root.
  assert.equal((await hash("/rel-link")).status, 404);
  assert.equal((await hash("/dirlink/secret.txt")).status, 404);
});

test("walk endpoint: NDJSON, never follows symlinks, path guard", async () => {
  write(tmp, "w/x/one.txt", "1");
  write(tmp, "w/two.txt", "22");
  fs.symlinkSync(outside, path.join(tmp, "w/out"));
  const r = await agent.request("/api/fs/walk?path=/w");
  assert.equal(r.status, 200);
  const lines = (await r.text()).trim().split("\n").map((l) => JSON.parse(l) as { e?: { p: string; t: string }[]; done?: unknown });
  const entries = lines.flatMap((l) => l.e ?? []);
  assert.deepEqual(entries.map((e) => `${e.t}:${e.p}`).sort(), ["dir:x", "file:two.txt", "file:x/one.txt", "symlink:out"]);
  assert.ok(lines.at(-1)?.done);
  assert.equal((await agent.request("/api/fs/walk?path=/../x")).status, 400);
  assert.equal((await agent.request("/api/fs/walk?path=/a.txt")).status, 400);
  assert.equal((await agent.request("/api/fs/walk?path=/nope")).status, 404);
});

// ---------------------------------------------------------------- glob

test("glob: base names, anchored paths, dir-only, braces, ignore case", () => {
  const m = compileGlobs(["*.log", "node_modules/", "/build", "src/**/*.test.ts", "*.{png,jpg}"], false);
  assert.ok(m.test("a/b/x.log", false));
  assert.ok(!m.test("a/b/x.logx", false));
  assert.ok(m.test("a/node_modules", true));
  assert.ok(!m.test("a/node_modules", false));
  assert.ok(m.test("build", true));
  assert.ok(!m.test("sub/build", true));
  assert.ok(m.test("src/a/b/c.test.ts", false));
  assert.ok(m.test("src/c.test.ts", false));
  assert.ok(m.test("pics/p.JPG".toLowerCase(), false));
  assert.ok(!m.test("pics/P.JPG", false));
  assert.ok(compileGlobs(["*.JPG"], true).test("x.jpg", false));
  assert.deepEqual(splitPatterns("*.log, *.{a,b}\n.git/ ,"), ["*.log", "*.{a,b}", ".git/"]);
  assert.ok(!compileGlobs(["[unclosed"], false).test("x", false));
});

// ---------------------------------------------------------------- classify (pure)

const f = (s: number, m: number, extra = {}) => ({ t: "file" as const, s, m, ...extra });
const opt = (mode: DiffOptions["mode"], toleranceMs = 2000) => ({ mode, toleranceMs });

test("classify: every mode", () => {
  assert.equal(classify(f(1, 0), f(2, 99999), opt("name")).status, "identical");
  assert.equal(classify(f(1, 0), f(2, 0), opt("size")).status, "different");
  assert.equal(classify(f(1, 0), f(1, 99999), opt("size")).status, "identical");
  assert.equal(classify(f(1, 0), f(2, 0), opt("mtime")).status, "identical");
  // mtime tolerance boundary: equal at exactly the tolerance, different beyond it
  assert.equal(classify(f(1, 2000), f(1, 0), opt("mtime", 2000)).status, "identical");
  const beyond = classify(f(1, 2001), f(1, 0), opt("mtime", 2000));
  assert.deepEqual(beyond, { status: "different", why: "modified time", newer: "left" });
  assert.equal((classify(f(1, 0), f(1, 5000), opt("mtime")) as { newer?: string }).newer, "right");
  assert.equal(classify(f(1, 0), f(2, 0), opt("content")).status, "different"); // size short-cut
  assert.equal(classify(f(5, 0), f(5, 0), opt("content")).status, "pending-hash");
  assert.equal(classify(f(5, 0), f(5, 100), opt("quick")).status, "identical");
  assert.equal(classify(f(5, 0), f(5, 9000), opt("quick")).status, "pending-hash");
  assert.equal(classify(f(5, 0), f(6, 0), opt("quick")).status, "different");
});

test("classify: type mismatch, dirs, symlinks", () => {
  const d = { t: "dir" as const, s: 0, m: 0 };
  assert.deepEqual(classify(d, f(1, 0), opt("name")), { status: "different", why: "type" });
  assert.equal(classify(d, { ...d, m: 5 }, opt("content")).status, "pending-dir");
  const l = (target: string) => ({ t: "symlink" as const, s: 1, m: 0, l: target });
  assert.equal(classify(l("a"), l("a"), opt("content")).status, "identical");
  assert.equal(classify(l("a"), l("b"), opt("size")).status, "different");
  assert.equal(classify(l("a"), l("b"), opt("name")).status, "identical");
});

test("normalizeOptions validates and clamps", () => {
  const o = normalizeOptions({ mode: "content", depth: 9999, maxEntries: 1e12, concurrency: 0, exclude: "*.log, .git/" });
  assert.equal(o.mode, "content");
  assert.equal(o.depth, 256);
  assert.ok(!("maxEntries" in o)); // there is no entry cap any more; old clients may still send it
  assert.equal(o.concurrency, 1);
  assert.deepEqual(o.exclude, ["*.log", ".git/"]);
  assert.deepEqual(normalizeOptions(undefined), DEFAULT_OPTIONS);
  assert.throws(() => normalizeOptions({ mode: "bogus" }));
  assert.throws(() => normalizeOptions({ depth: "5" }));
  assert.throws(() => normalizeOptions({ include: [1] }));
});

// ---------------------------------------------------------------- tree comparison

let L: string, R: string;
const ctl = (signal = new AbortController().signal) => ({ signal, progress: { bytes: 0, totalBytes: 0, entries: 0, totalEntries: 0, current: "" } });
const run = (o: Partial<DiffOptions> = {}, signal?: AbortSignal): Promise<DiffResult> =>
  compareTrees(localSource(L, "/"), localSource(R, "/"), { ...DEFAULT_OPTIONS, ...o }, ctl(signal));
const by = (r: DiffResult) => Object.fromEntries(r.rows.map((x) => [x.p, x]));

function fixture() {
  L = fs.mkdtempSync(path.join(tmp, "L-"));
  R = fs.mkdtempSync(path.join(tmp, "R-"));
  // identical (content and time)
  write(L, "same.txt", "same", T0);
  write(R, "same.txt", "same", T0);
  // same size, different content, left newer
  write(L, "diff.txt", "AAAA", T0 + 60_000);
  write(R, "diff.txt", "BBBB", T0);
  // different size, right newer
  write(L, "size.txt", "short", T0);
  write(R, "size.txt", "much longer", T0 + 60_000);
  // same content, different mtime (touched copy)
  write(L, "touched.txt", "payload", T0 + 120_000);
  write(R, "touched.txt", "payload", T0);
  // same size and mtime but different content: quick mode cannot see it
  write(L, "sneaky.txt", "1111", T0);
  write(R, "sneaky.txt", "2222", T0);
  write(L, "only-left.txt", "l", T0);
  write(R, "only-right.txt", "r", T0);
  // nested dirs
  write(L, "dir-same/a.txt", "x", T0);
  write(R, "dir-same/a.txt", "x", T0);
  write(L, "dir-diff/deep/f.txt", "1", T0);
  write(R, "dir-diff/deep/f.txt", "2", T0);
  write(L, "dir-ol/f.txt", "1", T0);
  write(R, "dir-r-only/f.txt", "1", T0);
  // type mismatch
  write(L, "mixed", "file", T0);
  fs.mkdirSync(path.join(R, "mixed"));
  // case, hidden, excluded
  write(L, "Case.TXT", "c", T0);
  write(R, "case.txt", "c", T0);
  write(L, ".hidden", "h", T0);
  write(L, "junk.log", "j", T0);
  write(L, "node_modules/x/y.js", "j", T0);
}

test("content mode: all statuses, nested aggregation, newer side", async () => {
  fixture();
  const r = await run({ mode: "content", exclude: ["*.log", "node_modules/"], ignoreCase: false });
  const m = by(r);
  assert.equal(m["same.txt"]?.status, "identical");
  assert.equal(m["diff.txt"]?.status, "different");
  assert.equal(m["diff.txt"]?.why, "content");
  assert.equal(m["diff.txt"]?.newer, "left");
  assert.equal(m["size.txt"]?.newer, "right");
  assert.equal(m["touched.txt"]?.status, "identical"); // content equal wins over mtime
  assert.equal(m["sneaky.txt"]?.status, "different"); // content mode sees it
  assert.equal(m["only-left.txt"]?.status, "left-only");
  assert.equal(m["only-right.txt"]?.status, "right-only");
  assert.equal(m["dir-same"]?.status, "identical");
  assert.equal(m["dir-diff"]?.status, "different");
  assert.equal(m["dir-diff/deep"]?.status, "different");
  assert.equal(m["dir-diff/deep/f.txt"]?.status, "different");
  assert.equal(m["dir-ol"]?.status, "left-only");
  assert.equal(m["dir-ol/f.txt"]?.status, "left-only");
  assert.equal(m["dir-r-only"]?.status, "right-only");
  assert.equal(m["mixed"]?.status, "different");
  assert.equal(m["mixed"]?.why, "type");
  assert.equal(m["Case.TXT"]?.status, "left-only"); // case-sensitive by default
  assert.equal(m["case.txt"]?.status, "right-only");
  assert.ok(m[".hidden"]);
  assert.ok(!m["junk.log"] && !m["node_modules"] && !m["node_modules/x/y.js"]);
  // only files with equal size were hashed (diff, touched, sneaky, same, dir files...)
  assert.ok(r.hashedFiles >= 4);
  assert.ok(r.files.different >= 3 && r.files.leftOnly >= 2);
  assert.ok(r.dirs.identical >= 1 && r.dirs.different >= 2);
});

test("quick mode only hashes when size matches and mtime differs", async () => {
  fixture();
  const r = await run({ mode: "quick" });
  const m = by(r);
  assert.equal(m["sneaky.txt"]?.status, "identical"); // documented trade-off
  assert.equal(m["touched.txt"]?.status, "identical"); // hashed, equal
  assert.equal(m["diff.txt"]?.status, "different");
  assert.equal(r.hashedFiles, 2); // only diff.txt and touched.txt: same size, mtime apart
});

test("name, size and mtime modes never hash", async () => {
  fixture();
  const name = await run({ mode: "name" });
  assert.equal(name.hashedFiles, 0);
  assert.equal(by(name)["diff.txt"]?.status, "identical");
  assert.equal(by(name)["mixed"]?.status, "different"); // type still differs
  const size = await run({ mode: "size" });
  assert.equal(size.hashedFiles, 0);
  assert.equal(by(size)["diff.txt"]?.status, "identical");
  assert.equal(by(size)["size.txt"]?.status, "different");
  const mt = await run({ mode: "mtime", toleranceMs: 30_000 });
  assert.equal(mt.hashedFiles, 0);
  assert.equal(by(mt)["diff.txt"]?.status, "different");
  assert.equal(by(mt)["touched.txt"]?.status, "different");
  assert.equal(by(mt)["same.txt"]?.status, "identical");
  const wide = await run({ mode: "mtime", toleranceMs: 600_000 });
  assert.equal(by(wide)["diff.txt"]?.status, "identical");
});

test("ignore case, ignore hidden, include and exclude globs", async () => {
  fixture();
  const m = by(await run({ mode: "name", ignoreCase: true, ignoreHidden: true, include: ["*.txt"], exclude: ["dir-*/"] }));
  assert.equal(m["Case.TXT"]?.status, "identical");
  assert.ok(!m["case.txt"]);
  assert.ok(!m[".hidden"]);
  assert.ok(!m["junk.log"]); // not in include
  assert.ok(!m["dir-same"] && !m["dir-diff"]);
  assert.ok(m["only-left.txt"]);
});

test("depth limit is reported; there is no entry cap", async () => {
  fixture();
  const shallow = await run({ mode: "name", depth: 1 });
  assert.ok(!shallow.rows.some((r) => r.p.includes("/")));
  assert.ok(shallow.warnings.some((w) => /deeper than 1/.test(w)));
  for (let i = 0; i < 3000; i++) write(L, `many/f${i}.txt`, "x", T0);
  const all = await run({ mode: "name", dirConcurrency: 3 });
  assert.equal(all.rows.filter((r) => r.p.startsWith("many/")).length, 3000);
  assert.equal(by(all)["many"]?.status, "left-only");
  assert.ok(!all.warnings.some((w) => /entries/.test(w)));
});

test("unreadable hash target becomes an error row, not a failed job", async () => {
  fixture();
  const flaky = localSource(L, "/");
  const bad = { ...flaky, hash: async (rel: string) => { if (rel === "diff.txt") throw new Error("boom"); return flaky.hash(rel, new AbortController().signal); } };
  const r = await compareTrees(bad, localSource(R, "/"), { ...DEFAULT_OPTIONS, mode: "content" }, ctl());
  assert.equal(by(r)["diff.txt"]?.status, "error");
  assert.equal(by(r)["diff.txt"]?.why, "boom");
  assert.equal(r.files.error, 1);
});

test("cancel stops the comparison", async () => {
  fixture();
  const ac = new AbortController();
  const src = localSource(L, "/");
  const slow = { ...src, hash: async (rel: string, s: AbortSignal) => { ac.abort(); return src.hash(rel, s); } };
  await assert.rejects(compareTrees(slow, localSource(R, "/"), { ...DEFAULT_OPTIONS, mode: "content" }, ctl(ac.signal)));
  const jobs = new Jobs(1);
  const j = jobs.create("folderdiff", "t", (c) => compareTrees(localSource(L, "/"), localSource(R, "/"), { ...DEFAULT_OPTIONS, mode: "content" }, c));
  jobs.cancel(j.id);
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(["canceled", "done"].includes(jobs.get(j.id)?.state ?? ""));
});

// ---------------------------------------------------------------- sync primitives and hub job

test("copy overwrite replaces atomically, keeps name, can preserve times; default still renames", async () => {
  const a = fs.mkdtempSync(path.join(tmp, "cp-a-"));
  const b = fs.mkdtempSync(path.join(tmp, "cp-b-"));
  write(a, "f.txt", "new", T0);
  write(b, "f.txt", "old", T0 + 99_000);
  const va = "/" + path.relative(tmp, a);
  const vb = "/" + path.relative(tmp, b);
  const post = (body: unknown) => agent.request("/api/fs/copy", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  assert.equal((await post({ from: [va + "/f.txt"], toDir: vb })).status, 200);
  assert.equal(fs.readFileSync(path.join(b, "f.txt"), "utf8"), "old"); // untouched
  assert.ok(fs.existsSync(path.join(b, "f (copy).txt")));
  fs.rmSync(path.join(b, "f (copy).txt"));
  const r = await post({ from: [va + "/f.txt"], toDir: vb, overwrite: true, preserveTimes: true });
  assert.equal(r.status, 200);
  assert.equal(fs.readFileSync(path.join(b, "f.txt"), "utf8"), "new");
  assert.equal(Math.floor(fs.statSync(path.join(b, "f.txt")).mtimeMs / 1000), T0 / 1000);
  assert.deepEqual(fs.readdirSync(b), ["f.txt"]);
  // file replaced by a directory of the same name
  write(a, "g/h.txt", "dir", T0);
  write(b, "g", "was a file", T0);
  assert.equal((await post({ from: [va + "/g"], toDir: vb, overwrite: true })).status, 200);
  assert.equal(fs.readFileSync(path.join(b, "g/h.txt"), "utf8"), "dir");
  assert.equal((await post({ from: ["/../x"], toDir: vb, overwrite: true })).status, 400);
});

let hubUrl: string, srvs: ReturnType<typeof serve>[] = [], rootA: string, rootB: string;
const open = (app: { fetch: never }) => new Promise<ReturnType<typeof serve>>((res) => { const s: ReturnType<typeof serve> = serve({ fetch: app.fetch, port: 0 }, () => res(s)); });
const portOf = (s: ReturnType<typeof serve>) => (s.address() as AddressInfo).port;

test("hub: folder diff job across two nodes with agent-side hashing, then cross-node sync", async () => {
  rootA = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "filedeck-hub-a-")));
  rootB = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "filedeck-hub-b-")));
  write(rootA, "t/same.bin", "0123456789", T0);
  write(rootB, "u/same.bin", "0123456789", T0 + 50_000);
  write(rootA, "t/diff.bin", "AAAAAAAAAA", T0);
  write(rootB, "u/diff.bin", "BBBBBBBBBB", T0 + 50_000);
  write(rootA, "t/only/a.txt", "a", T0);
  const sa = await open(createAgent(loadConfig({ FILEDECK_ROOT: rootA, FILEDECK_NODE: "A" } as never)) as never);
  const sb = await open(createAgent(loadConfig({ FILEDECK_ROOT: rootB, FILEDECK_NODE: "B" } as never)) as never);
  const sh = await open(createHub(loadConfig({ FILEDECK_MODE: "hub", FILEDECK_STATIC: tmp, NODES: `A=http://127.0.0.1:${portOf(sa)},B=http://127.0.0.1:${portOf(sb)}` } as never)) as never);
  srvs.push(sa, sb, sh);
  hubUrl = `http://127.0.0.1:${portOf(sh)}`;
  const post = (p: string, body: unknown) => fetch(hubUrl + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  const bad = await post("/api/diff/jobs", { left: { node: "nope", path: "/t" }, right: { node: "B", path: "/u" } });
  assert.equal(bad.status, 404);
  assert.equal((await post("/api/diff/jobs", { left: { node: "A", path: "t" }, right: { node: "B", path: "/u" } })).status, 400);
  assert.equal((await post("/api/diff/jobs", { left: { node: "A", path: "/t" }, right: { node: "B", path: "/u" }, options: { mode: "x" } })).status, 400);

  const start = await post("/api/diff/jobs", { left: { node: "A", path: "/t" }, right: { node: "B", path: "/u" }, options: { mode: "content" } });
  assert.equal(start.status, 202);
  const { id } = (await start.json()) as { id: string };
  let state = "";
  for (let i = 0; i < 100 && state !== "done"; i++) {
    state = ((await (await fetch(`${hubUrl}/api/diff/jobs/${id}`)).json()) as { state: string }).state;
    if (state === "failed") assert.fail("job failed: " + JSON.stringify(await (await fetch(`${hubUrl}/api/diff/jobs/${id}`)).json()));
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.equal(state, "done");
  const res = (await (await fetch(`${hubUrl}/api/diff/jobs/${id}/result`)).json()) as DiffResult;
  const m = by(res);
  assert.equal(m["same.bin"]?.status, "identical");
  assert.equal(m["diff.bin"]?.status, "different");
  assert.equal(m["diff.bin"]?.newer, "right");
  assert.equal(m["only"]?.status, "left-only");
  assert.equal(res.hashedFiles, 2);
  assert.equal((await fetch(`${hubUrl}/api/diff/jobs/${id}`).then((r) => r.json()) as { result?: unknown }).result, undefined); // status view stays small

  // cross-node sync of one file with overwrite + preserved mtime
  const t = await post("/api/transfer", { src: { node: "A", path: "/t/diff.bin" }, dst: { node: "B", dir: "/u" }, op: "copy" });
  assert.equal(t.status, 409); // default: refuses to overwrite
  const t2 = await post("/api/transfer", { src: { node: "A", path: "/t/diff.bin" }, dst: { node: "B", dir: "/u" }, op: "copy", overwrite: true, preserveTimes: true });
  assert.equal(t2.status, 201);
  assert.equal(fs.readFileSync(path.join(rootB, "u/diff.bin"), "utf8"), "AAAAAAAAAA");
  assert.equal(Math.floor(fs.statSync(path.join(rootB, "u/diff.bin")).mtimeMs), T0);

  // cancel + dismiss
  const big = await post("/api/diff/jobs", { left: { node: "A", path: "/t" }, right: { node: "B", path: "/u" } });
  const bid = ((await big.json()) as { id: string }).id;
  const c = await post(`/api/diff/jobs/${bid}/cancel`, {});
  assert.equal(c.status, 200);
  assert.equal((await fetch(`${hubUrl}/api/diff/jobs/nope`)).status, 404);
  assert.equal((await fetch(`${hubUrl}/api/diff/jobs/nope/result`)).status, 404);
});

after(() => {
  for (const s of srvs) s.close();
  for (const d of [rootA, rootB]) if (d) fs.rmSync(d, { recursive: true, force: true });
});
