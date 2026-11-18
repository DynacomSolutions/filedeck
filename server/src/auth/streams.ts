/**
 * Event streams that end with their session (hub, auth on only). A change feed (`/api/events`) is one request that stays open, so the
 * gate's check at its start does not cover the rest of its life. The hub passes each one through `track`, under the key of the session
 * it was opened with (the SHA-256 of the cookie, never the cookie). A stream ends when it is told to (sign-out, the account's sessions
 * ended, the act-as-root switch turned off), or when the check every `checkMs` finds the session no longer valid (idle or absolute
 * expiry, an epoch rise or a deleted account, also when made by another process), or, for a stream opened under the switch, the switch
 * gone. Ending a stream closes the client's body and cuts the hub's request to the agent, so the agent releases its watcher.
 * An entry is removed however the stream ends (told to, the client closes, the agent ends it), and the timer runs only while one is open.
 *
 * A stream of a Tailscale session also carries `bound`, the hub's check of the session's binding to the tailnet identity (the gate's
 * check, run from what the stream's own request carried). It runs every `bindCheckMs` while such a stream is open, never counts as use
 * of the session, and ends the stream when it says `end`.
 */

/** A stream opened under the act-as-root switch: its end, and the hub's own check that the switch still holds for it. */
export interface AsRootStream {
  until: number;
  ok: () => boolean;
}

interface Entry {
  key: string;
  kind: "sys" | "virt";
  name: string;
  asRoot?: AsRootStream;
  /** the binding check of a Tailscale session's stream: `end` ends the stream (it may end the session first) */
  bound?: () => Promise<"ok" | "end">;
  /** a binding check is running for this entry */
  binding?: boolean;
  /** the session's absolute end (created + the absolute limit), ms since the epoch */
  endsAt?: number;
  end: () => void;
}

/** The longest delay setTimeout takes as it is. */
const MAX_TIMER_MS = 2 ** 31 - 1;

export class LiveStreams {
  private live = new Set<Entry>();
  private timer: NodeJS.Timeout | undefined;
  private bindTimer: NodeJS.Timeout | undefined;
  private checkMs: number;
  private bindCheckMs: number;
  private now: () => number;

  constructor(private o: { peek: (key: string) => boolean; checkMs?: number; bindCheckMs?: number; now?: () => number }) {
    this.checkMs = o.checkMs ?? 60_000;
    this.bindCheckMs = o.bindCheckMs ?? 2_000;
    this.now = o.now ?? Date.now;
  }

  /**
   * A response whose body is `res`'s, ended (closed) when this stream is told to end or a check finds it no longer valid. `abort` cuts
   * the upstream request; the upstream body is cancelled as well. `endsAt` is the session's absolute end, known already, so the stream
   * ends at that time and not up to one check later (as at the end of the act-as-root switch).
   */
  track(
    key: string,
    kind: "sys" | "virt",
    name: string,
    res: Response,
    o?: { abort?: () => void; asRoot?: AsRootStream; endsAt?: number; bound?: () => Promise<"ok" | "end"> },
  ): Response {
    if (!res.body) return res;
    const reader = res.body.getReader();
    let done = false;
    let ctl!: ReadableStreamDefaultController<Uint8Array>;
    let deadline: NodeJS.Timeout | undefined;
    /** Removes the entry; true only the first time. */
    const finish = (): boolean => {
      if (done) return false;
      done = true;
      clearTimeout(deadline);
      this.live.delete(entry);
      if (this.live.size === 0) this.stopTimer();
      return true;
    };
    const cutUpstream = () => {
      reader.cancel().catch(() => undefined);
      o?.abort?.();
    };
    const entry: Entry = {
      key,
      kind,
      name,
      asRoot: o?.asRoot,
      bound: o?.bound,
      endsAt: o?.endsAt,
      end: () => {
        if (!finish()) return;
        cutUpstream();
        try {
          ctl.close();
        } catch {
          /* already closed */
        }
      },
    };
    const body = new ReadableStream<Uint8Array>({
      start: (c) => {
        ctl = c;
      },
      pull: async (c) => {
        let r: ReadableStreamReadResult<Uint8Array>;
        try {
          r = await reader.read();
        } catch (e) {
          if (!finish()) return;
          o?.abort?.();
          c.error(e);
          return;
        }
        if (done) return;
        if (r.done) {
          finish();
          c.close();
        } else c.enqueue(r.value);
      },
      // the client went away
      cancel: () => {
        if (finish()) cutUpstream();
      },
    });
    this.live.add(entry);
    this.startTimer();
    // the session or the switch may have ended while the agent was asked (its end was told before the stream was here to hear it)
    if (!this.valid(entry)) {
      entry.end();
      return new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers });
    }
    // the session's absolute end and the switch's end, in real time, so the stream does not outlive either by up to one check
    // (a time beyond what a timer can hold, about 24.8 days, is left to the check: a longer delay would fire at once)
    const wait = Math.min(o?.endsAt ?? Infinity, o?.asRoot?.until ?? Infinity) - this.now();
    if (wait <= MAX_TIMER_MS) {
      deadline = setTimeout(() => entry.end(), Math.max(0, wait));
      deadline.unref();
    }
    return new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers });
  }

  /** Ends every stream of the session kept under `key` (sign-out). */
  endSession(key: string): void {
    this.endWhere((e) => e.key === key);
  }

  /** Ends the streams of the session under `key` that were opened under the act-as-root switch (the switch was turned off or changed). */
  endAsRoot(key: string): void {
    this.endWhere((e) => e.key === key && e.asRoot !== undefined);
  }

  /** Ends every stream of an account (its sessions were ended). */
  endAccount(kind: "sys" | "virt", name: string): void {
    this.endWhere((e) => e.kind === kind && e.name === name);
  }

  size(): number {
    return this.live.size;
  }

  /** Ends every stream and stops the timers (hub shutdown). */
  close(): void {
    this.endWhere(() => true);
    this.stopTimer();
  }

  private endWhere(pick: (e: Entry) => boolean): void {
    for (const e of [...this.live]) if (pick(e)) e.end();
  }

  private valid(e: Entry): boolean {
    const t = this.now();
    if (e.endsAt !== undefined && t >= e.endsAt) return false;
    try {
      return this.o.peek(e.key) && (e.asRoot === undefined || (t < e.asRoot.until && e.asRoot.ok()));
    } catch {
      // On purpose: a store that cannot be read keeps the stream until the next tick. The gate then refuses every new request anyway
      // (it reads the same store), and sign-out, ending sessions and hub shutdown still end streams through their own paths.
      return true;
    }
  }

  private check(): void {
    this.endWhere((e) => !this.valid(e));
  }

  /** Runs the binding check of every stream that has one (one at a time per stream); a check that fails keeps the stream. */
  private checkBound(): void {
    for (const e of this.live) {
      if (!e.bound || e.binding) continue;
      e.binding = true;
      e.bound()
        .then((r) => {
          if (r === "end") e.end();
        })
        .catch(() => undefined)
        .finally(() => {
          e.binding = false;
        });
    }
  }

  private startTimer(): void {
    if (!this.timer) {
      this.timer = setInterval(() => this.check(), this.checkMs);
      this.timer.unref();
    }
    if (!this.bindTimer && [...this.live].some((e) => e.bound)) {
      this.bindTimer = setInterval(() => this.checkBound(), this.bindCheckMs);
      this.bindTimer.unref();
    }
  }

  private stopTimer(): void {
    clearInterval(this.timer);
    this.timer = undefined;
    clearInterval(this.bindTimer);
    this.bindTimer = undefined;
  }
}
