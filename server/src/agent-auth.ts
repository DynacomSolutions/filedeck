import { createHash, timingSafeEqual } from "node:crypto";
import type { MiddlewareHandler } from "hono";
import { currentUser } from "./auth/context.ts";
import { claimFor, signClaim, verifyClaim, USER_HEADER, type Identity, type UserClaim } from "./auth/identity.ts";
import type { Config } from "./config.ts";

/**
 * Optional shared secret between the hub and the agents (FILEDECK_AGENT_TOKEN
 * on both). When set, an agent answers 401 to every request that does not
 * carry `Authorization: Bearer <token>`, except the unauthenticated liveness
 * probe `/healthz` and `/metrics`. `/metrics` is scraped by pod IP without credentials and exposes only the two 0/1 size-store gauges (keep it that way:
 * nothing that names a path, a node or a size may be added to it). It sits behind the NetworkPolicy as a second layer: a pod
 * that is allowed to reach an agent still cannot use it without the secret.
 */
const digest = (s: string) => createHash("sha256").update(s).digest();

export function agentAuth(token: string | undefined): MiddlewareHandler {
  if (!token) return (_c, next) => next();
  const want = digest(token);
  return async (c, next) => {
    if (c.req.path === "/healthz" || c.req.path === "/metrics") return next();
    const m = /^Bearer (.+)$/.exec(c.req.header("authorization") ?? "");
    if (!m || !timingSafeEqual(digest(m[1] as string), want)) return c.json({ error: "unauthorized" }, 401);
    return next();
  };
}

declare module "hono" {
  /** `user`: who is behind the request. The hub stores kind and name; an agent stores the whole verified claim. Only with auth on. */
  interface ContextVariableMap {
    user: Pick<UserClaim, "kind" | "name"> & Partial<UserClaim>;
  }
}

/**
 * With auth on, every request except the two open probes (the same two paths the hub sends without a user) must carry a
 * claim signed with the agent token and still fresh. A bad, missing or stale header gives 401 `no user`; neither the
 * header nor its MAC is ever logged or echoed. The verified claim is stored for the audit and the routes. Part 2 enforces
 * its `runAs` and `grants`; here it is only verified and kept. Mount it right after `agentAuth`. Off: nothing is checked.
 */
export function agentUser(cfg: Config): MiddlewareHandler {
  if (!cfg.auth) return (_c, next) => next();
  const token = cfg.agentToken;
  return async (c, next) => {
    if (c.req.path === "/healthz" || c.req.path === "/metrics") return next();
    const value = c.req.header(USER_HEADER);
    const claim = token && value ? verifyClaim(value, token, Date.now()) : null;
    if (!claim) return c.json({ error: "no user" }, 401);
    c.set("user", claim);
    return next();
  };
}

/** The person behind a hub call has no access to the node it is for. Routes answer 403 before anything is sent. */
export class NoAccessError extends Error {
  constructor() {
    super("no access to this machine");
  }
}

/**
 * Whether an account may use a node at all. A system account may use every node in this part (part 2 narrows it to the
 * machines where the account exists); a virtual account only the nodes it has access on. With auth off there is no
 * account, and every node is open as before.
 */
export function canUseNode(id: Identity | undefined, node: string): boolean {
  if (!id || id.kind === "sys") return true;
  return Object.hasOwn(id.nodes, node);
}

/**
 * Headers for a hub request to an agent: the caller's own Authorization is replaced, never forwarded. When a person is
 * behind the call (`currentUser()`), it also carries their signed claim for `node`; any copy already in `init` is replaced.
 * `requireUser` (the hub passes `cfg.auth`) turns a call with nobody behind it into an error, so a code path that lost the
 * identity fails loudly instead of reaching the agent unnamed.
 */
export function withAgentToken(init: RequestInit | undefined, token: string | undefined, node: string, requireUser = false): RequestInit | undefined {
  const id = currentUser();
  if (requireUser && !id) throw new Error("agent call without an identity");
  if (!token) return init;
  const headers = new Headers(init?.headers);
  headers.set("authorization", `Bearer ${token}`);
  headers.delete(USER_HEADER);
  if (id) {
    const claim = claimFor(id, node, Date.now());
    if (!claim) throw new NoAccessError();
    headers.set(USER_HEADER, signClaim(claim, token));
  }
  return { ...init, headers };
}
