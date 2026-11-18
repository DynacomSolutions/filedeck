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

/** `gen` changes each time a streak starts, so a reservation never touches a later streak. */
type Entry = { times: number[]; streak: number; until: number; gen: number };

const blockMs = (streak: number) => Math.min(MAX_BLOCK_MS, 2 ** (streak - LIMIT) * 1000);

/** The eight 16-bit groups of a valid IPv6 address (a dotted IPv4 tail becomes the last two groups). */
function groups6(ip: string): number[] {
  let s = ip.toLowerCase();
  const v4 = /(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (v4) {
    const [a, b, c, d] = v4.slice(1).map(Number) as [number, number, number, number];
    s = s.slice(0, v4.index) + ((a << 8) | b).toString(16) + ":" + ((c << 8) | d).toString(16);
  }
  const [head = "", tail] = s.split("::");
  const h = head ? head.split(":") : [];
  const t = tail === undefined ? null : tail ? tail.split(":") : [];
  const g = t === null ? h : [...h, ...Array<string>(Math.max(0, 8 - h.length - t.length)).fill("0"), ...t];
  return g.map((x) => parseInt(x, 16) || 0);
}

/**
 * A client address in its plain form: an IPv4-mapped IPv6 address (any spelling: `::ffff:a.b.c.d`, `::ffff:c633:6402`, the long form),
 * as a dual-stack socket gives an IPv4 client, becomes dotted IPv4; any other string is returned as it is. The hub's limiter and
 * loopback check, the address it sends for PAM and the agent's PAM check all use it, so a rule for an IPv4 network matches.
 */
export function plainAddress(ip: string): string {
  if (isIP(ip) !== 6) return ip;
  const g = groups6(ip);
  if (g.length === 8 && g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) {
    const [hi, lo] = [g[6] as number, g[7] as number];
    return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  }
  return ip;
}

/** The limiter key of a client address: an IPv6 address by its first 64 bits, an IPv4-mapped one (any form) as dotted IPv4. */
export function addressKey(ip: string): string {
  const plain = plainAddress(ip);
  if (isIP(plain) !== 6) return plain;
  return groups6(plain).slice(0, 4).map((x) => x.toString(16)).join(":") + "::/64";
}

/**
 * The families of name keys. A name typed in a sign-in body is always a `name` key; a Tailscale sign-in counts under its login or tags
 * in the `tailnet` family, which no typed name can reach, so failed password guesses never block someone's Tailscale sign-in.
 */
export type NameFamily = "name" | "tailnet";
const nameKey = (name: string, family: NameFamily = "name") => (family === "tailnet" ? "t:" : "n:") + name.slice(0, MAX_NAME);
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

  check(name: string, ip: string, family: NameFamily = "name"): { ok: true } | { ok: false; retryAfterMs: number } {
    const t = this.now();
    let wait = 0;
    for (const k of [nameKey(name, family), ipKey(ip)]) {
      const e = this.live(k, t);
      if (e && e.streak > 0) wait = Math.max(wait, e.until - t);
    }
    return wait > 0 ? { ok: false, retryAfterMs: wait } : { ok: true };
  }

  /** Counts a failure now; call `succeed` on the result when the credentials turn out good. */
  reserve(name: string, ip: string, family: NameFamily = "name"): Reservation {
    const t = this.now();
    const ik = ipKey(ip);
    this.record(nameKey(name, family), t);
    const own = this.record(ik, t);
    if (this.keys.size > this.maxKeys) this.prune(t);
    return {
      // Undoes only what this attempt did to the address; failures that came in meanwhile stay.
      succeed: () => {
        this.succeed(name, family);
        const e = this.keys.get(ik);
        if (!e) return;
        const i = e.times.lastIndexOf(t);
        if (i >= 0) e.times.splice(i, 1);
        if (own.raised && e.gen === own.gen && e.streak > 0) {
          e.streak--;
          if (e.streak < LIMIT) {
            e.streak = 0;
            e.until = 0;
          }
        }
        if (e.streak === 0 && e.times.length === 0) this.keys.delete(ik);
      },
    };
  }

  /** A good sign-in clears its name. The address keeps its count, so one known account cannot reset it. */
  succeed(name: string, family: NameFamily = "name"): void {
    this.keys.delete(nameKey(name, family));
  }

  private gen = 0;

  /** Adds one failure. Says whether it raised the streak, and in which streak. */
  private record(k: string, t: number): { raised: boolean; gen: number } {
    const e = this.live(k, t) ?? { times: [], streak: 0, until: 0, gen: 0 };
    e.times.push(t);
    let raised = false;
    if (e.streak > 0) {
      e.streak++;
      raised = true;
    } else if (e.times.length >= LIMIT) {
      e.streak = LIMIT;
      e.gen = ++this.gen;
      raised = true;
    }
    if (e.streak > 0) e.until = t + blockMs(e.streak);
    this.keys.delete(k);
    this.keys.set(k, e);
    return { raised, gen: e.gen };
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

  /**
   * Brings the map down to 90% of the cap (so it does not run on every failure): forgotten keys first, then keys that
   * are not blocked, fewest failures first and oldest first among equals, then the oldest blocked keys.
   */
  private prune(t: number): void {
    const target = Math.floor(this.maxKeys * 0.9);
    for (const k of [...this.keys.keys()]) this.live(k, t);
    if (this.keys.size <= target) return;
    const open = [...this.keys].filter(([, e]) => e.streak === 0 || t >= e.until);
    open.sort((a, b) => a[1].times.length - b[1].times.length); // stable: Map order (oldest first) among equals
    for (const [k] of open) {
      if (this.keys.size <= target) return;
      this.keys.delete(k);
    }
    while (this.keys.size > target) this.keys.delete(this.keys.keys().next().value as string);
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
