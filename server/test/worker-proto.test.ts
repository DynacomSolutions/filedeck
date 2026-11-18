import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { Duplex, duplexPair } from "node:stream";
import { setTimeout as sleep } from "node:timers/promises";
import { getRequestListener } from "@hono/node-server";
import { Mux, WorkerGone } from "../src/worker-proto.ts";

// Errors that escape the mux (uncaught exceptions, unhandled rejections) fail the last test.
const stray: unknown[] = [];
const onStray = (e: unknown) => { stray.push(e); };
process.on("unhandledRejection", onStray);
process.on("uncaughtException", onStray);

const KiB = 1024;
const MiB = 1024 * KiB;
const muxes: Mux[] = [];
const dirs: string[] = [];
after(() => {
  for (const m of muxes) m.close();
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

type Opts = ConstructorParameters<typeof Mux>[2];
function pair(rootOpts?: Opts, workerOpts?: Opts, socks = duplexPair()) {
  const [a, b] = socks;
  const root = new Mux(a, "root", rootOpts);
  const worker = new Mux(b, "worker", workerOpts);
  muxes.push(root, worker);
  return { a, b, root, worker };
}

/** a real unix socket pair, so that destroying one end is seen by the other (as with a dead process) */
async function unixPair(): Promise<[net.Socket, net.Socket]> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "filedeck-proto-"));
  dirs.push(dir);
  const sockPath = path.join(dir, "s");
  const srv = net.createServer();
  await new Promise<void>((res) => srv.listen(sockPath, res));
  const accepted = new Promise<net.Socket>((res) => srv.once("connection", res));
  const client = net.connect(sockPath);
  await new Promise<void>((res) => client.once("connect", () => res()));
  const server = await accepted;
  srv.close();
  return [client, server];
}

/** resolves with the time a signal fired, or rejects after `ms` */
function firedWithin(signal: AbortSignal, ms: number): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error(`signal did not fire within ${ms} ms`)), ms);
    signal.addEventListener("abort", () => { clearTimeout(t); res(); }, { once: true });
  });
}

async function within<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let t: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, rej) => { t = setTimeout(() => rej(new Error(`${what}: no result within ${ms} ms`)), ms); });
  try { return await Promise.race([p, timeout]); } finally { clearTimeout(t); }
}

/** a body that sends one chunk and then waits for ever; `cancelled` resolves when the reader cancels it */
function hangingBody() {
  let cancelled!: () => void;
  const done = new Promise<void>((r) => { cancelled = r; });
  let sent = false;
  const body = new ReadableStream<Uint8Array>({
    pull(c) {
      if (!sent) { sent = true; c.enqueue(new TextEncoder().encode("first")); return; }
      return new Promise<void>(() => {});
    },
    cancel() { cancelled(); },
  }, { highWaterMark: 0 });
  return { body, cancelled: done };
}

function frame(type: number, id: number, payload: Uint8Array | string = new Uint8Array(0)): Buffer {
  const p = typeof payload === "string" ? Buffer.from(payload) : Buffer.from(payload);
  const b = Buffer.alloc(9 + p.length);
  b.writeUInt32BE(5 + p.length, 0);
  b[4] = type;
  b.writeUInt32BE(id, 5);
  p.copy(b, 9);
  return b;
}

/** collects the frames a raw socket receives */
function frameReader(sock: Duplex) {
  const frames: { type: number; id: number; payload: Buffer }[] = [];
  let buf = Buffer.alloc(0);
  sock.on("data", (d: Buffer) => {
    buf = Buffer.concat([buf, d]);
    while (buf.length >= 4 && buf.length >= 4 + buf.readUInt32BE(0)) {
      const len = buf.readUInt32BE(0);
      frames.push({ type: buf[4]!, id: buf.readUInt32BE(5), payload: buf.subarray(9, 4 + len) });
      buf = buf.subarray(4 + len);
    }
  });
  return frames;
}

test("round trip", async () => {
  const { root, worker } = pair(undefined, {
    onRequest: async (req) => {
      assert.equal(req.url, "http://worker/api/x?y=1");
      assert.equal(req.method, "GET");
      return Response.json({ header: req.headers.get("x-test") }, { status: 201, headers: { "x-reply": "yes" } });
    },
  });
  const res = await root.fetch(new Request("http://elsewhere/api/x?y=1", { headers: { "x-test": "hi" } }));
  assert.equal(res.status, 201);
  assert.equal(res.headers.get("x-reply"), "yes");
  assert.deepEqual(await res.json(), { header: "hi" });
  assert.equal(root.inFlight(), 0);
  assert.equal(worker.inFlight(), 0);

  // a small POST body, two cookies kept apart, and a status without a body
  const { root: r2 } = pair(undefined, {
    onRequest: async (req) => {
      if (req.method === "DELETE") return new Response(null, { status: 204 });
      const h = new Headers();
      h.append("set-cookie", "a=1");
      h.append("set-cookie", "b=2");
      return new Response(`got ${await req.text()}`, { status: 200, headers: h });
    },
  });
  const p = await r2.fetch(new Request("http://x/p", { method: "POST", body: "hello" }));
  assert.equal(await p.text(), "got hello");
  assert.deepEqual(p.headers.getSetCookie(), ["a=1", "b=2"]);
  const d = await r2.fetch(new Request("http://x/d", { method: "DELETE" }));
  assert.equal(d.status, 204);
  assert.equal(d.body, null);
});

test("bounded buffering", { timeout: 60_000 }, async (t) => {
  const TOTAL = 64 * MiB;
  const CHUNK = 64 * KiB;
  const LIMIT = 2 * MiB + 64 * KiB;
  const [a, b] = duplexPair();
  const written = { root: 0, worker: 0 };
  for (const [s, k] of [[a, "root"], [b, "worker"]] as const) {
    const orig = s.write.bind(s) as (...args: unknown[]) => boolean;
    (s as unknown as { write: (...args: unknown[]) => boolean }).write = (chunk: unknown, ...rest: unknown[]) => {
      written[k] += (chunk as Uint8Array).length;
      return orig(chunk, ...rest);
    };
  }
  let pulled = 0, handlerRead = 0, testRead = 0;
  let worst = 0, worstPulled = 0;
  const check = () => {
    worst = Math.max(worst, written.root - handlerRead, written.worker - testRead);
    worstPulled = Math.max(worstPulled, pulled - testRead);
  };
  const sent = createHash("sha256");
  const source = new ReadableStream<Uint8Array>({
    pull(c) {
      if (pulled >= TOTAL) { c.close(); return; }
      const chunk = new Uint8Array(CHUNK);
      for (let i = 0; i < CHUNK; i += 4096) chunk[i] = (pulled + i) >> 12 & 255;
      pulled += CHUNK;
      sent.update(chunk);
      check();
      c.enqueue(chunk);
    },
  }, { highWaterMark: 0 });
  const { root } = pair(undefined, {
    onRequest: async (req) => {
      const reader = req.body!.getReader();
      // echo the body back, counting what the handler takes from the request
      const echo = new ReadableStream<Uint8Array>({
        async pull(c) {
          const r = await reader.read();
          if (r.done) { c.close(); return; }
          handlerRead += r.value.length;
          check();
          c.enqueue(r.value);
        },
      }, { highWaterMark: 0 });
      return new Response(echo);
    },
  }, [a, b]);
  const res = await root.fetch(new Request("http://x/echo", { method: "POST", body: source, duplex: "half" } as RequestInit));
  const got = createHash("sha256");
  const reader = res.body!.getReader();
  let reads = 0;
  for (;;) {
    const r = await reader.read();
    if (r.done) break;
    testRead += r.value.length;
    got.update(r.value);
    check();
    // read slowly: pause now and then, so that both windows fill up
    if (++reads % 64 === 0) { await sleep(20); check(); }
  }
  assert.equal(testRead, TOTAL);
  assert.equal(got.digest("hex"), sent.digest("hex"));
  t.diagnostic(`most queued per side ${worst}, most read ahead of the reader ${worstPulled}`);
  assert.ok(worst <= LIMIT, `at most ${LIMIT} bytes queued per side, saw ${worst}`);
  // per direction: one window sent and not granted, plus the rest of the 64 KiB chunk the sender holds
  assert.ok(worstPulled <= 2 * (MiB + 64 * KiB), `at most two windows read ahead of the reader, saw ${worstPulled}`);
});

test("bounded buffering: a slow socket is not written past its buffer", { timeout: 60_000 }, async (t) => {
  // a socket that takes 1 ms per write: the window alone would let 8 streams queue 8 MiB in it
  class Slow extends Duplex {
    maxQueued = 0;
    constructor(private inner: Duplex) {
      super();
      inner.on("data", (d) => { this.push(d); });
      inner.on("end", () => { this.push(null); });
    }
    override _read() {}
    override _write(chunk: Buffer, _enc: BufferEncoding, cb: (e?: Error | null) => void) {
      this.maxQueued = Math.max(this.maxQueued, this.writableLength);
      setTimeout(() => { this.inner.write(chunk); cb(); }, 1);
    }
  }
  const [a, b] = duplexPair();
  const slow = new Slow(a);
  const { root } = pair(undefined, {
    onRequest: async (req) => new Response(String((await req.arrayBuffer()).byteLength)),
  }, [slow, b]);
  const sizes = await Promise.all(Array.from({ length: 8 }, () =>
    root.fetch(new Request("http://x/up", { method: "POST", body: new Uint8Array(2 * MiB) })).then((r) => r.text())));
  assert.deepEqual(sizes, Array(8).fill(String(2 * MiB)));
  t.diagnostic(`most bytes queued in the socket ${slow.maxQueued}`);
  assert.ok(slow.maxQueued <= 256 * KiB, `at most one frame past the socket's buffer, saw ${slow.maxQueued}`);
});

test("abort reaches the handler", async () => {
  // the caller's signal, after the head
  let seen!: AbortSignal;
  let { body, cancelled } = hangingBody();
  const { root, worker } = pair(undefined, { onRequest: async (req) => { seen = req.signal; return new Response(body); } });
  const ac = new AbortController();
  const res = await root.fetch(new Request("http://x/a", { signal: ac.signal }));
  const reader = res.body!.getReader();
  assert.equal(new TextDecoder().decode((await reader.read()).value), "first");
  ac.abort();
  await firedWithin(seen, 100);
  await within(cancelled, 100, "response source cancelled");
  await assert.rejects(reader.read(), { name: "AbortError" });

  // the caller's signal, before the head
  const ac2 = new AbortController();
  let seen2!: AbortSignal;
  const { root: r2 } = pair(undefined, {
    onRequest: (req) => { seen2 = req.signal; return new Promise((_, rej) => req.signal.addEventListener("abort", () => rej(req.signal.reason))); },
  });
  const pending = r2.fetch(new Request("http://x/b", { signal: ac2.signal }));
  await sleep(20);
  ac2.abort();
  await assert.rejects(pending, { name: "AbortError" });
  await firedWithin(seen2, 100);

  // cancelling the response body
  ({ body, cancelled } = hangingBody());
  const res3 = await root.fetch(new Request("http://x/c"));
  const r3 = res3.body!.getReader();
  await r3.read();
  await r3.cancel();
  await firedWithin(seen, 100);
  await within(cancelled, 100, "response source cancelled");

  // an upload the client drops halfway: the handler's read fails and its signal fires
  let upload!: Promise<unknown>;
  let seen4!: AbortSignal;
  const { root: r4, worker: w4 } = pair(undefined, {
    onRequest: async (req) => {
      seen4 = req.signal;
      upload = req.arrayBuffer();
      upload.catch(() => {});
      return new Promise<Response>((_, rej) => req.signal.addEventListener("abort", () => rej(req.signal.reason)));
    },
  });
  let fail!: (e: Error) => void;
  const src = new ReadableStream<Uint8Array>({
    start(c) { c.enqueue(new Uint8Array(1000)); fail = (e) => c.error(e); },
  });
  const p4 = r4.fetch(new Request("http://x/up", { method: "PUT", body: src, duplex: "half" } as RequestInit));
  p4.catch(() => {});
  await sleep(20);
  fail(new Error("client went away"));
  await firedWithin(seen4, 100);
  await assert.rejects(within(upload, 100, "upload read"));
  await assert.rejects(p4, /client went away/);

  await sleep(20);
  for (const m of [root, worker, r2, r4, w4]) assert.equal(m.inFlight(), 0);
});

test("socket closes", async () => {
  // the far end dies before the head: the pending fetch rejects
  {
    let seen!: AbortSignal;
    const { b, root, worker } = pair(undefined, {
      onRequest: (req) => { seen = req.signal; return new Promise<Response>(() => {}); },
    }, await unixPair());
    const pending = root.fetch(new Request("http://x/slow"));
    await sleep(20);
    assert.equal(root.inFlight(), 1);
    b.destroy();
    await within(assert.rejects(pending, WorkerGone), 1000, "pending fetch");
    await within(root.closed, 1000, "root closed");
    await within(worker.closed, 1000, "worker closed");
    await firedWithin(seen, 100);
    assert.equal(root.inFlight(), 0);
    await assert.rejects(root.fetch(new Request("http://x/again")), WorkerGone);
  }
  // the far end dies while a body streams: the body errors
  {
    const { body } = hangingBody();
    const { b, root } = pair(undefined, { onRequest: async () => new Response(body) }, await unixPair());
    const res = await root.fetch(new Request("http://x/stream"));
    const reader = res.body!.getReader();
    await reader.read();
    b.destroy();
    await within(assert.rejects(reader.read(), WorkerGone), 1000, "body read");
  }
  // our own end is destroyed (no event reaches the far end of a duplexPair)
  {
    const { a, root } = pair(undefined, { onRequest: () => new Promise<Response>(() => {}) });
    const pending = root.fetch(new Request("http://x/slow"));
    a.destroy();
    await within(assert.rejects(pending, WorkerGone), 1000, "pending fetch");
  }
});

test("bad frames close the mux", async () => {
  const cases: [string, Buffer][] = [
    ["a frame claiming 1 MiB of payload", (() => { const h = Buffer.alloc(9); h.writeUInt32BE(5 + MiB, 0); h[4] = 4; h.writeUInt32BE(2, 5); return h; })()],
    ["REQ_HEAD with invalid JSON", frame(3, 2, "{nope")],
    ["an unknown type", frame(99, 2)],
    ["REQ_HEAD with the wrong shape", frame(3, 2, JSON.stringify({ method: "GET", url: "x", headers: [] }))],
    ["REQ_HEAD with too many headers", frame(3, 2, JSON.stringify({ method: "GET", url: "/", headers: Array.from({ length: 600 }, (_, i) => [`h${i}`, "v"]) }))],
    ["REQ_HEAD with an id of the wrong side", frame(3, 1, JSON.stringify({ method: "GET", url: "/", headers: [] }))],
    ["RES_HEAD for a stream never opened", frame(7, 99, JSON.stringify({ status: 200, headers: [] }))],
    ["HELLO towards the root", frame(1, 0, "{}")],
  ];
  for (const [what, bytes] of cases) {
    const [a, b] = duplexPair();
    const root = new Mux(a, "root", { onRequest: async () => new Response("no") });
    muxes.push(root);
    b.on("error", () => {});
    b.resume();
    const pending = root.fetch(new Request("http://x/p"));
    b.write(bytes);
    await within(root.closed, 1000, what);
    await within(assert.rejects(pending, WorkerGone), 1000, `${what}: pending fetch`);
  }

  // a body larger than the window closes the mux too
  {
    const [a, b] = duplexPair();
    const root = new Mux(a, "root", { onRequest: () => new Promise<Response>(() => {}) });
    muxes.push(root);
    b.on("error", () => {});
    b.resume();
    b.write(frame(3, 2, JSON.stringify({ method: "POST", url: "/_root/x", headers: [] })));
    for (let i = 0; i < 17; i++) b.write(frame(4, 2, new Uint8Array(64 * KiB)));
    await within(root.closed, 1000, "body past the window");
  }

  // the worker may open only a few streams towards the root at once: the rest get ERROR
  {
    const [a, b] = duplexPair();
    let calls = 0;
    const root = new Mux(a, "root", { onRequest: () => { calls++; return new Promise<Response>(() => {}); } });
    muxes.push(root);
    const frames = frameReader(b);
    for (let i = 1; i <= 20; i++) b.write(frame(3, 2 * i, JSON.stringify({ method: "GET", url: "/", headers: [] })));
    await sleep(50);
    assert.equal(calls, 16);
    assert.equal(root.inFlight(), 16);
    const errors = frames.filter((f) => f.type === 8);
    assert.deepEqual(errors.map((f) => f.id), [34, 36, 38, 40]);
    for (const f of errors) assert.deepEqual(JSON.parse(f.payload.toString()), { message: "too many requests" });
  }
});

test("both directions", async () => {
  const { root, worker } = pair({
    onRequest: async (req) => {
      assert.equal(req.url, "http://worker/_root/trash-dir");
      const { volume } = await req.json() as { volume: string };
      return Response.json({ path: `${volume}/.filedeck-trash/u1000` });
    },
  }, {
    onRequest: async () => new Response("from worker"),
  });
  const [up, down] = await Promise.all([
    worker.fetch(new Request("http://root/_root/trash-dir", { method: "POST", body: JSON.stringify({ volume: "/v" }) })),
    root.fetch(new Request("http://worker/api/x")),
  ]);
  assert.deepEqual(await up.json(), { path: "/v/.filedeck-trash/u1000" });
  assert.equal(await down.text(), "from worker");
});

test("hello, ready and bye", async () => {
  const { root, worker } = pair();
  const got = new Promise<unknown>((res) => worker.onHello(res));
  root.hello({ cfg: { root: "/srv" } });
  assert.deepEqual(await got, { cfg: { root: "/srv" } });
  worker.ready();
  await within(root.whenReady(), 1000, "ready");
  // closing one side sends BYE and the other closes too
  root.close();
  await within(worker.closed, 1000, "worker closed after BYE");
  await within(root.closed, 1000, "root closed");

  // whenReady rejects when the mux closes first
  const { root: r2, a } = pair();
  const ready = r2.whenReady();
  a.destroy();
  await assert.rejects(ready, WorkerGone);
});

/** a root mux whose far end is a raw socket the test writes frames into */
function rawRoot(onRequest?: (req: Request) => Promise<Response>) {
  const [a, b] = duplexPair();
  const root = new Mux(a, "root", { onRequest });
  muxes.push(root);
  b.on("error", () => {});
  const frames = frameReader(b);
  return { a, b, root, frames };
}
const head = (o: unknown) => JSON.stringify(o);
const u32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32BE(n, 0); return b; };

test("stream cap holds until the handler ends", async () => {
  let running = 0, most = 0, calls = 0;
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  // a handler that ignores its signal: aborting the stream must not free its slot
  const { b, root, frames } = rawRoot(async () => {
    calls++;
    most = Math.max(most, ++running);
    await gate;
    running--;
    return new Response("late");
  });
  for (let i = 1; i <= 20; i++) {
    b.write(frame(3, 2 * i, head({ method: "GET", url: "/", headers: [] })));
    b.write(frame(6, 2 * i));
  }
  await sleep(50);
  assert.equal(calls, 16);
  assert.equal(most, 16);
  assert.equal(root.inFlight(), 16);
  assert.deepEqual(frames.filter((f) => f.type === 8).map((f) => f.id), [34, 36, 38, 40]);
  release();
  await sleep(50);
  assert.equal(root.inFlight(), 0);
  // the slots are free again
  b.write(frame(3, 42, head({ method: "GET", url: "/", headers: [] })));
  await sleep(50);
  assert.equal(calls, 17);
});

test("an aborted stream waiting for the socket to drain lets go", async () => {
  // the far end never reads, so the body's first frame fills the socket
  const [a] = duplexPair();
  const root = new Mux(a, "root");
  muxes.push(root);
  const drainWaits = () => (root as unknown as { drainWaiters: { size?: number; length?: number } }).drainWaiters;
  const waiting = () => drainWaits().size ?? drainWaits().length ?? -1;
  let cancelled = false;
  const src = new ReadableStream<Uint8Array>({
    pull(c) { c.enqueue(new Uint8Array(256 * KiB)); },
    cancel() { cancelled = true; },
  }, { highWaterMark: 0 });
  const ac = new AbortController();
  const p = root.fetch(new Request("http://x/up", { method: "POST", body: src, duplex: "half", signal: ac.signal } as RequestInit));
  p.catch(() => {});
  await sleep(20);
  assert.equal(waiting(), 1);
  ac.abort();
  await assert.rejects(p, { name: "AbortError" });
  await sleep(10);
  assert.equal(waiting(), 0);
  assert.ok(cancelled);
  assert.equal(root.inFlight(), 0);
});

test("protocol errors on a stream", async () => {
  // WINDOW past the window, and WINDOW 0
  for (const [what, n] of [["past the window", 1], ["zero", 0]] as const) {
    const { b, root } = rawRoot();
    const pending = root.fetch(new Request("http://x/p"));
    pending.catch(() => {});
    b.write(frame(9, 1, u32(n)));
    await within(root.closed, 1000, `WINDOW ${what}`);
    await assert.rejects(pending, WorkerGone);
  }
  // BODY after END, on a request the worker sends the root (the stream is still open: the handler
  // has not answered). Once both directions have ended a stream is forgotten, and later frames for
  // it are dropped like those that cross an ABORT.
  {
    const { b, root } = rawRoot(() => new Promise<Response>(() => {}));
    b.write(frame(3, 2, head({ method: "POST", url: "/_root/x", headers: [] })));
    b.write(frame(4, 2, "body"));
    b.write(frame(5, 2));
    b.write(frame(4, 2, "late"));
    await within(root.closed, 1000, "BODY after END");
  }
  // ERROR after RES_HEAD: the body errors with the message
  {
    const { b, root } = rawRoot();
    const pending = root.fetch(new Request("http://x/p"));
    b.write(frame(7, 1, head({ status: 200, headers: [] })));
    const res = await pending;
    b.write(frame(8, 1, head({ message: "disk went away" })));
    await assert.rejects(res.text(), /disk went away/);
    assert.equal(root.inFlight(), 0);
  }
  // a handler that throws: the fetch rejects with its message
  {
    const { root } = pair(undefined, { onRequest: async () => { throw new Error("boom"); } });
    await assert.rejects(root.fetch(new Request("http://x/p")), /boom/);
    assert.equal(root.inFlight(), 0);
  }
});

test("handlers may answer with either Response class", async () => {
  // @hono/node-server replaces the global Response once a listener is made, as in the root process
  const Native = globalThis.Response;
  getRequestListener(() => new Response("x"));
  assert.notEqual(globalThis.Response, Native);
  const { root } = pair(undefined, {
    onRequest: async (req) => req.url.endsWith("/native") ? new Native("native", { status: 202 }) : new Response("light", { status: 203 }),
  });
  const n = await root.fetch(new Request("http://x/native"));
  assert.equal(n.status, 202);
  assert.equal(await n.text(), "native");
  const l = await root.fetch(new Request("http://x/light"));
  assert.equal(l.status, 203);
  assert.equal(await l.text(), "light");
});

test("no stray errors", async () => {
  await sleep(50);
  assert.deepEqual(stray, []);
});
