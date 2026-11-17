import { isIP } from "node:net";

/**
 * Sign-in limits, per name and per client address (an IPv6 address counts by its /64).
 *
 * A key may fail LIMIT times in any sliding window of WINDOW_MS. The failure that reaches the limit starts a streak:
 * from then on every failure blocks the key for 2^(streak - LIMIT) seconds, at most MAX_BLOCK_MS. The streak ends
 * after a quiet WINDOW_MS that follows the end of the block, so the delay keeps growing while the attempts go on.
 *
 * An attempt is counted before the slow check starts (`reserve`), so parallel guesses cannot all pass `check`.
 * A good sign-in gives the reservation back.
 */
const LIMIT = 5;
const WINDOW_MS = 60_000;
const MAX_BLOCK_MS = 15 * 60_000;
/** Above this many keys, forgotten keys go first, then the oldest key that is not blocked, then the oldest. */
const MAX_KEYS = 10_000;
/** Names are cut to this length for the key, so a long name cannot use much memory. */
const MAX_NAME = 256;

type Entry = { times: number[]; streak: number; until: number };

const blockMs = (streak: number) => Math.min(MAX_BLOCK_MS, 2 ** (streak - LIMIT) * 1000);

/** The limiter key of a client address: an IPv6 address by its first 64 bits, an IPv4-mapped one as IPv4. */
export function addressKey(ip: string): string {
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
  if (mapped) return mapped[1] as string;
  if (isIP(ip) !== 6) return ip;
  const [head = "", tail] = ip.toLowerCase().split("::");
  const h = head ? head.split(":") : [];
  const t = tail === undefined ? null : tail ? tail.split(":") : [];
  const groups = t === null ? h : [...h, ...Array<string>(Math.max(0, 8 - h.length - t.length)).fill("0"), ...t];
  return groups.slice(0, 4).map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16).toString(16) : "0")).join(":") + "::/64";
}

const nameKey = (name: string) => "n:" + name.slice(0, MAX_NAME);
const ipKey = (ip: string) => "i:" + addressKey(ip);

/** An attempt counted in advance. `succeed` gives it back: the name is cleared and the address loses this one failure. */
export interface Reservation {
  succeed(): void;
}

export class LoginLimiter {
  private keys = new Map<string, Entry>(); // insertion order = last failure

  constructor(
    private now: () => number = Date.now,
    private maxKeys = MAX_KEYS,
  ) {}

  check(name: string, ip: string): { ok: true } | { ok: false; retryAfterMs: number } {
    const t = this.now();
    let wait = 0;
    for (const k of [nameKey(name), ipKey(ip)]) {
      const e = this.live(k, t);
      if (e && e.streak > 0) wait = Math.max(wait, e.until - t);
    }
    return wait > 0 ? { ok: false, retryAfterMs: wait } : { ok: true };
  }

  fail(name: string, ip: string): void {
    this.reserve(name, ip);
  }

  /** Counts a failure now; call `succeed` on the result when the credentials turn out good. */
  reserve(name: string, ip: string): Reservation {
    const t = this.now();
    const ik = ipKey(ip);
    this.record(nameKey(name), t);
    const before = this.keys.get(ik);
    const prev = before ? { streak: before.streak, until: before.until } : undefined;
    this.record(ik, t);
    if (this.keys.size > this.maxKeys) this.prune(t);
    return {
      succeed: () => {
        this.succeed(name);
        const e = this.keys.get(ik);
        if (!e) return;
        const i = e.times.lastIndexOf(t);
        if (i >= 0) e.times.splice(i, 1);
        if (e.streak > 0) {
          e.streak = prev?.streak ?? 0;
          e.until = prev?.until ?? 0;
        }
        if (e.streak === 0 && e.times.length === 0) this.keys.delete(ik);
      },
    };
  }

  /** A good sign-in clears its name. The address keeps its count, so one known account cannot reset it. */
  succeed(name: string): void {
    this.keys.delete(nameKey(name));
  }

  private record(k: string, t: number): void {
    const e = this.live(k, t) ?? { times: [], streak: 0, until: 0 };
    e.times.push(t);
    if (e.streak > 0) e.streak++;
    else if (e.times.length >= LIMIT) e.streak = LIMIT;
    if (e.streak > 0) e.until = t + blockMs(e.streak);
    this.keys.delete(k);
    this.keys.set(k, e);
  }

  /** The entry with its old failures dropped, or undefined (and removed) when nothing about it is left. */
  private live(k: string, t: number): Entry | undefined {
    const e = this.keys.get(k);
    if (!e) return undefined;
    while (e.times.length && t - (e.times[0] as number) >= WINDOW_MS) e.times.shift();
    if (e.streak > 0 && t >= e.until + WINDOW_MS) e.streak = 0;
    if (e.streak === 0 && e.times.length === 0) {
      this.keys.delete(k);
      return undefined;
    }
    return e;
  }

  private prune(t: number): void {
    for (const k of [...this.keys.keys()]) this.live(k, t);
    if (this.keys.size <= this.maxKeys) return;
    for (const [k, e] of this.keys) {
      if (this.keys.size <= this.maxKeys) return;
      if (e.streak === 0 || t >= e.until) this.keys.delete(k);
    }
    while (this.keys.size > this.maxKeys) this.keys.delete(this.keys.keys().next().value as string);
  }
}

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
