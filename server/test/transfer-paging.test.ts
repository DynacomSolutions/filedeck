import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import { createAgent } from "../src/agent.ts";
import { createHub } from "../src/hub.ts";
import { loadConfig } from "../src/config.ts";
import { agentFetch } from "../src/agent-fetch.ts";
import { OpQueue, type OpSpec, type OpView } from "../src/ops-queue.ts";
import type { Target } from "../src/hub.ts";

const nap = (ms: number) => new Promise((r) => setTimeout(r, ms));
const finished = (v: OpView) => ["done", "failed", "canceled"].includes(v.state);
const settle = async (q: OpQueue, id: string, ms = 4000) => {
  for (const t0 = Date.now(); !finished(q.get(id)!); ) {
    if (Date.now() - t0 > ms) assert.fail(`timeout: ${JSON.stringify(q.get(id))}`);
    await nap(5);
  }
  return q.get(id)!;
};

type Node = { type: "dir" } | { type: "file"; data: string } | { type: "symlink"; linkDir?: boolean; broken?: boolean };

/** A node held in memory. Its page listing stops after `page` entries, as a real node's stops at 20 000. */
function memNode(tree: Record<string, Node>, opts: { page?: number; slow?: (op: string) => Promise<unknown> } = {}) {
  const fsm = new Map<string, Node>(Object.entries(tree));
  const calls: string[] = [];
  const kids = (dir: string) => [...fsm.keys()].filter((k) => k !== dir && path.posix.dirname(k) === dir).sort();
  const t: Target = {
    async fetch(rest, init) {
      const u = new URL("http://x" + rest);
      const p = u.searchParams.get("path") ?? "";
      const op = u.pathname.split("/").pop()!;
      calls.push(`${op} ${p || u.searchParams.get("name") || ""}`);
      await opts.slow?.(op);
      if (op === "stat") {
        const n = fsm.get(p);
        if (!n) return new Response("{}", { status: 404 });
        return Response.json({ name: path.posix.basename(p), path: p, ...n, size: n.type === "file" ? n.data.length : 0, mtime: 1 });
      }
      if (op === "list") {
        const all = kids(p);
        return Response.json({ path: p, entries: all.slice(0, opts.page ?? 1e9).map((k) => ({ name: path.posix.basename(k), path: k, type: fsm.get(k)!.type, size: 1, mtime: 1 })), truncated: all.length > (opts.page ?? 1e9) });
      }
      if (op === "walk") {
        const e = kids(p).map((k) => ({ p: path.posix.basename(k), t: fsm.get(k)!.type, s: 1, m: 1 }));
        return new Response(JSON.stringify({ e }) + "\n" + JSON.stringify({ done: { truncated: false, depthLimited: false, errors: 0 } }) + "\n");
      }
      if (op === "download") {
        const n = fsm.get(p)?.type === "symlink" ? fsm.get("/real") : fsm.get(p); // a link reads as its target
        return n?.type === "file" ? new Response(n.data, { headers: { "content-length": String(n.data.length) } }) : new Response("{}", { status: 404 });
      }
      if (op === "upload") {
        const dir = u.searchParams.get("dir")!;
        const name = u.searchParams.get("name")!;
        fsm.set((dir === "/" ? "" : dir) + "/" + name, { type: "file", data: await new Response(init?.body as never).text() });
        return Response.json({ path: dir + "/" + name }, { status: 201 });
      }
      const body = JSON.parse((init?.body as string) ?? "{}") as { path?: string; paths?: string[] };
      if (op === "mkdir") fsm.set(body.path!, { type: "dir" });
      if (op === "trash" || op === "delete") for (const x of body.paths!) for (const k of [...fsm.keys()]) if (k === x || k.startsWith(x + "/")) fsm.delete(k);
      return Response.json({ ok: true });
    },
  };
  return { t, fsm, calls };
}
const mkq = (agents: Record<string, Target>, concurrency?: number) => new OpQueue({ agents: new Map(Object.entries(agents)), isSource: () => false, concurrency });
const cp = (op: "copy" | "move", from: string, to = "/in"): OpSpec => ({ op, items: [{ node: "S", path: from }], dst: { node: "D", dir: to }, conflict: "ask" });
const files = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`/big/f${i}`, { type: "file", data: "x" } as Node]));

test("a folder with more entries than one list page is copied whole", async () => {
  const S = memNode({ "/big": { type: "dir" }, ...files(7) }, { page: 3 });
  const D = memNode({ "/in": { type: "dir" } });
  const q = mkq({ S: S.t, D: D.t });
  const v = await settle(q, q.create(cp("copy", "/big")).id);
  assert.equal(v.state, "done", JSON.stringify(v));
  assert.deepEqual([...D.fsm.keys()].filter((k) => k.startsWith("/in/big/")).length, 7);
});

test("a move of such a folder removes the source only after every entry arrived", async () => {
  const S = memNode({ "/big": { type: "dir" }, ...files(6) }, { page: 2 });
  const D = memNode({ "/in": { type: "dir" } });
  const q = mkq({ S: S.t, D: D.t });
  const v = await settle(q, q.create(cp("move", "/big")).id);
  assert.equal(v.state, "done");
  assert.equal([...D.fsm.keys()].filter((k) => k.startsWith("/in/big/")).length, 6);
  assert.ok(![...S.fsm.keys()].some((k) => k.startsWith("/big")), "source removed");
});

test("a move that left links behind keeps the source and says so", async () => {
  const S = memNode({ "/d": { type: "dir" }, "/d/a": { type: "file", data: "a" }, "/d/ln": { type: "symlink" } });
  const D = memNode({ "/in": { type: "dir" } });
  const q = mkq({ S: S.t, D: D.t });
  const v = await settle(q, q.create(cp("move", "/d")).id);
  assert.ok(S.fsm.has("/d/a"), "source kept");
  assert.ok(D.fsm.has("/in/d/a"));
  assert.equal(v.counts.skipped, 1, JSON.stringify(v));
  assert.match(v.items?.[0]?.note ?? "", /1 item skipped; the source was kept/);
});

test("a link chosen by name is followed; a broken one fails that item with a reason", async () => {
  const S = memNode({ "/ln": { type: "symlink" }, "/gone": { type: "symlink", broken: true } });
  S.fsm.set("/real", { type: "file", data: "hello" });
  const D = memNode({ "/in": { type: "dir" } });
  const q = mkq({ S: S.t, D: D.t });
  const spec: OpSpec = { op: "copy", items: [{ node: "S", path: "/ln" }, { node: "S", path: "/gone" }], dst: { node: "D", dir: "/in" }, conflict: "ask" };
  const v = await settle(q, q.create(spec).id);
  assert.equal(v.counts.done, 1);
  assert.equal(v.counts.failed, 1);
  assert.match(v.items?.[1]?.error ?? "", /points at nothing/);
});

test("one item that cannot be read does not fail the whole job", async () => {
  const S = memNode({ "/a": { type: "file", data: "a" }, "/b": { type: "file", data: "b" } });
  let bad = true;
  const wrapped: Target = {
    fetch(rest, init) {
      if (bad && rest.startsWith("/api/fs/stat?path=%2Fa")) {
        bad = false;
        return Promise.reject(new TypeError("fetch failed"));
      }
      return S.t.fetch(rest, init);
    },
  };
  const D = memNode({ "/in": { type: "dir" } });
  const q = mkq({ S: wrapped, D: D.t });
  const spec: OpSpec = { op: "copy", items: [{ node: "S", path: "/a" }, { node: "S", path: "/b" }], dst: { node: "D", dir: "/in" }, conflict: "ask" };
  const v = await settle(q, q.create(spec).id);
  assert.equal(v.state, "done", JSON.stringify(v));
  assert.ok(D.fsm.has("/in/a") && D.fsm.has("/in/b"));
});

test("a paused job gives its concurrency slot to a queued one, and takes one again on resume", async () => {
  let release!: () => void;
  const hold = new Promise<void>((r) => (release = r));
  const S = memNode({ "/a": { type: "file", data: "a" }, "/b": { type: "file", data: "b" }, "/c": { type: "file", data: "c" } }, { slow: (op) => (op === "download" ? nap(1) : Promise.resolve()) });
  const D = memNode({ "/in": { type: "dir" } });
  const gate: Target = {
    fetch: async (rest, init) => {
      if (rest.startsWith("/api/fs/upload") && rest.includes("name=a")) await hold;
      return D.t.fetch(rest, init);
    },
  };
  const q = mkq({ S: S.t, D: gate }, 1);
  const first = q.create(cp("copy", "/a"));
  await nap(30);
  q.pause(first.id);
  const second = q.create(cp("copy", "/b"));
  // the first job is parked inside an upload; it hits its checkpoint when the data moves on. Pause takes effect at the next one.
  release();
  const v2 = await settle(q, second.id);
  assert.equal(v2.state, "done", "the queued job ran although the paused one holds the only slot's place");
  q.resume(first.id);
  const v1 = await settle(q, first.id);
  assert.equal(v1.state, "done");
});

test("agentFetch: a slow answer, a streamed body and an abort", async () => {
  const srv = http.createServer((req, res) => {
    if (req.url === "/slow") return void setTimeout(() => res.end("late"), 300);
    if (req.url === "/hang") return;
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => res.writeHead(201, { "x-echo": req.headers["x-in"] ?? "" }).end(Buffer.concat(chunks)));
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  try {
    assert.equal(await (await agentFetch(base + "/slow")).text(), "late");
    const body = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new TextEncoder().encode("ab")); c.enqueue(new TextEncoder().encode("cd")); c.close(); } });
    const r = await agentFetch(base + "/echo", { method: "PUT", body, headers: { "x-in": "v" }, duplex: "half" } as RequestInit);
    assert.equal(r.status, 201);
    assert.equal(r.headers.get("x-echo"), "v");
    assert.equal(await r.text(), "abcd");
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 50);
    await assert.rejects(agentFetch(base + "/hang", { signal: ac.signal }), (e: Error) => e.name === "AbortError");
  } finally {
    srv.closeAllConnections();
    srv.close();
  }
});

// ---- the hub's own /api/transfer, with real agents
const srvs: ReturnType<typeof serve>[] = [];
let A: string, B: string, hub: string;
const open = (app: { fetch: never }) => new Promise<ReturnType<typeof serve>>((res) => { const s: ReturnType<typeof serve> = serve({ fetch: app.fetch, port: 0 }, () => res(s)); });
const portOf = (s: ReturnType<typeof serve>) => (s.address() as AddressInfo).port;
const transfer = (body: unknown) => fetch(hub + "/api/transfer", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

before(async () => {
  A = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "filedeck-tp-a-")));
  B = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "filedeck-tp-b-")));
  const sa = await open(createAgent(loadConfig({ FILEDECK_ROOT: A, FILEDECK_NODE: "A" } as never)) as never);
  const sb = await open(createAgent(loadConfig({ FILEDECK_ROOT: B, FILEDECK_NODE: "B" } as never)) as never);
  const sh = await open(createHub(loadConfig({ FILEDECK_MODE: "hub", FILEDECK_STATIC: A, NODES: `A=http://127.0.0.1:${portOf(sa)},B=http://127.0.0.1:${portOf(sb)}` } as never)) as never);
  srvs.push(sa, sb, sh);
  hub = `http://127.0.0.1:${portOf(sh)}`;
});
after(() => {
  for (const s of srvs) s.close();
  for (const d of [A, B]) if (d) fs.rmSync(d, { recursive: true, force: true });
});

test("/api/transfer: a move with a link inside keeps the source; a copy reports the skipped link", async () => {
  fs.mkdirSync(path.join(A, "t1"));
  fs.writeFileSync(path.join(A, "t1/a.txt"), "alpha");
  fs.symlinkSync("a.txt", path.join(A, "t1/ln"));
  fs.mkdirSync(path.join(B, "in"), { recursive: true });
  const c = await transfer({ src: { node: "A", path: "/t1" }, dst: { node: "B", dir: "/in" }, op: "copy" });
  assert.equal(c.status, 201);
  assert.equal(((await c.json()) as { skipped?: number }).skipped, 1);
  fs.rmSync(path.join(B, "in/t1"), { recursive: true });
  const m = await transfer({ src: { node: "A", path: "/t1" }, dst: { node: "B", dir: "/in" }, op: "move" });
  assert.equal(m.status, 409);
  assert.match(((await m.json()) as { error: string }).error, /source was kept/);
  assert.ok(fs.existsSync(path.join(A, "t1/a.txt")) && fs.lstatSync(path.join(A, "t1/ln")).isSymbolicLink());
  assert.equal(fs.readFileSync(path.join(B, "in/t1/a.txt"), "utf8"), "alpha");
});

test("/api/transfer: a link chosen by name transfers what it points at", async () => {
  fs.writeFileSync(path.join(A, "target.txt"), "data");
  fs.symlinkSync("target.txt", path.join(A, "top-link"));
  const r = await transfer({ src: { node: "A", path: "/top-link" }, dst: { node: "B", dir: "/in" }, op: "copy" });
  assert.equal(r.status, 201, await r.clone().text());
  assert.equal(fs.readFileSync(path.join(B, "in/top-link"), "utf8"), "data");
});
