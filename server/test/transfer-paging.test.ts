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
import { ChildListError, listChildren } from "../src/child-list.ts";
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
  const S = memNode({ "/a": { type: "file", data: "a" }, "/a2": { type: "file", data: "a" }, "/b": { type: "file", data: "b" }, "/c": { type: "file", data: "c" } }, { slow: (op) => (op === "download" ? nap(1) : Promise.resolve()) });
  const D = memNode({ "/in": { type: "dir" } });
  const gate: Target = {
    fetch: async (rest, init) => {
      if (rest.startsWith("/api/fs/upload") && /name=a(&|$)/.test(rest)) await hold;
      return D.t.fetch(rest, init);
    },
  };
  const q = mkq({ S: S.t, D: gate }, 1);
  const first = q.create({ op: "copy", items: [{ node: "S", path: "/a" }, { node: "S", path: "/a2" }], dst: { node: "D", dir: "/in" }, conflict: "ask" });
  await nap(30);
  q.pause(first.id);
  const second = q.create(cp("copy", "/b"));
  // the first job is parked inside an upload; it reaches its next checkpoint (between items) when the upload ends, and gives the slot up there.
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
let A: string, B: string, hub: string, urlA: string, urlB: string;
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
  urlA = `http://127.0.0.1:${portOf(sa)}`;
  urlB = `http://127.0.0.1:${portOf(sb)}`;
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

// ---- listings that did not reach their end
const walkBody = (...lines: unknown[]) => async () => new Response(lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
const never = (r: Response) => Promise.resolve(new Error(String(r.status)));
const list = (body: () => Promise<Response>) => listChildren(body, "/d", undefined, never);

test("listChildren refuses a listing with read errors, an error line, or no end", async () => {
  const ok = await list(walkBody({ e: [{ p: "a", t: "file", s: 1, m: 1 }, { p: "x/y", t: "file", s: 1, m: 1 }] }, { done: { truncated: false, errors: 0 } }));
  assert.deepEqual(ok.entries.map((e) => e.name), ["a"], "a name with a slash is dropped");
  await assert.rejects(list(walkBody({ e: [] }, { done: { truncated: false, errors: 2 } })), ChildListError);
  await assert.rejects(list(walkBody({ e: [{ p: "a", t: "file", s: 1, m: 1 }] }, { error: "boom" })), ChildListError);
  await assert.rejects(list(walkBody({ e: [{ p: "a", t: "file", s: 1, m: 1 }] })), ChildListError);
});

const unreadable = process.getuid?.() === 0 ? { skip: "root reads every folder" } : {};
const seed = (name: string) => {
  fs.mkdirSync(path.join(A, name, "sub"), { recursive: true });
  fs.writeFileSync(path.join(A, name, "a.txt"), "a");
  fs.writeFileSync(path.join(A, name, "sub/secret.txt"), "s");
  fs.chmodSync(path.join(A, name, "sub"), 0o300);
};
const unseed = (name: string) => {
  try {
    fs.chmodSync(path.join(A, name, "sub"), 0o700);
  } catch {
    /* gone */
  }
};
const viaQueue = async (op: "copy" | "move", from: string) => {
  const q = new OpQueue({ agents: new Map<string, Target>([["A", { fetch: (x, i) => agentFetch(urlA + x, i) }], ["B", { fetch: (x, i) => agentFetch(urlB + x, i) }]]), isSource: () => false });
  return settle(q, q.create({ op, items: [{ node: "A", path: from }], dst: { node: "B", dir: "/in" }, conflict: "ask" }).id);
};

for (const op of ["copy", "move"] as const) {
  test(`/api/transfer ${op}: a folder with an unreadable subfolder fails and the source stays`, unreadable, async () => {
    const name = `u-t-${op}`;
    seed(name);
    try {
      fs.mkdirSync(path.join(B, "in"), { recursive: true });
      const r = await transfer({ src: { node: "A", path: "/" + name }, dst: { node: "B", dir: "/in" }, op });
      assert.equal(r.status, 502, await r.clone().text());
      assert.ok(fs.existsSync(path.join(A, name, "a.txt")), "source kept");
      assert.equal(fs.readdirSync(path.join(A)).filter((n) => n.startsWith(".")).length, 0, "nothing went to the trash");
    } finally {
      unseed(name);
    }
  });
  test(`job queue ${op}: a folder with an unreadable subfolder fails the item and the source stays`, unreadable, async () => {
    const name = `u-q-${op}`;
    seed(name);
    try {
      fs.mkdirSync(path.join(B, "in"), { recursive: true });
      const v = await viaQueue(op, "/" + name);
      assert.equal(v.state, "failed", JSON.stringify(v));
      assert.match(v.items?.[0]?.error ?? "", /could not be read/);
      assert.ok(fs.existsSync(path.join(A, name, "a.txt")), "source kept");
    } finally {
      unseed(name);
    }
  });
}

// ---- connection failures, slots, links
test("a refused connection fails the job by node name and shows no address", async () => {
  const dead = http.createServer();
  await new Promise<void>((r) => dead.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(dead.address() as AddressInfo).port}`;
  await new Promise((r) => dead.close(r));
  const gone: Target = { fetch: (x, i) => agentFetch(url + x, i) };
  const D = memNode({ "/in": { type: "dir" } });
  const q = mkq({ S: gone, D: D.t });
  const spec: OpSpec = { op: "copy", items: [{ node: "S", path: "/a" }, { node: "S", path: "/b" }], dst: { node: "D", dir: "/in" }, conflict: "ask" };
  const v = await settle(q, q.create(spec).id);
  const all = JSON.stringify(v);
  assert.match(all, /agent unreachable \(S\)/);
  assert.ok(!all.includes("127.0.0.1") && !all.includes("ECONNREFUSED"), all);
});

const slotRig = () => {
  const holds = new Map<string, () => void>();
  const t: Target = {
    async fetch(rest) {
      const u = new URL("http://x" + rest);
      const p = u.searchParams.get("path") ?? "";
      const op = u.pathname.split("/").pop();
      if (op === "stat") return p.startsWith("/in/") ? new Response("{}", { status: 404 }) : Response.json({ type: "file", size: 1, mtime: 1 });
      if (op === "download") {
        await new Promise<void>((r) => holds.set(p, r));
        return new Response("x");
      }
      return Response.json({ ok: true }, { status: 201 });
    },
  };
  const q = new OpQueue({ agents: new Map([["S", t], ["D", t]]), isSource: () => false, concurrency: 1 });
  const priv = q as unknown as { jobs: Map<string, { holdsSlot?: boolean }>; running: number; ctx(j: unknown): { checkpoint(): Promise<void> } };
  const mk = (p: string) => q.create({ op: "copy", items: [{ node: "S", path: p }], dst: { node: "D", dir: "/in" }, conflict: "ask" }).id;
  return { holds, q, priv, mk };
};

test("two checkpoints of one job waiting together take one slot, and the queue is idle afterwards", async () => {
  const { holds, q, priv, mk } = slotRig();
  const a = mk("/a");
  await nap(30);
  const b = mk("/b");
  await nap(30);
  const ja = priv.jobs.get(a)!;
  q.pause(a);
  const c = priv.ctx(ja);
  const p1 = c.checkpoint();
  const p2 = c.checkpoint(); // as a parked stream and a retry would
  await nap(30);
  assert.equal(q.get(b)!.state, "running", "the paused job gave its slot away");
  q.resume(a);
  await nap(20);
  holds.get("/b")?.();
  await nap(50);
  assert.equal(q.get(b)!.state, "done");
  holds.get("/a")?.();
  await Promise.all([p1, p2]);
  await settle(q, a);
  assert.equal(priv.running, 0, "no slot is left over");
  const cId = mk("/c");
  await nap(20);
  assert.equal(q.get(cId)!.state, "running", "a new job still starts");
  holds.get("/c")?.();
  await settle(q, cId);
});

test("a resumed job gets the freed slot before a queued job", async () => {
  const { holds, q, priv, mk } = slotRig();
  const a = mk("/a");
  await nap(30);
  const b = mk("/b");
  const ja = priv.jobs.get(a)!;
  q.pause(a);
  const pa = priv.ctx(ja).checkpoint(); // a parks and frees the only slot: b starts
  await nap(30);
  assert.equal(q.get(b)!.state, "running");
  const c = mk("/c");
  q.resume(a);
  await nap(20);
  holds.get("/b")?.();
  await nap(50);
  assert.equal(ja.holdsSlot, true, "handed straight to the resumed job");
  assert.equal(q.get(c)!.state, "queued");
  await pa;
  holds.get("/a")?.();
  await settle(q, a);
  holds.get("/c")?.();
  await settle(q, c);
  assert.equal(priv.running, 0);
});

test("a link moved to another node is refused and nothing is removed; a copy still works", async () => {
  const S = memNode({ "/real": { type: "dir" }, "/real/f": { type: "file", data: "f" }, "/ln": { type: "symlink", linkDir: true } });
  const D = memNode({ "/in": { type: "dir" } });
  const q = mkq({ S: S.t, D: D.t });
  const v = await settle(q, q.create(cp("move", "/ln")).id);
  assert.equal(v.state, "failed", JSON.stringify(v));
  assert.match(v.items?.[0]?.error ?? "", /link cannot be moved/);
  assert.ok(S.fsm.has("/ln") && S.fsm.has("/real/f"));
  assert.ok(!S.calls.some((c) => c.startsWith("trash")), "nothing was trashed");
});

test("/api/transfer: moving a link is refused and the link stays", async () => {
  fs.mkdirSync(path.join(A, "lk-real"), { recursive: true });
  fs.writeFileSync(path.join(A, "lk-real/f"), "f");
  fs.symlinkSync("lk-real", path.join(A, "lk-top"));
  const r = await transfer({ src: { node: "A", path: "/lk-top" }, dst: { node: "B", dir: "/in" }, op: "move" });
  assert.equal(r.status, 400, await r.clone().text());
  assert.ok(fs.lstatSync(path.join(A, "lk-top")).isSymbolicLink());
  assert.ok(!fs.existsSync(path.join(B, "in/lk-top")));
});

// ---- the concurrency limit holds when resumed jobs wait and one of them is canceled
for (const conc of [1, 2]) {
  test(`concurrency ${conc}: never more jobs move data than the limit, with resumed jobs waiting and one canceled`, async () => {
    const stamp = new Map<string, number>();
    let most = 0;
    const t: Target = {
      async fetch(rest, init) {
        const u = new URL("http://x" + rest);
        const p = u.searchParams.get("path") ?? "";
        const op = u.pathname.split("/").pop();
        if (op === "stat") return p.startsWith("/in/") ? new Response("{}", { status: 404 }) : Response.json({ type: "file", size: 100, mtime: 1 });
        if (op === "download") {
          let n = 0;
          return new Response(
            new ReadableStream({
              async pull(c) {
                await nap(4);
                if (n++ >= 150) return c.close();
                c.enqueue(new Uint8Array([65]));
                return undefined;
              },
            }),
          );
        }
        if (op === "upload") {
          const name = "/" + u.searchParams.get("name")!;
          const rd = (init?.body as ReadableStream).getReader();
          for (;;) {
            const r = await rd.read(); // a chunk only arrives while the job runs: pull passes its checkpoint first
            if (r.done) break;
            const now = Date.now();
            stamp.set(name, now);
            most = Math.max(most, [...stamp.values()].filter((at) => now - at < 25).length);
          }
          return Response.json({}, { status: 201 });
        }
        return Response.json({ ok: true });
      },
    };
    const q = new OpQueue({ agents: new Map([["S", t], ["D", t]]), isSource: () => false, concurrency: conc });
    const priv = q as unknown as { jobs: Map<string, { holdsSlot?: boolean; abort: AbortController }>; running: number };
    const mk = (p: string) => q.create({ op: "copy", items: [{ node: "S", path: p }], dst: { node: "D", dir: "/in" }, conflict: "ask" }).id;
    const over: string[] = [];
    const watch = setInterval(() => {
      const holders = [...priv.jobs.values()].filter((j) => j.holdsSlot && !j.abort.signal.aborted).length;
      if (holders > conc) over.push(`holders ${holders}`);
    }, 0);
    try {
      // B and C each run alone for a moment, are paused (which frees the slot) and parked
      const parked: string[] = [];
      for (const n of ["b", "c"]) {
        const id = mk("/" + n);
        await nap(40);
        q.pause(id);
        parked.push(id);
        await nap(40);
      }
      const fillers = Array.from({ length: conc }, (_, i) => mk(`/f${i}`));
      await nap(40);
      for (const id of parked) q.resume(id); // both wait: the queue is full
      await nap(30);
      q.cancel(parked[0]!);
      await nap(150);
      assert.deepEqual(over, [], "holders never exceed the limit");
      stamp.clear();
      most = 0;
      await nap(150);
      assert.ok(most <= conc, `${most} jobs moved data at once, limit ${conc}`);
      for (const id of [...fillers, parked[1]!]) q.cancel(id);
      for (const id of [...fillers, ...parked]) await settle(q, id, 6000);
      assert.equal(priv.running, 0, "no slot is left over");
      assert.deepEqual(over, []);
    } finally {
      clearInterval(watch);
    }
  });
}
