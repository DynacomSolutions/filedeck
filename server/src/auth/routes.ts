import { randomBytes } from "node:crypto";
import type { Context, Hono, MiddlewareHandler } from "hono";
import { getCookie } from "hono/cookie";
import { getConnInfo } from "@hono/node-server/conninfo";
import type { Config } from "../config.ts";
import { clientOf } from "../audit.ts";
import type { Identity } from "./identity.ts";
import { checkPassword, type Accounts, type AuthDb } from "./store.ts";
import type { Sessions } from "./sessions.ts";
import { loginMessage, parsePublicKey, verifyLogin, type Challenges } from "./sshkey.ts";
import { RateWindow, type LoginLimiter } from "./limiter.ts";
import { currentUser, runAs } from "./context.ts";

/**
 * Sign-in routes and the gate on the hub. With auth off only `GET /api/auth/me` exists (it says `{auth:false}`)
 * and nothing is gated. With auth on every request needs a session cookie or the API token, except the health
 * probe, the web app's own files and the sign-in routes themselves.
 */

/** Checks a system user's password or key. Part 2 does this on an agent. */
export interface SystemAuth {
  password(name: string, pw: string): Promise<boolean>;
  key(name: string, pub: string, msg: Buffer, sig: Buffer): Promise<boolean>;
}

/** No system sign-in yet. The password is still hashed once, so a system name takes as long as a virtual one. */
export const unavailableSystemAuth: SystemAuth = {
  password: async (_name, pw) => {
    checkPassword(pw, null);
    return false;
  },
  key: async () => false,
};

export const COOKIE = "__Host-filedeck";
const COOKIE_ATTRS = "Path=/; HttpOnly; Secure; SameSite=Lax";
/** No failed sign-in answers sooner than this after the request arrived. */
const FAIL_FLOOR_MS = 500;
/** Challenges one client address may ask for per minute. */
const CHALLENGES_PER_MINUTE = 20;
/** A challenge for a longer name is answered but not kept. */
const MAX_NAME = 256;

const AUTH_ROUTES = new Set(["/api/auth/me", "/api/auth/login", "/api/auth/challenge", "/api/auth/login-key", "/api/auth/logout"]);

export interface AuthDeps {
  cfg: Config;
  db: AuthDb;
  accounts: Accounts;
  sessions: Sessions;
  challenges: Challenges;
  limiter: LoginLimiter;
  system: SystemAuth;
  /** clock for the challenge limit (tests) */
  now?: () => number;
}

/** Notes when the request arrived, so the floor on failed sign-ins counts the time spent before the route. Put it first. */
export const markArrival = (): MiddlewareHandler => async (c, next) => {
  c.set("authArrival" as never, performance.now() as never);
  await next();
};

/** The identity of an account: a virtual account if one has the name, else the system user. */
export function identityFor(cfg: Config, accounts: Accounts, name: string): Identity {
  return accounts.identity("virt", name) ?? sysIdentity(cfg, accounts, name);
}

function sysIdentity(cfg: Config, accounts: Accounts, name: string): Identity {
  return { kind: "sys", name, admin: cfg.admins.includes(name), epoch: accounts.epochOf("sys", name) };
}

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

function isLoopback(addr: string | undefined): boolean {
  if (!addr) return false;
  const a = addr.toLowerCase().replace(/^::ffff:/, "");
  return a === "::1" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(a);
}

function peerOf(c: Context): string | undefined {
  try {
    return getConnInfo(c).remote.address;
  } catch {
    return undefined; // not served over a socket
  }
}

/** Auth off: only `GET /api/auth/me`, which says so. */
export function registerAuthOff(app: Hono): void {
  app.get("/api/auth/me", (c) => c.json({ auth: false }));
}

export function registerAuth(app: Hono, deps: AuthDeps): void {
  const { cfg, accounts, sessions, challenges, limiter, system } = deps;

  if (!cfg.auth) return registerAuthOff(app);

  const challengeLimit = new RateWindow(CHALLENGES_PER_MINUTE, 60_000, deps.now);

  const signedOut = (c: Context) => c.json({ error: "signed out" }, 401, { "x-filedeck-auth": "signed-out" });

  /** The identity of the session cookie, or undefined. */
  const sessionIdentity = (c: Context): Identity | undefined => {
    const raw = getCookie(c, COOKIE);
    if (!raw) return undefined;
    const s = sessions.lookup(raw);
    if (!s) return undefined;
    return s.kind === "virt" ? accounts.identity("virt", s.name) : sysIdentity(cfg, accounts, s.name);
  };

  const admit = (c: Context, id: Identity, next: () => Promise<void>) => {
    c.set("user" as never, { kind: id.kind, name: id.name } as never);
    return runAs(id, next);
  };

  // The gate. Runs after the API token check, which already set the identity for a token request.
  app.use("*", async (c, next) => {
    if (currentUser()) return next();
    const p = c.req.path;
    const m = c.req.method;
    if (AUTH_ROUTES.has(p)) {
      const id = sessionIdentity(c);
      return id ? admit(c, id, next) : next();
    }
    // The health probe, the app shell (also for a deep link) and the build's public files. Only /api/ carries data.
    if ((m === "GET" || m === "HEAD") && p !== "/api" && !p.startsWith("/api/")) return next();
    const id = sessionIdentity(c);
    return id ? admit(c, id, next) : signedOut(c);
  });

  /**
   * HTTPS: the URL, or the last X-Forwarded-Proto behind a trusted proxy. A loopback peer on plain HTTP counts only
   * without proxies: with one, the peer is the proxy, and it may be on the same host while the client is not.
   */
  const secure = (c: Context): boolean => {
    if (new URL(c.req.url).protocol === "https:") return true;
    if (cfg.trustedProxies > 0) {
      const last = c.req.header("x-forwarded-proto")?.split(",").pop()?.trim().toLowerCase();
      return last === "https";
    }
    return isLoopback(peerOf(c));
  };

  /** Holds a failed answer until FAIL_FLOOR_MS after the request arrived (real time, not the injected clock). */
  const held = async (c: Context, res: Response): Promise<Response> => {
    const t0 = (c.get("authArrival" as never) as number | undefined) ?? performance.now();
    const wait = FAIL_FLOOR_MS - (performance.now() - t0);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    return res;
  };
  const failed = (c: Context) => held(c, c.json({ error: "sign-in failed" }, 401));
  const tooMany = (c: Context, ms: number, floor = true) => {
    const res = c.json({ error: "too many attempts" }, 429, { "retry-after": String(Math.max(1, Math.ceil(ms / 1000))) });
    return floor ? held(c, res) : res;
  };
  const needsHttps = (c: Context) => held(c, c.json({ error: "sign-in needs HTTPS" }, 403));

  const body = async (c: Context) => (await c.req.json().catch(() => null)) as Record<string, unknown> | null;

  const signIn = (c: Context, kind: "sys" | "virt", name: string) => {
    const old = getCookie(c, COOKIE);
    if (old) sessions.destroy(old);
    limiter.succeed(name);
    const raw = sessions.create(kind, name);
    const id = kind === "virt" ? accounts.identity("virt", name) : sysIdentity(cfg, accounts, name);
    const maxAge = Math.floor(cfg.sessionMaxMs / 1000);
    return c.json({ auth: true, kind, name, admin: id?.admin ?? false }, 200, { "set-cookie": `${COOKIE}=${raw}; Max-Age=${maxAge}; ${COOKIE_ATTRS}` });
  };

  app.get("/api/auth/me", (c) => {
    const id = currentUser();
    if (!id) return signedOut(c);
    return c.json({ auth: true, kind: id.kind, name: id.name, admin: id.admin });
  });

  app.post("/api/auth/login", async (c) => {
    if (!secure(c)) return needsHttps(c);
    const b = await body(c);
    const name = str(b?.name);
    const pw = str(b?.password);
    const ip = clientOf(c).ip ?? "";
    const lim = limiter.check(name ?? "", ip);
    if (!lim.ok) return tooMany(c, lim.retryAfterMs);
    let kind: "sys" | "virt" | undefined;
    if (name !== undefined && pw !== undefined && name !== "root") {
      const acc = accounts.get(name);
      if (acc) kind = checkPassword(pw, acc.passwordHash) ? "virt" : undefined;
      else kind = (await system.password(name, pw)) ? "sys" : undefined;
    }
    if (!kind || name === undefined) {
      limiter.fail(name ?? "", ip);
      return failed(c);
    }
    return signIn(c, kind, name);
  });

  app.post("/api/auth/challenge", async (c) => {
    if (!secure(c)) return needsHttps(c);
    const lim = challengeLimit.take(clientOf(c).ip ?? "");
    if (!lim.ok) return tooMany(c, lim.retryAfterMs, false);
    const name = str((await body(c))?.name);
    // Always an answer of the same shape, so it does not show whether the name exists.
    const ch = name !== undefined && name.length <= MAX_NAME ? challenges.issue(name) : randomBytes(32);
    return c.json({ challenge: ch.toString("base64"), hubId: deps.db.hubId });
  });

  app.post("/api/auth/login-key", async (c) => {
    if (!secure(c)) return needsHttps(c);
    const b = await body(c);
    const name = str(b?.name);
    const pub = str(b?.publicKey);
    const ch = str(b?.challenge);
    const sig = str(b?.signature);
    const ip = clientOf(c).ip ?? "";
    const lim = limiter.check(name ?? "", ip);
    if (!lim.ok) return tooMany(c, lim.retryAfterMs);
    let kind: "sys" | "virt" | undefined;
    if (name !== undefined && pub !== undefined && ch !== undefined && sig !== undefined && name !== "root") {
      const cb = Buffer.from(ch, "base64");
      if (challenges.take(name, cb)) {
        const msg = loginMessage(deps.db.hubId, name, cb);
        const sb = Buffer.from(sig, "base64");
        if (accounts.get(name)) {
          const given = parsePublicKey(pub);
          const listed = given !== null && accounts.keys(name).some((k) => parsePublicKey(k)?.blob.equals(given.blob));
          kind = listed && verifyLogin(given, msg, sb) ? "virt" : undefined;
        } else kind = (await system.key(name, pub, msg, sb)) ? "sys" : undefined;
      }
    }
    if (!kind || name === undefined) {
      limiter.fail(name ?? "", ip);
      return failed(c);
    }
    return signIn(c, kind, name);
  });

  app.post("/api/auth/logout", (c) => {
    const raw = getCookie(c, COOKIE);
    if (raw) sessions.destroy(raw);
    return c.json({ ok: true }, 200, { "set-cookie": `${COOKIE}=; Max-Age=0; ${COOKIE_ATTRS}` });
  });
}
