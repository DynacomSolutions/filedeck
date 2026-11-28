import { createHash, timingSafeEqual } from "node:crypto";
import type { MiddlewareHandler } from "hono";
import type { Identity } from "./auth/identity.ts";
import { runAs } from "./auth/context.ts";
import { looksLikeJwt, type Reviewer } from "./k8s-auth.ts";

/**
 * Optional read-only token (FILEDECK_API_TOKEN on the hub), sent as `X-Filedeck-Token: <token>`. What it may read is set by its scopes
 * (FILEDECK_API_TOKEN_SCOPES, default `du`): `du` is the `filedeck du` CLI, `changes` is the change event stream.
 * Authorization is never read or changed, so an ingress login keeps working. When the header is present at all (any value,
 * also empty or repeated) it must equal the token exactly, else 401; this also holds when the feature is off, so an ingress
 * rule "skip login when X-Filedeck-Token is present" can never bypass login. A matching token may call only
 * with scope `du`: `GET /api/nodes/<node>/api/du` and `GET /api/nodes/<node>/api/jobs/<id>` (du jobs only);
 * with scope `groups`: `GET /api/groups` (storage totals only);
 * with scope `changes`: `GET /api/v1/changes` and `GET /api/nodes/<node>/api/v1/changes`; anything else answers 403.
 * The header is removed before the request goes to an agent.
 * A Kubernetes projected ServiceAccount token (see k8s-auth.ts) may also come in this header. It is checked with `review`, may read the `du`
 * scope only (never `changes` or `groups`), and each call is written to the audit sink with the ServiceAccount. A wrong token still answers 401.
 *
 * With sign-in on, `account` gives the identity the token acts as (FILEDECK_API_TOKEN_ACCOUNT), and the rest of the
 * request runs as that identity. When there is none (the setting is unset, or names root) a matching token answers 403.
 */
const digest = (s: string) => createHash("sha256").update(s).digest();
const DU = /^\/api\/nodes\/[^/]+\/api\/du$/;
const JOB = /^\/api\/nodes\/[^/]+\/api\/jobs\/[^/]+$/;
declare module "hono" {
  interface ContextVariableMap {
    storageSizesOnly?: true;
  }
}

const CHANGES = /^\/api\/(?:v1\/changes|nodes\/[^/]+\/api\/v1\/changes)$/;

export function apiTokenAuth(token: string | undefined, account?: () => Identity | { error: string }, scopes: readonly string[] = ["du"], k8s?: { review: Reviewer; sink: (line: string) => void }): MiddlewareHandler {
  const want = token ? digest(token) : undefined;
  return async (c, next) => {
    // Headers.get joins repeated headers with ", ", which can never equal the token.
    const got = c.req.raw.headers.get("x-filedeck-token");
    if (got === null) return next();
    let after: ((status: number) => void) | undefined;
    let granted = scopes;
    if (!(want && timingSafeEqual(digest(got), want))) {
      if (!k8s || !looksLikeJwt(got)) return c.json({ error: "unauthorized" }, 401);
      const r = await k8s.review(got);
      const line = (extra: object) => k8s.sink(JSON.stringify({ audit: true, who: "hub", auth: "k8s", method: c.req.method, route: c.req.path, ...extra }));
      if (!r.ok) {
        line({ status: r.status, caller: r.who ?? null, reason: r.reason });
        return c.json({ error: r.status === 403 ? "forbidden: this ServiceAccount may not use FileDeck" : "unauthorized" }, r.status);
      }
      const sa = `${r.namespace}/${r.name}`;
      granted = ["du"];
      after = (status) => line({ status, caller: sa });
    }
    const du = granted.includes("du");
    const changes = granted.includes("changes");
    const groups = granted.includes("groups");
    const resources = [du && "folder sizes", changes && "change events", groups && "grouped storage sizes"].filter((resource) => typeof resource === "string");
    const permitted = new Intl.ListFormat("en-GB", { type: "conjunction" }).format(resources);
    const p = c.req.path;
    const allowed = c.req.method === "GET" && ((du && (DU.test(p) || JOB.test(p))) || (changes && CHANGES.test(p)) || (groups && p === "/api/groups"));
    if (!allowed) {
      const res = c.json({ error: `forbidden: this token may only read ${permitted || "no resources"}` }, 403);
      after?.(403);
      return res;
    }
    if (p === "/api/groups") c.set("storageSizesOnly", true);
    c.req.raw.headers.delete("x-filedeck-token");
    if (account) {
      const id = account();
      if ("error" in id) {
        const res = c.json({ error: id.error }, 403);
        after?.(403);
        return res;
      }
      c.set("user" as never, { kind: id.kind, name: id.name } as never);
      await runAs(id, next);
    } else await next();
    if (du && JOB.test(p) && c.res.status === 200) {
      const kind = ((await c.res.clone().json().catch(() => null)) as { kind?: string } | null)?.kind;
      if (kind !== "du") c.res = c.json({ error: "not found" }, 404);
    }
    after?.(c.res.status);
  };
}
