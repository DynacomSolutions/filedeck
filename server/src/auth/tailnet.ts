import http from "node:http";
import { BlockList, isIP } from "node:net";
import type { Context, MiddlewareHandler } from "hono";
import { getConnInfo } from "@hono/node-server/conninfo";
import { hopAddress } from "../audit.ts";
import { plainAddress } from "./limiter.ts";

/**
 * The tailnet identity of a request (docs/superpowers/specs/2026-11-18-tailscale-sign-in-design.md, "Identity sources"). This module is the
 * only reader of the two sources: tailscaled's LocalAPI socket (`whois`: login and tags) and the Tailscale Serve identity headers (login only).
 * A request has an identity only when its TCP peer is a listed Tailscale proxy (`FILEDECK_TAILSCALE_PROXIES`); `FILEDECK_TRUSTED_PROXIES` never
 * decides it. With an identity listener (`FILEDECK_TAILSCALE_LISTEN`) the connection must also have been accepted by that listener: a
 * listed loopback peer is not only the proxy (tailscaled in userspace mode forwards tailnet connections to 127.0.0.1, and any local process
 * can connect). An identity has a login, or at least one tag, or both.
 */
export type TailnetIdentity = {
  login?: string;
  displayName?: string;
  tags: string[];
  node?: { name: string; stableId: string };
  address?: string;
  source: "socket" | "headers";
};
/**
 * `none` with `node`: whois knows the device (its stable id) but it has no valid login and no valid tag, for example a tagged device whose
 * last tag was taken off. A session bound to that device ends then; a plain `none` (not a tailnet request, or a 404) keeps it.
 */
export type TailnetNone = { none: true; node?: { stableId: string } };
export type TailnetAnswer = TailnetIdentity | TailnetNone | { unavailable: true };

const NONE = Object.freeze({ none: true as const });
const UNAVAILABLE = Object.freeze({ unavailable: true as const });

const LOGIN = /^[a-z0-9!#$%&'*+/=?^_`{|}~.-]{1,64}@[a-z0-9-]+(\.[a-z0-9-]+)*$/;
const TAG = /^tag:[a-z0-9-]{1,63}$/;

/**
 * Trims only ASCII space, tab, CR and LF, refuses anything outside printable ASCII, and only then lowercases: no Unicode trimming (U+00A0,
 * U+2028, U+FEFF) or case folding (the Kelvin sign lowercases to `k`) can turn a value into a near match of a link.
 */
function asciiClean(v: string): string | null {
  const s = v.replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, "");
  return /^[\x21-\x7e]*$/.test(s) ? s.toLowerCase() : null;
}

/** A tailnet login, trimmed and lowercased, or null when it does not pass the link rules (`tagged-devices`, whois's "no user", never passes). */
export function cleanLogin(v: string): string | null {
  const s = asciiClean(v);
  return s !== null && s.length <= 254 && LOGIN.test(s) ? s : null;
}

/** A tag (`tag:name`), trimmed and lowercased, or null when it does not pass the link rules. */
export function cleanTag(v: string): string | null {
  const s = asciiClean(v);
  return s !== null && TAG.test(s) ? s : null;
}

/** An IP address without a zone id, an IPv4-mapped IPv6 address as dotted IPv4; undefined when it is not an address. */
function bareAddress(ip: string): string | undefined {
  const a = plainAddress(ip.trim().replace(/%[\w.-]*$/, ""));
  return isIP(a) ? a.toLowerCase() : undefined;
}

const family = (a: string) => (isIP(a) === 6 ? "ipv6" : "ipv4");

/** The listed Tailscale proxies: IP addresses and CIDR ranges. A bad entry throws, so the hub does not start. */
export class ProxyList {
  private list = new BlockList();

  constructor(entries: string[]) {
    for (const raw of entries) {
      const bad = () => new Error(`FILEDECK_TAILSCALE_PROXIES: "${raw}" is not an IP address or range`);
      const parts = raw.trim().split("/");
      if (parts.length > 2) throw bad();
      const addr = bareAddress(parts[0] ?? "");
      if (!addr || parts[0] !== parts[0]!.replace(/%.*$/, "")) throw bad();
      const fam = family(addr);
      if (parts.length === 1) {
        this.list.addAddress(addr, fam);
        continue;
      }
      const p = parts[1]!;
      // an IPv4-mapped IPv6 range is not taken: `bareAddress` turned the address into IPv4, and the prefix would mean something else
      if (!/^[0-9]{1,3}$/.test(p) || isIP(parts[0]!) !== isIP(addr) || Number(p) > (fam === "ipv6" ? 128 : 32)) throw bad();
      this.list.addSubnet(addr, Number(p), fam);
    }
  }

  has(ip: string): boolean {
    const a = bareAddress(ip);
    return a !== undefined && this.list.check(a, family(a));
  }
}

/** Tailscale's address ranges: an address outside them never belongs to a tailnet device. */
const TAILNET = new BlockList();
TAILNET.addSubnet("100.64.0.0", 10, "ipv4");
TAILNET.addSubnet("fd7a:115c:a1e0::", 48, "ipv6");

/** Control and format characters (and the replacement character of bad UTF-8) out, at most 128 characters; empty gives undefined. */
function cleanName(v: string): string | undefined {
  const s = [...v.replace(/[\p{Cc}\p{Cf}�]/gu, "").trim()].slice(0, 128).join("").trim();
  return s || undefined;
}

/** Decodes RFC 2047 encoded words in UTF-8 (`=?utf-8?q?…?=`, `=?utf-8?b?…?=`); other charsets and anything else stay as they are. */
export function decodeWords(v: string): string {
  const word = /=\?([^?\s]+)\?([qQbB])\?([^?\s]*)\?=/g;
  // white space between two encoded words is not part of the text (RFC 2047, 6.2)
  const joined = v.replace(/(\?=)\s+(?==\?)/g, "$1");
  return joined.replace(word, (all, charset: string, enc: string, text: string) => {
    if (!/^utf-?8$/i.test(charset.replace(/\*.*$/, ""))) return all;
    try {
      const bytes =
        enc.toLowerCase() === "b"
          ? Buffer.from(text, "base64")
          : Buffer.from(
              text.replace(/_/g, " ").replace(/=([0-9a-fA-F]{2})/g, (_m, h: string) => String.fromCharCode(parseInt(h, 16))),
              "latin1",
            );
      return bytes.toString("utf8");
    } catch {
      return all;
    }
  });
}

function peerOf(c: Context): string | undefined {
  try {
    return getConnInfo(c).remote.address;
  } catch {
    return undefined; // not served over a socket
  }
}

/** How often a header occurs in the request as it came in: the node request's raw list when there is one, else (no node request) a comma marks a joined value. */
function occurrences(c: Context, name: string): number {
  const raw = (c.env as { incoming?: { rawHeaders?: string[] } } | undefined)?.incoming?.rawHeaders;
  if (Array.isArray(raw)) {
    let n = 0;
    for (let i = 0; i < raw.length; i += 2) if (raw[i]?.toLowerCase() === name) n++;
    return n;
  }
  const v = c.req.raw.headers.get(name);
  return v === null ? 0 : v.includes(",") ? 2 : 1;
}

type Whois = TailnetIdentity | TailnetNone;

/** whois calls at once */
const MAX_CALLS = 8;
/** call slots a background check never takes, so a foreground identify finds one free */
const FOREGROUND_SLOTS = 2;
/** a background check does not ask again this soon for an address its last call found unavailable */
const BACKGROUND_FAIL_MS = 5_000;

/**
 * What the sources read from a request, taken in one go (`TailnetSource.inputOf`): the TCP peer, the X-Forwarded-For chain and the
 * login and name headers with how often each came. `readTailnet` takes it before any later middleware runs, so none of them can change
 * the identity, and the whois call can still wait until something asks.
 */
export type TailnetInput = {
  peer: string | undefined;
  /** the connection was accepted by the identity listener (`TailnetSource.acceptOn`); never read from the request itself */
  listener: boolean;
  forwardedFor: string | null;
  login: { count: number; value: string | null };
  name: { count: number; value: string | null };
};

/** The source the hub uses, its listed proxies, and a 10-second cache of whois answers per address. */
export class TailnetSource {
  readonly mode: "socket" | "headers" | null;
  private socket: string | undefined;
  private proxies: ProxyList;
  private timeoutMs: number;
  private cacheMs: number;
  private maxCache: number;
  private now: () => number;
  private log: (s: string) => void;
  private cache = new Map<string, { at: number; answer: Whois }>(); // insertion order = oldest first
  private inflight = new Map<string, Promise<Whois | typeof UNAVAILABLE>>();
  private running = 0;
  private queue: (() => void)[] = []; // waiters for a call slot, first come first served
  private loggedAt = -Infinity;
  /** when a background check last found the source unavailable, per address (insertion order = oldest first) */
  private backgroundFailed = new Map<string, number>();
  /** an identity only on connections the identity listener accepted (FILEDECK_TAILSCALE_LISTEN is set) */
  readonly listenerOnly: boolean;
  /** the connections the identity listener accepted (`acceptOn`) */
  private accepted = new WeakSet<object>();

  constructor(o: {
    socket?: string;
    headers: boolean;
    proxies: ProxyList;
    listenerOnly?: boolean;
    timeoutMs?: number;
    cacheMs?: number;
    maxCache?: number;
    now?: () => number;
    log?: (s: string) => void;
  }) {
    this.socket = o.socket || undefined;
    this.mode = this.socket ? "socket" : o.headers ? "headers" : null; // the socket wins; there is never a fallback to the headers
    this.proxies = o.proxies;
    this.listenerOnly = o.listenerOnly === true;
    this.timeoutMs = o.timeoutMs ?? 2000;
    this.cacheMs = o.cacheMs ?? 10_000;
    this.maxCache = Math.max(1, o.maxCache ?? 1024);
    this.now = o.now ?? Date.now;
    this.log = o.log ?? ((s) => console.warn(s));
  }

  /**
   * Marks each connection `server` accepts as one of the identity listener (FILEDECK_TAILSCALE_LISTEN). Call it before the server listens.
   * The mark is on the socket object, at accept time: nothing in a request can set it.
   */
  acceptOn(server: { on(event: "connection", fn: (socket: object) => void): unknown }): void {
    server.on("connection", (socket) => this.accepted.add(socket));
  }

  /** What the sources need from the request, read now (see `TailnetInput`). */
  inputOf(c: Context): TailnetInput {
    const h = c.req.raw.headers;
    const socket = (c.env as { incoming?: { socket?: unknown } } | undefined)?.incoming?.socket;
    return {
      peer: peerOf(c),
      listener: typeof socket === "object" && socket !== null && this.accepted.has(socket),
      forwardedFor: h.get("x-forwarded-for"),
      login: { count: occurrences(c, "tailscale-user-login"), value: h.get("tailscale-user-login") },
      name: { count: occurrences(c, "tailscale-user-name"), value: h.get("tailscale-user-name") },
    };
  }

  /** The identity of this request. Never throws. */
  async identify(c: Context): Promise<TailnetAnswer> {
    let input: TailnetInput;
    try {
      input = this.inputOf(c);
    } catch {
      return this.mode === "socket" ? UNAVAILABLE : NONE;
    }
    return this.identifyInput(input);
  }

  /**
   * The identity of a request from what `inputOf` read. Never throws. `background`: a check nobody waits for (the hub's check of an open
   * stream). It never waits for a call slot and never takes the last `FOREGROUND_SLOTS` of them, so a sign-in or a request is not queued
   * behind it; with no slot free, or a failure of its own for the address within `BACKGROUND_FAIL_MS`, it answers `unavailable` at once
   * (which keeps the stream).
   */
  async identifyInput(input: TailnetInput, o: { background?: boolean } = {}): Promise<TailnetAnswer> {
    try {
      if (this.mode === null) return NONE;
      const peer = input.peer;
      if (!peer || !this.proxies.has(peer)) return NONE; // only the TCP peer decides, never a header
      if (this.listenerOnly && !input.listener) return NONE; // and, with an identity listener, the listener that accepted the connection
      return this.mode === "headers" ? this.fromHeaders(input) : await this.fromSocket(input, o.background === true);
    } catch {
      return this.mode === "socket" ? UNAVAILABLE : NONE;
    }
  }

  /**
   * The identity the socket source gives for a tailnet address now, with no request (a background check, through the same cache and
   * call slots as a stream's). Undefined mode answers `none`; the headers source cannot be asked without a request, so it also answers `none`.
   */
  async identifyAddress(address: string): Promise<TailnetAnswer> {
    if (this.mode !== "socket") return NONE;
    try {
      return await this.fromSocket({ peer: undefined, listener: false, forwardedFor: address, login: { count: 0, value: null }, name: { count: 0, value: null } }, true);
    } catch {
      return UNAVAILABLE;
    }
  }

  private fromHeaders(input: TailnetInput): TailnetAnswer {
    if (input.login.count !== 1) return NONE;
    const login = cleanLogin(input.login.value ?? "");
    if (!login) return NONE;
    const rawName = input.name.count === 1 ? input.name.value : null;
    const displayName = rawName ? cleanName(decodeWords(rawName)) : undefined;
    return { login, ...(displayName ? { displayName } : {}), tags: [], source: "headers" };
  }

  private async fromSocket(input: TailnetInput, background = false): Promise<TailnetAnswer> {
    // the address the listed proxy wrote: the last entry, whatever FILEDECK_TRUSTED_PROXIES says
    const chain = input.forwardedFor;
    const last = chain ? hopAddress(chain.split(",").at(-1)) : undefined;
    const addr = last ? bareAddress(last) : undefined;
    if (!addr || !TAILNET.check(addr, family(addr))) return NONE;
    const hit = this.cache.get(addr);
    if (hit && this.now() - hit.at < this.cacheMs) return hit.answer;
    let p = this.inflight.get(addr);
    if (!p) {
      if (background) {
        const failed = this.backgroundFailed.get(addr);
        if (failed !== undefined && this.now() - failed < BACKGROUND_FAIL_MS) return UNAVAILABLE;
        if (this.running >= MAX_CALLS - FOREGROUND_SLOTS) return UNAVAILABLE; // no free slot for it: skip this round
      }
      p = this.whois(addr).finally(() => this.inflight.delete(addr));
      this.inflight.set(addr, p);
    }
    const a = await p;
    if (background && "unavailable" in a) {
      this.backgroundFailed.delete(addr);
      this.backgroundFailed.set(addr, this.now());
      while (this.backgroundFailed.size > this.maxCache) this.backgroundFailed.delete(this.backgroundFailed.keys().next().value!);
    }
    return a;
  }

  /**
   * A call slot by `deadline` (at most 8 whois calls at once; the rest wait their turn); false when the deadline passes first. A slot that is
   * given back goes straight to the next waiter, and a waiter that gives up leaves the queue, so no slot is ever lost.
   */
  private slot(deadline: number): Promise<boolean> {
    if (this.running < MAX_CALLS) {
      this.running++;
      return Promise.resolve(true);
    }
    return new Promise<boolean>((resolve) => {
      const grant = () => {
        clearTimeout(timer);
        resolve(true);
      };
      const timer = setTimeout(() => {
        const i = this.queue.indexOf(grant);
        if (i >= 0) this.queue.splice(i, 1);
        resolve(false);
      }, Math.max(0, deadline - Date.now()));
      this.queue.push(grant);
    });
  }

  private release(): void {
    const next = this.queue.shift();
    if (next) next(); // the slot passes on; `running` stays
    else this.running--;
  }

  /** One whois call within `timeoutMs` in all, the wait for a slot included. */
  private async limitedAsk(addr: string): ReturnType<TailnetSource["ask"]> {
    const deadline = Date.now() + this.timeoutMs;
    if (!(await this.slot(deadline))) return { fail: "timeout" };
    try {
      const left = deadline - Date.now();
      return left > 0 ? await this.ask(addr, left) : { fail: "timeout" };
    } finally {
      this.release();
    }
  }

  private async whois(addr: string): Promise<Whois | typeof UNAVAILABLE> {
    const r = await this.limitedAsk(addr);
    if ("fail" in r) {
      const t = this.now();
      if (t - this.loggedAt >= 60_000) {
        this.loggedAt = t;
        this.log(`tailnet: the tailscaled socket did not answer (${r.fail})`); // never the path or the answer
      }
      return UNAVAILABLE;
    }
    const answer: Whois = r.status === 404 ? NONE : parseWhois(r.body, addr);
    this.cache.delete(addr);
    this.cache.set(addr, { at: this.now(), answer });
    while (this.cache.size > this.maxCache) this.cache.delete(this.cache.keys().next().value!);
    return answer;
  }

  /** One `GET /localapi/v0/whois` over the socket: 200 with a JSON object, 404, or a failure reason without the path. */
  private ask(addr: string, timeoutMs: number): Promise<{ status: 200; body: Record<string, unknown> } | { status: 404 } | { fail: string }> {
    return new Promise((resolve) => {
      let done = false;
      const end = (v: Parameters<typeof resolve>[0]) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(v);
      };
      const req = http.request(
        { socketPath: this.socket, path: `/localapi/v0/whois?addr=${encodeURIComponent(addr)}`, method: "GET", headers: { Host: "local-tailscaled.sock" }, agent: false },
        (res) => {
          const status = res.statusCode ?? 0;
          if (status === 404) {
            res.resume();
            return end({ status: 404 });
          }
          if (status !== 200) {
            res.resume();
            return end({ fail: `status ${status}` });
          }
          const chunks: Buffer[] = [];
          let size = 0;
          res.on("data", (b: Buffer) => {
            size += b.length;
            if (size > 1024 * 1024) {
              req.destroy();
              return end({ fail: "answer too large" });
            }
            chunks.push(b);
          });
          res.on("end", () => {
            try {
              const v: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
              if (v && typeof v === "object" && !Array.isArray(v)) end({ status: 200, body: v as Record<string, unknown> });
              else end({ fail: "bad answer" });
            } catch {
              end({ fail: "bad answer" });
            }
          });
          res.on("error", () => end({ fail: "read error" }));
        },
      );
      const timer = setTimeout(() => {
        end({ fail: "timeout" });
        req.destroy();
      }, timeoutMs);
      req.on("error", (e: NodeJS.ErrnoException) => end({ fail: typeof e.code === "string" && /^[A-Z_]+$/.test(e.code) ? e.code : "error" }));
      req.end();
    });
  }
}

const obj = (v: unknown): Record<string, unknown> | undefined => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined);
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

/** The identity in a whois answer; `none` (with the device's stable id when it has a clean one) when it has neither a valid login nor a valid tag. */
function parseWhois(body: Record<string, unknown>, address: string): Whois {
  const user = obj(body.UserProfile);
  const node = obj(body.Node);
  const loginName = str(user?.LoginName);
  const login = loginName !== undefined ? cleanLogin(loginName) : null;
  const tagList = Array.isArray(node?.Tags) ? (node.Tags as unknown[]) : [];
  const tags = [...new Set(tagList.map((t) => (typeof t === "string" ? cleanTag(t) : null)).filter((t): t is string => t !== null))].sort();
  const stableId = str(node?.StableID);
  const cleanId = stableId !== undefined && stableId !== "" && cleanName(stableId) === stableId ? stableId : undefined;
  if (!login && tags.length === 0) return cleanId ? { none: true, node: { stableId: cleanId } } : NONE;
  const displayName = login ? cleanName(str(user?.DisplayName) ?? "") : undefined;
  const name = str(node?.Name);
  const nodeName = name !== undefined ? cleanName(name) : undefined;
  return {
    ...(login ? { login } : {}),
    ...(displayName ? { displayName } : {}),
    tags,
    ...(nodeName && cleanId ? { node: { name: nodeName, stableId: cleanId } } : {}),
    address,
    source: "socket",
  };
}

/**
 * The headers Tailscale Serve sets (or a client may forge): every `tailscale-user-*`, and the app capabilities, headers info and Funnel
 * marker. Nothing in Filedeck reads any of them after the identity has been read.
 */
const SERVE_HEADERS = new Set(["tailscale-app-capabilities", "tailscale-headers-info", "tailscale-funnel-request"]);
const isServeHeader = (name: string): boolean => {
  const k = name.toLowerCase();
  return k.startsWith("tailscale-user-") || SERVE_HEADERS.has(k);
};

/**
 * Deletes the Tailscale Serve headers (`isServeHeader`) from the request seen by later middleware and routes, and from the node request
 * behind it. Mount it right after the identity was read (`readTailnet`) and before anything reads the body or the signal: those make the
 * node server build its full Request, which copies the headers as they are then, and the copy would keep them.
 */
export function stripTailnetHeaders(): MiddlewareHandler {
  return named("stripTailnetHeaders", async (c, next) => {
    const h = c.req.raw.headers;
    const names: string[] = [];
    h.forEach((_v, k) => {
      if (isServeHeader(k)) names.push(k);
    });
    for (const k of names) h.delete(k);
    const incoming = (c.env as { incoming?: { headers?: Record<string, unknown> } } | undefined)?.incoming;
    if (incoming?.headers && typeof incoming.headers === "object") {
      for (const k of Object.keys(incoming.headers)) if (isServeHeader(k)) delete incoming.headers[k];
    }
    await next();
  });
}

/** `fn` with a stable name, so a test can check the order in which the hub mounts its middleware. */
function named<T extends (...a: never[]) => unknown>(name: string, fn: T): T {
  Object.defineProperty(fn, "name", { value: name });
  return fn;
}

/** The context key of a request's tailnet identity (`readTailnet`). */
const KEY = "tailnet";
const INPUT_KEY = "tailnetInput";

/**
 * Reads the request's tailnet identity once, before `stripTailnetHeaders` removes the headers, and keeps it on the context for
 * `tailnetOf`. The headers source is read here (it needs the headers); the socket source is asked only when something needs the answer
 * (it needs only the TCP peer and X-Forwarded-For, which stay), so a request that never asks costs no whois call and never waits for
 * tailscaled. With no source nothing is read.
 */
export function readTailnet(src: TailnetSource | undefined): MiddlewareHandler {
  return named("readTailnet", async (c, next) => {
    if (src && src.mode !== null) {
      // the peer, X-Forwarded-For and the headers are read now, so no later middleware can change the identity
      let input: TailnetInput | undefined;
      try {
        input = src.inputOf(c);
      } catch {
        input = undefined;
      }
      if (input) c.set(INPUT_KEY as never, input as never);
      const ask = (): Promise<TailnetAnswer> => (input ? src.identifyInput(input) : Promise.resolve(src.mode === "socket" ? UNAVAILABLE : NONE));
      let p: Promise<TailnetAnswer> | undefined = src.mode === "headers" ? Promise.resolve(await ask()) : undefined;
      const get = () => (p ??= ask());
      c.set(KEY as never, get as never);
    }
    await next();
  });
}

/** What `readTailnet` read from this request (`TailnetInput`), for a later check with `identifyInput`; undefined with no source. */
export const tailnetInputOf = (c: Context): TailnetInput | undefined => c.get(INPUT_KEY as never) as TailnetInput | undefined;

/** The identity `readTailnet` read for this request (asked once, shared); undefined when no source is configured. */
export function tailnetOf(c: Context): Promise<TailnetAnswer> | undefined {
  const get = c.get(KEY as never) as (() => Promise<TailnetAnswer>) | undefined;
  return get?.();
}
