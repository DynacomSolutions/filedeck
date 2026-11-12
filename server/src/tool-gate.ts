import { FsError } from "./fsops.ts";

/**
 * Bounds on the archive tool processes that serve interactive requests. Compression and extraction jobs are not in here: they wait in the job
 * queue (`Jobs`) with its own pool, exactly as before, and never fail for lack of a slot. There are two pools, so that neither can starve the other
 * or the jobs:
 *  - `downloadGate`: zip downloads, which can hold a tool for as long as a client is slow to read (a download that is not read at all is ended after the
 *    stall time, see `zipStream`);
 *  - `listGate`: listings and password checks, short operations that a download must not be able to block.
 * Each pool has a total, a limit for one client (the address the server itself observed, see `clientKey` in search.ts), a short wait and a 429: a client
 * over its own limit is refused at once with a message that says so, and only that client; when the pool as a whole is full a request waits briefly and
 * is then told the server is busy.
 */
export interface Slot {
  /** give the slot back (once; later calls do nothing) */
  release(): void;
}

export interface GateOpts {
  /** processes at once, all clients together */
  concurrency: number;
  /** at once for one client */
  perClient: number;
  /** requests that may wait for a slot of the pool */
  queue: number;
  /** longest wait */
  waitMs: number;
  /** what the client is told when it is over its own limit */
  what: string;
}

export class ToolGate {
  private active = 0;
  private byClient = new Map<string, number>();
  private waiting: { go: () => void; client: string }[] = [];
  constructor(private o: GateOpts) {}

  get running(): number {
    return this.active;
  }
  get queued(): number {
    return this.waiting.length;
  }
  mine(client: string): number {
    return this.byClient.get(client) ?? 0;
  }

  private take(client: string): Slot {
    this.byClient.set(client, this.mine(client) + 1);
    let held = true;
    return {
      release: () => {
        if (!held) return;
        held = false;
        const left = this.mine(client) - 1;
        if (left <= 0) this.byClient.delete(client);
        else this.byClient.set(client, left);
        // the slot passes to the first waiter whose client is under its own limit
        const i = this.waiting.findIndex((w) => this.mine(w.client) < this.o.perClient);
        if (i >= 0) this.waiting.splice(i, 1)[0]!.go();
        else this.active--;
      },
    };
  }

  async acquire(signal?: AbortSignal, client = "-"): Promise<Slot> {
    if (signal?.aborted) throw new FsError(400, "canceled");
    if (this.mine(client) >= this.o.perClient) throw new FsError(429, `you already have ${this.mine(client)} ${this.o.what} running (the limit for one client is ${this.o.perClient}): wait for one to finish`);
    if (this.active < this.o.concurrency) {
      this.active++;
      return this.take(client);
    }
    if (this.waiting.length >= this.o.queue) throw new FsError(429, "the server is busy with other archive requests, try again shortly");
    await new Promise<void>((go, fail) => {
      const w = {
        client,
        go: () => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
          this.byClient.set(client, this.mine(client) + 1); // reserved now, so the slot is this client's before it runs
          go();
        },
      };
      const drop = () => {
        const i = this.waiting.indexOf(w);
        if (i < 0) return false;
        this.waiting.splice(i, 1);
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        return true;
      };
      const timer = setTimeout(() => drop() && fail(new FsError(429, "the server is busy with other archive requests, try again shortly")), this.o.waitMs);
      const onAbort = () => drop() && fail(new FsError(400, "canceled"));
      signal?.addEventListener("abort", onAbort, { once: true });
      this.waiting.push(w);
    });
    // `go` already counted this client; hand out the slot without counting twice
    this.byClient.set(client, this.mine(client) - 1);
    return this.take(client);
  }
}

const int = (v: string | undefined, d: number, lo: number, hi: number) => (v !== undefined && /^[0-9]{1,6}$/.test(v) ? Math.min(hi, Math.max(lo, Number(v))) : d);

/** Zip downloads: `FILEDECK_ZIP_DOWNLOADS` in all (default 16), at most 8 for one client, 8 more may wait up to 5 seconds. */
export const downloadGate = new ToolGate({ concurrency: int(process.env.FILEDECK_ZIP_DOWNLOADS, 16, 1, 256), perClient: 8, queue: 8, waitMs: 5000, what: "downloads" });
/** Listings and password checks: 8 in all, 4 for one client, 8 more may wait up to 5 seconds. */
export const listGate = new ToolGate({ concurrency: 8, perClient: 4, queue: 8, waitMs: 5000, what: "archive listings" });
