import { FsError } from "./fsops.ts";

/**
 * A bound on the archive tool processes (bsdtar, 7-Zip) one agent runs at a time. A download that nobody reads keeps its tool alive until
 * the stall timeout of `zipStream` ends it, so without a bound such downloads could pile up. At most `concurrency` run; up to `queue` more
 * wait, each for at most `waitMs`; anything beyond that, or a wait that runs out, is a 429 that says to try again shortly.
 */
export interface Slot {
  /** give the slot back (once; later calls do nothing) */
  release(): void;
}

export class ToolGate {
  private active = 0;
  private waiting: { go: () => void }[] = [];
  constructor(private o: { concurrency: number; queue: number; waitMs: number }) {}

  get running(): number {
    return this.active;
  }
  get queued(): number {
    return this.waiting.length;
  }

  private slot(): Slot {
    let held = true;
    return {
      release: () => {
        if (!held) return;
        held = false;
        const n = this.waiting.shift();
        if (n) n.go(); // the slot passes to the next waiter
        else this.active--;
      },
    };
  }

  async acquire(signal?: AbortSignal): Promise<Slot> {
    if (signal?.aborted) throw new FsError(400, "canceled");
    if (this.active < this.o.concurrency) {
      this.active++;
      return this.slot();
    }
    if (this.waiting.length >= this.o.queue) throw new FsError(429, "too many archive operations are running, try again shortly");
    await new Promise<void>((go, fail) => {
      const w = {
        go: () => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
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
      const timer = setTimeout(() => drop() && fail(new FsError(429, "archive operations are busy, try again shortly")), this.o.waitMs);
      const onAbort = () => drop() && fail(new FsError(400, "canceled"));
      signal?.addEventListener("abort", onAbort, { once: true });
      this.waiting.push(w);
    });
    return this.slot();
  }
}

const int = (v: string | undefined, d: number, lo: number, hi: number) => (v !== undefined && /^[0-9]{1,6}$/.test(v) ? Math.min(hi, Math.max(lo, Number(v))) : d);

/**
 * The agent's one gate for every archive tool process (listing, extraction, compression, zip downloads): `FILEDECK_ARCHIVE_TOOLS` sets how
 * many run at once (default 8); 16 more may wait up to 20 s.
 */
export const toolGate = new ToolGate({ concurrency: int(process.env.FILEDECK_ARCHIVE_TOOLS, 8, 1, 256), queue: 16, waitMs: 20_000 });
