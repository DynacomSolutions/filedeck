/**
 * The hub's fan-in: one NDJSON stream of the change events of several agents. Each agent gets the filter pushed down (it filters before it sends),
 * and its own `since` cursor. The lines are passed on as the agents wrote them (nothing is parsed or encoded again), so every line still names its
 * node and carries that node's cursor. Order is kept per node; between nodes it is the order of arrival.
 *
 * The hub reconnects to an agent that goes away (or that ended the stream as lagged) from the last cursor it passed on, so the client sees one
 * stream. When the client itself is too slow, the stream ends with a `lagged` line that holds a cursor for each node.
 */

export interface FanInTarget {
  node: string;
  fetch(rest: string, init?: RequestInit): Promise<Response>;
}

export interface FanInOptions {
  targets: FanInTarget[];
  /** the filter, as the agents read it (prefix, glob, kind, type, label) */
  filter: URLSearchParams;
  /** cursor per node */
  since?: Map<string, string>;
  signal?: AbortSignal;
  maxQueueBytes?: number;
  retryMs?: number;
  pingMs?: number;
}

interface Item {
  line: Buffer;
  node: string;
  cursor?: string;
}

const HEAD = Buffer.from('{"cursor":"');

/** The cursor at the start of an event line, if it has one (control lines such as `ping` do not start with it). */
function cursorOf(line: Buffer): string | undefined {
  if (line.length < HEAD.length + 2 || !line.subarray(0, HEAD.length).equals(HEAD)) return undefined;
  const end = line.indexOf(0x22, HEAD.length);
  return end < 0 ? undefined : line.toString("utf8", HEAD.length, end);
}

const kindOf = (line: Buffer): string => {
  const i = line.indexOf('"kind":"');
  if (i < 0) return "";
  const end = line.indexOf(0x22, i + 8);
  return end < 0 ? "" : line.toString("utf8", i + 8, end);
};

export function fanIn(o: FanInOptions): ReadableStream<Uint8Array> {
  const max = o.maxQueueBytes ?? 4 * 1024 * 1024;
  let queue: Item[] = [];
  let bytes = 0;
  let waiter: (() => void) | null = null;
  let ended = false;
  const delivered = new Map<string, string>();
  const stop = new AbortController();
  o.signal?.addEventListener("abort", () => finish(), { once: true });

  const wake = () => {
    const w = waiter;
    waiter = null;
    w?.();
  };
  function finish() {
    if (ended) return;
    ended = true;
    stop.abort();
    wake();
  }
  const control = (obj: Record<string, unknown>): Buffer => Buffer.from(JSON.stringify({ ...obj, time: Date.now() }) + "\n");
  const push = (it: Item) => {
    if (ended || closing) return;
    queue.push(it);
    bytes += it.line.length;
    if (bytes > max) {
      // the client is behind: it resumes each node from the last cursor it was sent
      queue = [{ node: "", line: control({ kind: "lagged", cursors: Object.fromEntries(delivered), reason: "the subscriber was too slow" }) }];
      bytes = 0;
      closing = true;
    }
    wake();
  };
  let closing = false;

  async function follow(t: FanInTarget) {
    let last = o.since?.get(t.node);
    let offline = false;
    while (!ended) {
      let status = 0;
      let lagged = false;
      try {
        const q = new URLSearchParams(o.filter);
        if (last) q.set("since", last);
        const res = await t.fetch("/api/v1/changes?" + q.toString(), { signal: stop.signal, headers: { accept: "application/x-ndjson" } });
        status = res.status;
        if (res.status !== 200) {
          void res.body?.cancel().catch(() => {});
          if (res.status >= 400 && res.status < 500 && res.status !== 429) {
            push({ node: t.node, line: control({ kind: "error", node: t.node, status: res.status, error: "the node refused the stream" }) });
            return;
          }
          throw new Error(`status ${res.status}`);
        }
        offline = false;
        const reader = res.body!.getReader();
        let rest: Buffer = Buffer.alloc(0);
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          let chunk: Buffer = rest.length ? Buffer.concat([rest, value]) : Buffer.from(value.buffer, value.byteOffset, value.byteLength);
          let from = 0;
          for (let nl = chunk.indexOf(0x0a, from); nl >= 0; nl = chunk.indexOf(0x0a, from)) {
            const line = Buffer.from(chunk.subarray(from, nl + 1));
            from = nl + 1;
            const k = cursorOf(line) ? "" : kindOf(line);
            if (k === "lagged") {
              lagged = true; // this hub was too slow for the agent: it reconnects below, from the last cursor
              continue;
            }
            const cursor = cursorOf(line);
            if (cursor) last = cursor;
            else if (k === "ping") {
              const c = /"cursor":"([^"]*)"/.exec(line.toString("utf8"))?.[1];
              if (c) last = c; // a ping's cursor: everything up to it was looked at
            }
            push({ node: t.node, line, cursor: cursor ?? undefined });
          }
          rest = Buffer.from(chunk.subarray(from));
          chunk = rest;
          if (rest.length > 1024 * 1024) rest = Buffer.alloc(0);
        }
      } catch {
        if (ended) return;
      }
      if (ended) return;
      if (lagged) continue; // (asked again at once: the agent is there)
      if (!offline) {
        offline = true;
        push({ node: t.node, line: control({ kind: "offline", node: t.node, ...(status ? { status } : {}) }) });
      }
      await new Promise((r) => {
        const timer = setTimeout(r, o.retryMs ?? 3000);
        timer.unref();
        stop.signal.addEventListener("abort", () => r(undefined), { once: true });
      });
    }
  }
  for (const t of o.targets) void follow(t);

  return new ReadableStream<Uint8Array>(
    {
      async pull(ctl) {
        for (;;) {
          if (queue.length) {
            const batch = queue;
            queue = [];
            bytes = 0;
            for (const it of batch) if (it.cursor) delivered.set(it.node, it.cursor);
            ctl.enqueue(Buffer.concat(batch.map((b) => b.line)));
            if (closing) finish();
            return;
          }
          if (ended) return ctl.close();
          await new Promise<void>((res) => {
            const t = setTimeout(() => {
              waiter = null;
              push({ node: "", line: control({ kind: "ping" }) });
              res();
            }, o.pingMs ?? 15_000);
            t.unref();
            waiter = () => {
              clearTimeout(t);
              res();
            };
          });
        }
      },
      cancel() {
        finish();
      },
    },
    { highWaterMark: 0 },
  );
}
