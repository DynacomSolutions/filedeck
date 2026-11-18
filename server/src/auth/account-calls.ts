/**
 * The calls an account has in flight through the hub (hub, sign-in on): proxied requests to machines and network sources, of any
 * method, and transfers. When the account changes (`accountChanged`), each is cut at once: its upstream request is aborted, a request
 * body still on its way fails (it does not end early, so a source never takes a cut upload as a whole file and removes its partial file,
 * and an agent sees the upload aborted), and an answer body still on its way fails too. Event streams are also ended by their session
 * (auth/streams.ts); this covers every other call.
 */

/** The error a cut call's bodies fail with. */
export class CallCut extends Error {
  override name = "AbortError";
  constructor() {
    super("the account changed");
  }
}

export interface AccountCall {
  /** aborted when the account changes */
  signal: AbortSignal;
  /** the call is over: forgets it (more than once is fine) */
  done(): void;
}

/** A call made under an act-as-root switch: the switch's key (the hub's `RootCalls.key`) and its end, ms since the epoch. */
export interface RootSwitch {
  key: string;
  until: number;
}

interface Entry {
  ac: AbortController;
  root?: string;
  timer?: NodeJS.Timeout;
}

export class AccountCalls {
  private readonly open = new Map<string, Set<Entry>>();

  constructor(private readonly now: () => number = Date.now) {}

  /**
   * A call of `kind:name` starts. One made under an act-as-root switch (`root`) is also cut when that switch ends (`endRoot`), and at
   * its end time at the latest.
   */
  start(kind: "sys" | "virt", name: string, root?: RootSwitch): AccountCall {
    const key = `${kind}:${name}`;
    const e: Entry = { ac: new AbortController(), ...(root ? { root: root.key } : {}) };
    let set = this.open.get(key);
    if (!set) this.open.set(key, (set = new Set()));
    set.add(e);
    const calls = set;
    const done = () => {
      clearTimeout(e.timer);
      calls.delete(e);
      if (calls.size === 0 && this.open.get(key) === calls) this.open.delete(key);
    };
    if (root) {
      e.timer = setTimeout(() => e.ac.abort(new CallCut()), Math.max(0, Math.min(root.until - this.now(), 2 ** 31 - 1)));
      e.timer.unref();
    }
    return { signal: e.ac.signal, done };
  }

  /** Cuts every call of `kind:name` now in flight; gives how many. */
  endAccount(kind: "sys" | "virt", name: string): number {
    const key = `${kind}:${name}`;
    const set = this.open.get(key);
    if (!set) return 0;
    this.open.delete(key);
    // (read first: a call forgets itself as it is cut)
    const all = [...set];
    for (const e of all) e.ac.abort(new CallCut());
    return all.length;
  }

  /** Cuts the calls of `sys:name` made under the act-as-root switch `key`, and no other; gives how many. */
  endRoot(name: string, key: string): number {
    const set = this.open.get(`sys:${name}`);
    if (!set) return 0;
    const hit = [...set].filter((e) => e.root === key);
    for (const e of hit) e.ac.abort(new CallCut());
    return hit.length;
  }

  /** How many calls are in flight (tests). */
  size(): number {
    let n = 0;
    for (const s of this.open.values()) n += s.size;
    return n;
  }
}

/** A cuttable body, and `close`, which ends it and closes the inner body whether it was read or not. */
interface CuttableBody {
  stream: ReadableStream<Uint8Array>;
  /** ends it (its reader sees it fail) and closes the inner body; nothing when it is over already */
  close(): void;
}

/**
 * `body` passed through until `signal` aborts; then the stream fails (never a clean end) and `body` is cancelled. `onEnd` runs once
 * however it ends: read to the end, failed, cancelled by its reader, cut, or closed. `body` is locked only at the first read, so until
 * then its owner can still cancel it itself; and cancelling the stream, a cut and `close` all close `body`, read or not (a source's read
 * stream left open holds the backend: an SMB download keeps its smbclient child).
 */
function cuttable(body: ReadableStream<Uint8Array>, signal: AbortSignal, onEnd?: () => void): CuttableBody {
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let over = false;
  let ctl!: ReadableStreamDefaultController<Uint8Array>;
  /** cancels `body`, through the reader once there is one */
  const closeInner = (reason: unknown): Promise<void> => {
    const p = reader ? reader.cancel(reason) : body.locked ? Promise.resolve() : body.cancel(reason);
    return p.catch(() => undefined);
  };
  const end = () => {
    if (over) return false;
    over = true;
    signal.removeEventListener("abort", cut);
    onEnd?.();
    return true;
  };
  const fail = (e: Error) => {
    if (!end()) return;
    try {
      ctl.error(e);
    } catch {
      /* already closed */
    }
    void closeInner(e);
  };
  const cut = () => fail(new CallCut());
  const stream = new ReadableStream<Uint8Array>({
    start: (c) => {
      ctl = c;
      if (signal.aborted) cut();
      else signal.addEventListener("abort", cut, { once: true });
    },
    pull: async (c) => {
      if (over) return;
      reader ??= body.getReader();
      let r: ReadableStreamReadResult<Uint8Array>;
      try {
        r = await reader.read();
      } catch (e) {
        if (end()) c.error(e);
        return;
      }
      if (over) return; // cut while reading: the stream has failed already
      if (r.done) {
        end();
        c.close();
      } else c.enqueue(r.value);
    },
    cancel: (reason) => {
      end();
      return closeInner(reason);
    },
  });
  return { stream, close: () => fail(new Error("the body was not read")) };
}

/** `body` passed through until `signal` aborts (see `cuttable`). */
export function cuttableBody(body: ReadableStream<Uint8Array>, signal: AbortSignal, onEnd?: () => void): ReadableStream<Uint8Array> {
  return cuttable(body, signal, onEnd).stream;
}

/**
 * A target whose calls are cut with `signal`: a call after the cut fails at once; a body sent in a call fails when cut. A body the
 * other end did not take (the call failed, or the answer is not a success: a refusal comes before the body is read) is closed as soon
 * as the answer is in, so the stream it came from (a source's download) is never left open.
 */
export function cuttableTarget<T extends { fetch(rest: string, init?: RequestInit): Promise<Response> }>(t: T, signal: AbortSignal): T {
  return {
    ...t,
    fetch: (rest: string, init?: RequestInit) => {
      if (signal.aborted) return Promise.reject(new CallCut());
      const body = init?.body instanceof ReadableStream ? cuttable(init.body as ReadableStream<Uint8Array>, signal) : undefined;
      const sig = init?.signal ? AbortSignal.any([init.signal, signal]) : signal;
      let p: Promise<Response>;
      try {
        p = t.fetch(rest, { ...init, ...(body ? { body: body.stream } : {}), signal: sig });
      } catch (e) {
        p = Promise.reject(e); // (a target that throws at once: the body is closed all the same)
      }
      return p.then(
        (r) => {
          if (!r.ok) body?.close();
          return r;
        },
        (e: unknown) => {
          body?.close();
          throw e;
        },
      );
    },
  };
}

/** `res` with its body cut with `signal`; `done` runs once the body is over (at once when there is none). */
export function cuttableResponse(res: Response, signal: AbortSignal, done: () => void): Response {
  // (a status that may carry no body is passed on as it is)
  if (!res.body || [101, 204, 205, 304].includes(res.status)) {
    done();
    return res;
  }
  return new Response(cuttableBody(res.body, signal, done), { status: res.status, statusText: res.statusText, headers: res.headers });
}
