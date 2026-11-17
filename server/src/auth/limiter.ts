/**
 * Sign-in limits. Failures are counted per name and per client address. After LIMIT failures a key is blocked for
 * 2^(failures - LIMIT) seconds from its last failure, at most MAX_BLOCK_MS. A key is forgotten after a quiet minute
 * that follows the end of its block, so the delay keeps growing while the attempts go on.
 */
const LIMIT = 5;
const WINDOW_MS = 60_000;
const MAX_BLOCK_MS = 15 * 60_000;
/** Above this many keys, the forgotten ones are removed; above it still, the oldest go first. */
const MAX_KEYS = 10_000;
/** Names are cut to this length for the key, so a long name cannot use much memory. */
const MAX_NAME = 256;

type Entry = { fails: number; last: number };

const blockMs = (fails: number) => (fails < LIMIT ? 0 : Math.min(MAX_BLOCK_MS, 2 ** (fails - LIMIT) * 1000));

export class LoginLimiter {
  private keys = new Map<string, Entry>(); // insertion order = last failure

  constructor(private now: () => number = Date.now) {}

  check(name: string, ip: string): { ok: true } | { ok: false; retryAfterMs: number } {
    const t = this.now();
    let wait = 0;
    for (const k of [nameKey(name), ipKey(ip)]) {
      const e = this.live(k, t);
      if (e && e.fails >= LIMIT) wait = Math.max(wait, e.last + blockMs(e.fails) - t);
    }
    return wait > 0 ? { ok: false, retryAfterMs: wait } : { ok: true };
  }

  fail(name: string, ip: string): void {
    const t = this.now();
    for (const k of [nameKey(name), ipKey(ip)]) {
      const e = this.live(k, t);
      this.keys.delete(k);
      this.keys.set(k, { fails: (e?.fails ?? 0) + 1, last: t });
    }
    if (this.keys.size > MAX_KEYS) this.prune(t);
  }

  /** A good sign-in clears its name. The address keeps its count, so one known account cannot reset it. */
  succeed(name: string): void {
    this.keys.delete(nameKey(name));
  }

  private live(k: string, t: number): Entry | undefined {
    const e = this.keys.get(k);
    if (e && t - e.last >= blockMs(e.fails) + WINDOW_MS) {
      this.keys.delete(k);
      return undefined;
    }
    return e;
  }

  private prune(t: number): void {
    for (const k of [...this.keys.keys()]) this.live(k, t);
    while (this.keys.size > MAX_KEYS) this.keys.delete(this.keys.keys().next().value as string);
  }
}

const nameKey = (name: string) => "n:" + name.slice(0, MAX_NAME);
const ipKey = (ip: string) => "i:" + ip;

/**
 * A plain count per key in fixed windows, for requests that are not sign-ins but cost the hub memory, such as
 * challenges. Every call counts.
 */
export class RateWindow {
  private keys = new Map<string, { n: number; start: number }>();

  constructor(
    private limit: number,
    private windowMs: number,
    private now: () => number = Date.now,
  ) {}

  take(key: string): { ok: true } | { ok: false; retryAfterMs: number } {
    const t = this.now();
    let e = this.keys.get(key);
    if (!e || t - e.start >= this.windowMs) {
      this.keys.delete(key);
      if (this.keys.size >= MAX_KEYS) this.prune(t);
      this.keys.set(key, (e = { n: 0, start: t }));
    }
    if (e.n >= this.limit) return { ok: false, retryAfterMs: e.start + this.windowMs - t };
    e.n++;
    return { ok: true };
  }

  private prune(t: number): void {
    for (const [k, e] of this.keys) if (t - e.start >= this.windowMs) this.keys.delete(k);
    while (this.keys.size >= MAX_KEYS) this.keys.delete(this.keys.keys().next().value as string);
  }
}
