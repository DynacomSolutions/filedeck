import { createHash, timingSafeEqual } from "node:crypto";
import type { MiddlewareHandler } from "hono";
import type { Identity } from "./auth/identity.ts";
import { runAs } from "./auth/context.ts";

/**
 * Optional read-only token for the `filedeck du` CLI (FILEDECK_API_TOKEN on the hub), sent as `X-Filedeck-Token: <token>`.
 * Authorization is never read or changed, so an ingress login keeps working. When the header is present at all (any value,
 * also empty or repeated) it must equal the token exactly, else 401; this also holds when the feature is off, so an ingress
 * rule "skip login when X-Filedeck-Token is present" can never bypass login. A matching token may call only
 * `GET /api/nodes/<node>/api/du` and `GET /api/nodes/<node>/api/jobs/<id>` (du jobs only); anything else answers 403.
 * The header is removed before the request goes to an agent.
 *
 * With sign-in on, `account` gives the identity the token acts as (FILEDECK_API_TOKEN_ACCOUNT), and the rest of the
 * request runs as that identity. When that setting is unset (`account` returns undefined) a matching token answers 403.
 */
const digest = (s: string) => createHash("sha256").update(s).digest();
const DU = /^\/api\/nodes\/[^/]+\/api\/du$/;
const JOB = /^\/api\/nodes\/[^/]+\/api\/jobs\/[^/]+$/;

export function apiTokenAuth(token: string | undefined, account?: () => Identity | undefined): MiddlewareHandler {
  const want = token ? digest(token) : undefined;
  return async (c, next) => {
    // Headers.get joins repeated headers with ", ", which can never equal the token.
    const got = c.req.raw.headers.get("x-filedeck-token");
    if (got === null) return next();
    if (!want || !timingSafeEqual(digest(got), want)) return c.json({ error: "unauthorized" }, 401);
    const p = c.req.path;
    if (c.req.method !== "GET" || !(DU.test(p) || JOB.test(p))) return c.json({ error: "forbidden: this token may only read folder sizes" }, 403);
    c.req.raw.headers.delete("x-filedeck-token");
    if (account) {
      const id = account();
      if (!id) return c.json({ error: "FILEDECK_API_TOKEN_ACCOUNT is not set" }, 403);
      c.set("user" as never, { kind: id.kind, name: id.name } as never);
      await runAs(id, next);
    } else await next();
    if (JOB.test(p) && c.res.status === 200) {
      const kind = ((await c.res.clone().json().catch(() => null)) as { kind?: string } | null)?.kind;
      if (kind !== "du") c.res = c.json({ error: "not found" }, 404);
    }
  };
}
