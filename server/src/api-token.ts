import { createHash, timingSafeEqual } from "node:crypto";
import type { MiddlewareHandler } from "hono";

/**
 * Optional read-only token for the `filedeck du` CLI (FILEDECK_API_TOKEN on the hub). A request that carries
 * `Authorization: Bearer <token>` may call only `GET /api/nodes/<node>/api/du` and `GET /api/nodes/<node>/api/jobs/<id>`
 * (and the job must be a du job); every other route answers 403 to it. A Bearer value that does not match answers 401.
 * Requests without a Bearer header are untouched, so browsers and their own authentication work as before.
 * The token is never forwarded to an agent. Unset = the feature is off and nothing here runs.
 */
const digest = (s: string) => createHash("sha256").update(s).digest();
const DU = /^\/api\/nodes\/[^/]+\/api\/du$/;
const JOB = /^\/api\/nodes\/[^/]+\/api\/jobs\/[^/]+$/;

export function apiTokenAuth(token: string | undefined): MiddlewareHandler {
  if (!token) return (_c, next) => next();
  const want = digest(token);
  return async (c, next) => {
    const m = /^Bearer (.+)$/i.exec(c.req.header("authorization") ?? "");
    if (!m) return next();
    if (!timingSafeEqual(digest(m[1] as string), want)) return c.json({ error: "unauthorized" }, 401);
    const p = c.req.path;
    if (c.req.method !== "GET" || !(DU.test(p) || JOB.test(p))) return c.json({ error: "forbidden: this token may only read folder sizes" }, 403);
    c.req.raw.headers.delete("authorization");
    await next();
    if (JOB.test(p) && c.res.status === 200) {
      const kind = ((await c.res.clone().json().catch(() => null)) as { kind?: string } | null)?.kind;
      if (kind !== "du") c.res = c.json({ error: "not found" }, 404);
    }
  };
}
