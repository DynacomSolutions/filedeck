import { createHash, timingSafeEqual } from "node:crypto";
import type { MiddlewareHandler } from "hono";

/**
 * Optional shared secret between the hub and the agents (FILEDECK_AGENT_TOKEN
 * on both). When set, an agent answers 401 to every request that does not
 * carry `Authorization: Bearer <token>`, except the unauthenticated liveness
 * probe `/healthz`. It sits behind the NetworkPolicy as a second layer: a pod
 * that is allowed to reach an agent still cannot use it without the secret.
 */
const digest = (s: string) => createHash("sha256").update(s).digest();

export function agentAuth(token: string | undefined): MiddlewareHandler {
  if (!token) return (_c, next) => next();
  const want = digest(token);
  return async (c, next) => {
    if (c.req.path === "/healthz") return next();
    const m = /^Bearer (.+)$/.exec(c.req.header("authorization") ?? "");
    if (!m || !timingSafeEqual(digest(m[1] as string), want)) return c.json({ error: "unauthorized" }, 401);
    return next();
  };
}

/** Headers for a hub request to an agent: the caller's own Authorization is replaced, never forwarded. */
export function withAgentToken(init: RequestInit | undefined, token: string | undefined): RequestInit | undefined {
  if (!token) return init;
  const headers = new Headers(init?.headers);
  headers.set("authorization", `Bearer ${token}`);
  return { ...init, headers };
}
