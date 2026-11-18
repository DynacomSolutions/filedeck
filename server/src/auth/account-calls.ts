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

export class AccountCalls {
  private readonly open = new Map<string, Set<AbortController>>();

  /** A call of `kind:name` starts. */
  start(kind: "sys" | "virt", name: string): AccountCall {
    const key = `${kind}:${name}`;
    const ac = new AbortController();
    let set = this.open.get(key);
    if (!set) this.open.set(key, (set = new Set()));
    set.add(ac);
    const calls = set;
    return {
      signal: ac.signal,
      done: () => {
        calls.delete(ac);
        if (calls.size === 0 && this.open.get(key) === calls) this.open.delete(key);
      },
    };
  }

  /** Cuts every call of `kind:name` now in flight; gives how many. */
  endAccount(kind: "sys" | "virt", name: string): number {
    const key = `${kind}:${name}`;
    const set = this.open.get(key);
    if (!set) return 0;
    this.open.delete(key);
    for (const ac of set) ac.abort(new CallCut());
    return set.size;
  }

  /** How many calls are in flight (tests). */
  size(): number {
    let n = 0;
    for (const s of this.open.values()) n += s.size;
    return n;
  }
}

/**
 * `body` passed through until `signal` aborts; then the stream fails (never a clean end) and `body` is cancelled. `onEnd` runs once
 * however it ends: read to the end, failed, cancelled by its reader, or cut.
 */
export function cuttableBody(body: ReadableStream<Uint8Array>, signal: AbortSignal, onEnd?: () => void): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  let over = false;
  let ctl!: ReadableStreamDefaultController<Uint8Array>;
  const end = () => {
    if (over) return false;
    over = true;
    signal.removeEventListener("abort", cut);
    onEnd?.();
    return true;
  };
  const cut = () => {
    if (!end()) return;
    try {
      ctl.error(new CallCut());
    } catch {
      /* already closed */
    }
    reader.cancel(new CallCut()).catch(() => undefined);
  };
  return new ReadableStream<Uint8Array>({
    start: (c) => {
      ctl = c;
      if (signal.aborted) cut();
      else signal.addEventListener("abort", cut, { once: true });
    },
    pull: async (c) => {
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
      return reader.cancel(reason);
    },
  });
}

/** A target whose calls are cut with `signal`: a call after the cut fails at once; a body sent in a call fails when cut. */
export function cuttableTarget<T extends { fetch(rest: string, init?: RequestInit): Promise<Response> }>(t: T, signal: AbortSignal): T {
  return {
    ...t,
    fetch: (rest: string, init?: RequestInit) => {
      if (signal.aborted) return Promise.reject(new CallCut());
      const body = init?.body instanceof ReadableStream ? cuttableBody(init.body as ReadableStream<Uint8Array>, signal) : init?.body;
      const sig = init?.signal ? AbortSignal.any([init.signal, signal]) : signal;
      return t.fetch(rest, { ...init, ...(body !== undefined ? { body } : {}), signal: sig });
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
