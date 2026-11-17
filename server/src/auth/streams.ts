/**
 * Event streams that end with their session (hub, auth on only). A change feed (`/api/events`) is one request that stays open, so the
 * gate's check at its start does not cover the rest of its life. The hub passes each one through `track`, under the key of the session
 * it was opened with (the SHA-256 of the cookie, never the cookie). A stream ends when it is told to (sign-out, the account's sessions
 * ended, the act-as-root switch turned off), or when the check every `checkMs` finds the session no longer valid (idle or absolute
 * expiry, an epoch rise or a deleted account, also when made by another process), or, for a stream opened under the switch, the switch
 * gone. Ending a stream closes the client's body and cuts the hub's request to the agent, so the agent releases its watcher.
 * An entry is removed however the stream ends (told to, the client closes, the agent ends it), and the timer runs only while one is open.
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
  end: () => void;
}

export class LiveStreams {
  private live = new Set<Entry>();
  private timer: NodeJS.Timeout | undefined;
  private checkMs: number;
  private now: () => number;

  constructor(private o: { peek: (key: string) => boolean; checkMs?: number; now?: () => number }) {
    this.checkMs = o.checkMs ?? 60_000;
    this.now = o.now ?? Date.now;
  }

  /**
   * A response whose body is `res`'s, ended (closed) when this stream is told to end or a check finds it no longer valid. `abort` cuts
   * the upstream request; the upstream body is cancelled as well.
   */
  track(key: string, kind: "sys" | "virt", name: string, res: Response, o?: { abort?: () => void; asRoot?: AsRootStream }): Response {
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
    // the switch's end, in real time, so a root stream does not outlive it by up to one check
    if (o?.asRoot) {
      deadline = setTimeout(() => entry.end(), Math.max(0, o.asRoot.until - this.now()));
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
    try {
      return this.o.peek(e.key) && (e.asRoot === undefined || (this.now() < e.asRoot.until && e.asRoot.ok()));
    } catch {
      return true; // the store could not be read: checked again at the next tick
    }
  }

  private check(): void {
    this.endWhere((e) => !this.valid(e));
  }

  private startTimer(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.check(), this.checkMs);
    this.timer.unref();
  }

  private stopTimer(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }
}
