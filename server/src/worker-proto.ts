import type { Duplex } from "node:stream";

/**
 * The framed request protocol between the agent's root process and a worker process, over one
 * socket. Each side can send requests to the other (the root forwards HTTP requests to the worker;
 * the worker asks the root for the few things only root may do), many at once, each on its own
 * stream.
 *
 * A frame is a `u32 BE` length of what follows, a `u8` type, a `u32 BE` stream id and the payload.
 * Streams opened by the root have odd ids, streams opened by the worker even ids, and both count
 * up. `HELLO`, `READY` and `BYE` use id 0. Heads and errors are JSON.
 *
 * Bodies stream in both directions with flow control: a sender keeps at most `window` bytes sent and
 * not yet granted per stream, and the receiver grants bytes back with `WINDOW n` as its consumer
 * takes them. The socket itself is always read, so a slow consumer of one stream never holds up
 * the others, and what one stream can queue is limited by its window.
 *
 * The root treats the worker as untrusted: every length is checked before anything is buffered, a
 * worker can open only a few streams towards the root at once, heads have a size and count limit,
 * and anything malformed closes the mux (it never throws out of an event handler). Both sides must
 * use the same `window`.
 */

export const HELLO = 1, READY = 2, REQ_HEAD = 3, BODY = 4, END = 5, ABORT = 6, RES_HEAD = 7, ERROR = 8, WINDOW = 9, BYE = 10;
/** most payload bytes in one frame */
export const MAX_PAYLOAD = 64 * 1024;
/** default per-stream window, in each direction */
export const DEFAULT_WINDOW = 1024 * 1024;
/** most header lines in one head (the frame size limits their total size to 64 KiB) */
export const MAX_HEADERS = 512;
/** streams the worker may have open towards the root at once */
export const MAX_WORKER_STREAMS = 16;
/** streams the root may have open towards a worker at once */
export const MAX_ROOT_STREAMS = 4096;
/** bytes of frames waiting in the socket for a peer that does not read; past this the mux closes */
export const MAX_BACKLOG = 8 * 1024 * 1024;

const HEADER = 9;
/** received payloads smaller than this are packed into shared blocks, so tiny frames cannot cost more memory than they carry */
const BLOCK = 16 * 1024;
const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,32}$/;
const NULL_BODY = new Set([204, 205, 304]);

export class WorkerGone extends Error {
  constructor() {
    super("worker stopped");
    this.name = "WorkerGone";
  }
}

class ProtocolError extends Error {}

const abortError = () => new DOMException("This operation was aborted", "AbortError");
const noop = () => {};

/** the receiving end of one body: a queue bounded by the window, read through a pull-based stream */
class Inbound {
  readonly stream: ReadableStream<Uint8Array>;
  /** bytes received and not yet handed to the consumer (and so not yet granted) */
  queued = 0;
  ended = false;
  private q: { buf: Uint8Array; fill: number }[] = [];
  /** the last block in `q` while more small payloads can still be packed into it */
  private open: { buf: Uint8Array; fill: number } | null = null;
  private ctl!: ReadableStreamDefaultController<Uint8Array>;
  private wake: (() => void) | null = null;
  private failed = false;

  constructor(grant: (n: number) => void, onCancel: (reason: unknown, dropped: number) => void) {
    this.stream = new ReadableStream<Uint8Array>({
      start: (c) => { this.ctl = c; },
      pull: async (c) => {
        for (;;) {
          if (this.failed) return;
          const item = this.q.shift();
          if (item) {
            if (item === this.open) this.open = null;
            this.queued -= item.fill;
            c.enqueue(item.fill === item.buf.length ? item.buf : item.buf.subarray(0, item.fill));
            grant(item.fill);
            return;
          }
          if (this.ended) { c.close(); return; }
          await new Promise<void>((r) => { this.wake = r; });
        }
      },
      cancel: (reason) => {
        const dropped = this.queued;
        this.drop();
        onCancel(reason, dropped);
      },
    }, { highWaterMark: 0 });
  }

  push(payload: Uint8Array): void {
    if (this.failed) return;
    this.queued += payload.length;
    const o = this.open;
    if (payload.length < BLOCK && o && o.fill + payload.length <= o.buf.length) {
      o.buf.set(payload, o.fill);
      o.fill += payload.length;
    } else if (payload.length < BLOCK) {
      const b = { buf: new Uint8Array(BLOCK), fill: payload.length };
      b.buf.set(payload);
      this.q.push(b);
      this.open = b;
    } else {
      this.q.push({ buf: new Uint8Array(payload), fill: payload.length });
      this.open = null;
    }
    this.poke();
  }

  end(): void {
    this.ended = true;
    this.poke();
  }

  fail(err: unknown): void {
    if (this.failed) return;
    this.drop();
    try { this.ctl.error(err); } catch { /* already closed */ }
    this.poke();
  }

  private drop(): void {
    this.failed = true;
    this.q = [];
    this.open = null;
    this.queued = 0;
  }

  private poke(): void {
    const w = this.wake;
    this.wake = null;
    w?.();
  }
}

interface Stream {
  id: number;
  /** we opened it (our `fetch`); else the peer did and our `onRequest` serves it */
  mine: boolean;
  done: boolean;
  /** bytes we may still send before the peer grants more */
  credit: number;
  wakeSend: (() => void) | null;
  /** the body we send, while we read it */
  reader: ReadableStreamDefaultReader<Uint8Array> | null;
  /** the body we receive; null before the response head, or when it is thrown away */
  inbound: Inbound | null;
  /** frames of a received body nobody reads are granted at once and dropped */
  discard: boolean;
  /** the peer has sent END for the body we receive */
  inEnded: boolean;
  // our fetch
  headSeen: boolean;
  resolve: ((r: Response) => void) | null;
  reject: ((e: unknown) => void) | null;
  cleanup: (() => void) | null;
  // a request we serve
  ac: AbortController | null;
}

function newStream(id: number, mine: boolean, window: number): Stream {
  return {
    id, mine, done: false, credit: window, wakeSend: null, reader: null, inbound: null, discard: false, inEnded: false,
    headSeen: false, resolve: null, reject: null, cleanup: null, ac: null,
  };
}

function parseJson(p: Uint8Array): unknown {
  try {
    return JSON.parse(Buffer.from(p.buffer, p.byteOffset, p.length).toString("utf8"));
  } catch {
    throw new ProtocolError("bad JSON");
  }
}

function parseHeaders(v: unknown): [string, string][] {
  if (!Array.isArray(v) || v.length > MAX_HEADERS) throw new ProtocolError("bad headers");
  for (const h of v) {
    if (!Array.isArray(h) || h.length !== 2 || typeof h[0] !== "string" || typeof h[1] !== "string") throw new ProtocolError("bad headers");
  }
  return v as [string, string][];
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function json(v: unknown): Buffer | null {
  const b = Buffer.from(JSON.stringify(v));
  return b.length > MAX_PAYLOAD ? null : b;
}

function message(e: unknown): string {
  return (e instanceof Error ? e.message : String(e)).slice(0, 1000);
}

export class Mux {
  /** resolves once the mux is closed, from either side or because the socket went away */
  readonly closed: Promise<void>;
  private isClosed = false;
  private resolveClosed!: () => void;
  private readonly streams = new Map<number, Stream>();
  private readonly window: number;
  private readonly maxPeerStreams: number;
  private readonly onRequest: ((req: Request) => Promise<Response>) | undefined;
  private nextId: number;
  /** the highest stream id the peer has opened */
  private lastPeerId = 0;
  private peerOpen = 0;
  // incoming bytes not yet parsed
  private inChunks: Buffer[] = [];
  private inBytes = 0;
  private need = 0;
  private drainWaiters: (() => void)[] = [];
  private helloInit: { v: unknown } | null = null;
  private helloFn: ((init: unknown) => void) | null = null;
  private readonly readyP: Promise<void>;
  private readyRes!: () => void;
  private readyRej!: (e: unknown) => void;
  private isReady = false;

  constructor(
    private readonly sock: Duplex,
    private readonly side: "root" | "worker",
    o: { onRequest?: (req: Request) => Promise<Response>; window?: number } = {},
  ) {
    this.window = o.window ?? DEFAULT_WINDOW;
    this.onRequest = o.onRequest;
    this.nextId = side === "root" ? 1 : 2;
    this.maxPeerStreams = side === "root" ? MAX_WORKER_STREAMS : MAX_ROOT_STREAMS;
    this.closed = new Promise((r) => { this.resolveClosed = r; });
    this.readyP = new Promise((res, rej) => { this.readyRes = res; this.readyRej = rej; });
    this.readyP.catch(noop);
    sock.on("data", (d: Buffer) => this.onData(d));
    sock.on("end", () => this.shutdown(false));
    sock.on("close", () => this.shutdown(false));
    sock.on("error", () => this.shutdown(false, true));
  }

  /** streams open in either direction */
  inFlight(): number {
    return this.streams.size;
  }

  /** sends BYE and ends the socket; every open stream fails with `WorkerGone` */
  close(): void {
    this.shutdown(true);
  }

  /** root: sends the worker its start-up message (JSON, at most 64 KiB) */
  hello(init: unknown): void {
    const p = json(init);
    if (!p) throw new Error("worker init is larger than 64 KiB");
    this.send(HELLO, 0, p);
  }

  /** worker: `fn` gets the root's start-up message (at once if it is already here) */
  onHello(fn: (init: unknown) => void): void {
    this.helloFn = fn;
    if (this.helloInit) fn(this.helloInit.v);
  }

  /** worker: tells the root it can take requests */
  ready(): void {
    this.send(READY, 0);
  }

  /** root: resolves when the worker has sent READY; rejects with `WorkerGone` if the mux closes first */
  whenReady(): Promise<void> {
    return this.readyP;
  }

  /**
   * Sends `req` to the other side. The request body streams as the other side reads it; aborting
   * `req.signal` or cancelling the response body sends ABORT. Rejects with `WorkerGone` when the
   * mux closes before the response head; after it, the response body errors with `WorkerGone`.
   */
  fetch(req: Request): Promise<Response> {
    if (this.isClosed) return Promise.reject(new WorkerGone());
    const signal = req.signal;
    if (signal.aborted) return Promise.reject(signal.reason);
    const u = new URL(req.url);
    const headers = [...req.headers];
    const head = headers.length <= MAX_HEADERS ? json({ method: req.method, url: u.pathname + u.search, headers }) : null;
    if (!head) return Promise.reject(new Error("request head is too large"));
    if (this.nextId > 0xffffffff) {
      this.shutdown(true);
      return Promise.reject(new WorkerGone());
    }
    const st = newStream(this.nextId, true, this.window);
    this.nextId += 2;
    return new Promise<Response>((resolve, reject) => {
      st.resolve = resolve;
      st.reject = reject;
      const onAbort = () => this.abort(st, signal.reason);
      signal.addEventListener("abort", onAbort, { once: true });
      st.cleanup = () => signal.removeEventListener("abort", onAbort);
      this.streams.set(st.id, st);
      this.send(REQ_HEAD, st.id, head);
      if (req.body) void this.pump(st, req.body);
      else this.send(END, st.id);
    });
  }

  // ---- sending ----

  private send(type: number, id: number, payload?: Uint8Array): void {
    if (this.isClosed || this.sock.destroyed) return;
    const n = payload ? payload.length : 0;
    const buf = Buffer.allocUnsafe(HEADER + n);
    buf.writeUInt32BE(5 + n, 0);
    buf[4] = type;
    buf.writeUInt32BE(id, 5);
    if (payload) buf.set(payload, HEADER);
    try {
      this.sock.write(buf);
    } catch {
      this.shutdown(false, true);
      return;
    }
    // body frames wait for 'drain'; only small control frames go out regardless, so a big
    // backlog means the peer has stopped reading
    if (this.sock.writableLength > MAX_BACKLOG) this.shutdown(false, true);
  }

  private grant(st: Stream, n: number): void {
    if (n > 0 && !st.done && this.streams.get(st.id) === st) {
      const p = Buffer.allocUnsafe(4);
      p.writeUInt32BE(n, 0);
      this.send(WINDOW, st.id, p);
    }
  }

  private drained(): Promise<void> {
    return new Promise((r) => {
      this.drainWaiters.push(r);
      if (this.drainWaiters.length === 1) this.sock.once("drain", this.onDrain);
    });
  }

  private readonly onDrain = (): void => {
    const w = this.drainWaiters;
    this.drainWaiters = [];
    for (const r of w) r();
  };

  /** sends a body on `st`, within its window and only while the socket takes more */
  private async pump(st: Stream, body: ReadableStream<Uint8Array>): Promise<void> {
    let reader: ReadableStreamDefaultReader<Uint8Array>;
    try {
      reader = body.getReader();
    } catch (e) {
      this.bodyFailed(st, e);
      return;
    }
    st.reader = reader;
    try {
      for (;;) {
        if (st.done) return;
        const r = await reader.read();
        if (st.done) return;
        if (r.done) break;
        const chunk: unknown = r.value;
        if (!(chunk instanceof Uint8Array)) throw new TypeError("body chunk is not bytes");
        let off = 0;
        while (off < chunk.length) {
          while (!st.done && (st.credit <= 0 || this.sock.writableNeedDrain)) {
            if (st.credit <= 0) await new Promise<void>((w) => { st.wakeSend = w; });
            else await this.drained();
          }
          if (st.done) return;
          const n = Math.min(st.credit, MAX_PAYLOAD, chunk.length - off);
          st.credit -= n;
          this.send(BODY, st.id, chunk.subarray(off, off + n));
          off += n;
        }
      }
      st.reader = null;
      this.send(END, st.id);
      // a request we serve is over once its response is sent; our own requests wait for theirs
      if (!st.mine) this.finish(st, null);
    } catch (e) {
      if (!st.done) this.bodyFailed(st, e);
    }
  }

  /** the body we were sending failed: for our request, abort it; for a response, tell the caller */
  private bodyFailed(st: Stream, e: unknown): void {
    if (st.mine) {
      this.abort(st, e);
    } else {
      const p = json({ message: message(e) }) ?? Buffer.from('{"message":"error"}');
      this.send(ERROR, st.id, p);
      this.finish(st, abortError());
    }
  }

  // ---- stream ends ----

  /** ends `st` here and tells the peer (ABORT) */
  private abort(st: Stream, reason: unknown): void {
    if (st.done) return;
    this.send(ABORT, st.id);
    this.finish(st, reason);
  }

  /**
   * Forgets `st`. With `err` every part still running fails with it: a pending fetch rejects, a
   * body being received errors, the body being sent is cancelled and a served request's signal
   * fires. Without, the stream ended normally; a received body keeps what it has queued.
   */
  private finish(st: Stream, err: unknown): void {
    if (st.done) return;
    st.done = true;
    if (this.streams.get(st.id) === st) {
      this.streams.delete(st.id);
      if (!st.mine) this.peerOpen--;
    }
    st.cleanup?.();
    st.cleanup = null;
    const w = st.wakeSend;
    st.wakeSend = null;
    w?.();
    if (st.reader) {
      st.reader.cancel(err ?? abortError()).catch(noop);
      st.reader = null;
    }
    if (err !== null) {
      st.reject?.(err);
      st.inbound?.fail(err);
      st.ac?.abort(err);
    } else if (st.inbound && !st.inEnded) {
      st.inbound.fail(abortError());
    }
    st.resolve = st.reject = null;
  }

  private shutdown(bye: boolean, destroy = false): void {
    if (this.isClosed) {
      if (destroy) this.sock.destroy();
      return;
    }
    if (bye) this.send(BYE, 0);
    this.isClosed = true;
    for (const st of [...this.streams.values()]) this.finish(st, new WorkerGone());
    this.inChunks = [];
    this.inBytes = 0;
    if (!this.isReady) this.readyRej(new WorkerGone());
    this.onDrain();
    if (destroy) this.sock.destroy();
    else if (!this.sock.destroyed && !this.sock.writableEnded) this.sock.end();
    this.resolveClosed();
  }

  // ---- receiving ----

  private onData(d: Buffer): void {
    if (this.isClosed) return;
    this.inChunks.push(d);
    this.inBytes += d.length;
    try {
      while (!this.isClosed) {
        if (this.need === 0) {
          if (this.inBytes < 4) return;
          const len = this.peekLength();
          if (len < 5 || len > 5 + MAX_PAYLOAD) throw new ProtocolError("bad frame length");
          this.need = 4 + len;
        }
        if (this.inBytes < this.need) return;
        const f = this.take(this.need);
        this.need = 0;
        this.onFrame(f[4]!, f.readUInt32BE(5), f.subarray(HEADER));
      }
    } catch {
      // a malformed peer (or a bug in a callback) closes the mux instead of the process
      this.shutdown(false, true);
    }
  }

  private peekLength(): number {
    const first = this.inChunks[0]!;
    if (first.length >= 4) return first.readUInt32BE(0);
    const b = Buffer.alloc(4);
    let off = 0;
    for (const c of this.inChunks) {
      off += c.copy(b, off, 0, Math.min(c.length, 4 - off));
      if (off === 4) break;
    }
    return b.readUInt32BE(0);
  }

  private take(n: number): Buffer {
    const first = this.inChunks[0]!;
    let out: Buffer;
    if (first.length >= n) {
      out = first.subarray(0, n);
      if (first.length === n) this.inChunks.shift();
      else this.inChunks[0] = first.subarray(n);
    } else {
      out = Buffer.allocUnsafe(n);
      let off = 0;
      while (off < n) {
        const c = this.inChunks[0]!;
        const k = Math.min(c.length, n - off);
        c.copy(out, off, 0, k);
        off += k;
        if (k === c.length) this.inChunks.shift();
        else this.inChunks[0] = c.subarray(k);
      }
    }
    this.inBytes -= n;
    return out;
  }

  private onFrame(type: number, id: number, p: Buffer): void {
    if (type === HELLO || type === READY || type === BYE) {
      if (id !== 0) throw new ProtocolError("control frame on a stream");
      if (type === BYE) { this.shutdown(false); return; }
      if (type === HELLO) {
        if (this.side !== "worker" || this.helloInit) throw new ProtocolError("unexpected HELLO");
        this.helloInit = { v: parseJson(p) };
        this.helloFn?.(this.helloInit.v);
        return;
      }
      if (this.side !== "root" || this.isReady) throw new ProtocolError("unexpected READY");
      this.isReady = true;
      this.readyRes();
      return;
    }
    if (type < REQ_HEAD || type > WINDOW) throw new ProtocolError("unknown frame type");
    if (id === 0) throw new ProtocolError("stream frame without a stream");
    const peers = (id & 1) === (this.side === "root" ? 0 : 1);
    if (type === REQ_HEAD) {
      if (!peers || id <= this.lastPeerId) throw new ProtocolError("bad stream id");
      this.lastPeerId = id;
      this.openPeerStream(id, p);
      return;
    }
    if (peers ? id > this.lastPeerId : id >= this.nextId) throw new ProtocolError("frame for a stream never opened");
    const st = this.streams.get(id);
    if (!st) {
      // a late frame for a stream that has ended here
      if (type === RES_HEAD || type === ERROR) parseJson(p);
      return;
    }
    switch (type) {
      case RES_HEAD: return this.onResHead(st, p);
      case BODY: return this.onBody(st, p);
      case END: return this.onEnd(st);
      case ABORT: return this.finish(st, st.mine ? new Error("the other side ended the request") : abortError());
      case ERROR: {
        const v = parseJson(p);
        if (!isObject(v) || typeof v.message !== "string") throw new ProtocolError("bad ERROR");
        return this.finish(st, st.mine ? new Error(v.message) : abortError());
      }
      case WINDOW: {
        if (p.length !== 4) throw new ProtocolError("bad WINDOW");
        const n = p.readUInt32BE(0);
        if (n === 0 || st.credit + n > this.window) throw new ProtocolError("window grant past the window");
        st.credit += n;
        const w = st.wakeSend;
        st.wakeSend = null;
        w?.();
        return;
      }
    }
  }

  private onResHead(st: Stream, p: Buffer): void {
    if (!st.mine || st.headSeen) throw new ProtocolError("unexpected RES_HEAD");
    const v = parseJson(p);
    if (!isObject(v) || typeof v.status !== "number" || !Number.isInteger(v.status) || v.status < 200 || v.status > 599) {
      throw new ProtocolError("bad RES_HEAD");
    }
    const headers = parseHeaders(v.headers);
    st.headSeen = true;
    let body: ReadableStream<Uint8Array> | null = null;
    if (NULL_BODY.has(v.status)) {
      st.discard = true;
    } else {
      st.inbound = new Inbound((n) => this.grant(st, n), (reason) => this.abort(st, reason));
      body = st.inbound.stream;
    }
    let res: Response;
    try {
      res = new Response(body, { status: v.status, headers });
    } catch (e) {
      this.abort(st, e);
      return;
    }
    const resolve = st.resolve;
    st.resolve = st.reject = null;
    resolve?.(res);
  }

  private onBody(st: Stream, p: Buffer): void {
    if (st.inEnded || (st.mine && !st.headSeen)) throw new ProtocolError("unexpected BODY");
    const queued = st.inbound ? st.inbound.queued : 0;
    if (queued + p.length > this.window) throw new ProtocolError("body past the window");
    if (st.discard || !st.inbound) this.grant(st, p.length);
    else st.inbound.push(p);
  }

  private onEnd(st: Stream): void {
    if (st.inEnded || (st.mine && !st.headSeen)) throw new ProtocolError("unexpected END");
    st.inEnded = true;
    st.inbound?.end();
    // our request is over once its response has ended; the request body need not go further
    if (st.mine) this.finish(st, null);
  }

  private openPeerStream(id: number, p: Buffer): void {
    const v = parseJson(p);
    if (!isObject(v) || typeof v.method !== "string" || !TOKEN.test(v.method) || typeof v.url !== "string" || !v.url.startsWith("/")) {
      throw new ProtocolError("bad REQ_HEAD");
    }
    const headers = parseHeaders(v.headers);
    if (this.peerOpen >= this.maxPeerStreams || !this.onRequest) {
      this.send(ERROR, id, json({ message: this.onRequest ? "too many requests" : "no handler" })!);
      return;
    }
    const st = newStream(id, false, this.window);
    this.streams.set(id, st);
    this.peerOpen++;
    void this.serve(st, v.method, v.url, headers, this.onRequest);
  }

  private async serve(st: Stream, method: string, url: string, headers: [string, string][], handler: (req: Request) => Promise<Response>): Promise<void> {
    const ac = new AbortController();
    st.ac = ac;
    let body: ReadableStream<Uint8Array> | null = null;
    const m = method.toUpperCase();
    if (m === "GET" || m === "HEAD") {
      st.discard = true;
    } else {
      // a handler that cancels the body still answers; what else arrives is granted and dropped
      st.inbound = new Inbound((n) => this.grant(st, n), (_, dropped) => { st.discard = true; this.grant(st, dropped); });
      body = st.inbound.stream;
    }
    let req: Request;
    try {
      req = new Request(`http://worker${url}`, { method, headers, body, signal: ac.signal, duplex: "half" } as RequestInit);
    } catch (e) {
      this.bodyFailed(st, e);
      return;
    }
    let res: Response;
    try {
      res = await handler(req);
      if (!(res instanceof Response)) throw new TypeError("the handler did not return a Response");
    } catch (e) {
      if (!st.done) this.bodyFailed(st, e);
      return;
    }
    if (st.done) {
      res.body?.cancel().catch(noop);
      return;
    }
    const pairs = [...res.headers];
    const head = pairs.length <= MAX_HEADERS ? json({ status: res.status, headers: pairs }) : null;
    if (!head) {
      res.body?.cancel().catch(noop);
      this.bodyFailed(st, new Error("response head is too large"));
      return;
    }
    this.send(RES_HEAD, st.id, head);
    if (res.body) {
      await this.pump(st, res.body);
    } else {
      this.send(END, st.id);
      this.finish(st, null);
    }
  }
}
