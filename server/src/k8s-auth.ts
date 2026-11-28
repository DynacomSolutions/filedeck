import { createHash } from "node:crypto";
import fs from "node:fs";
import https from "node:https";

/**
 * Sign-in for pods: a Kubernetes projected ServiceAccount token (audience `filedeck`) in the `X-Filedeck-Token` header. The hub asks the
 * API server (TokenReview) who the token belongs to, and lets only the allowed ServiceAccounts through, for the read-only `du` scope.
 * Answers are cached by token hash until the token expires (read from its `exp`, at most MAX_TTL_MS); a refusal is cached for
 * DENY_TTL_MS. Entries leave the cache when they are looked up after their time, so no timer runs.
 */
export interface K8sAuthConfig {
  /** `ns/name` or `ns/*`; empty = off */
  allow: string[];
  audience: string;
  /** API server base URL */
  api: string;
  tokenFile: string;
  caFile: string;
}

export type Reviewed = { ok: true; namespace: string; name: string } | { ok: false; status: 401 | 403; reason: string; who?: string };
export type PostReview = (body: object) => Promise<{ status: number; json: unknown }>;

const MAX_TTL_MS = 5 * 60_000;
const DENY_TTL_MS = 30_000;
const MAX_ENTRIES = 1000;

/** A projected token is a JWT: three base64url parts. */
export const looksLikeJwt = (t: string): boolean => /^[\w-]+\.[\w-]+\.[\w-]*$/.test(t);

function expiryMs(token: string): number | undefined {
  try {
    const exp = (JSON.parse(Buffer.from(token.split(".")[1] as string, "base64url").toString()) as { exp?: unknown }).exp;
    return typeof exp === "number" ? exp * 1000 : undefined;
  } catch {
    return undefined;
  }
}

export function allowed(allow: readonly string[], namespace: string, name: string): boolean {
  return allow.some((a) => a === `${namespace}/${name}` || a === `${namespace}/*`);
}

export function defaultPost(cfg: K8sAuthConfig): PostReview {
  const url = new URL("/apis/authentication.k8s.io/v1/tokenreviews", cfg.api);
  return (body) =>
    new Promise((resolve, reject) => {
      const data = JSON.stringify(body);
      const req = https.request(
        url,
        {
          method: "POST",
          ca: fs.readFileSync(cfg.caFile),
          timeout: 10_000,
          headers: { "content-type": "application/json", "content-length": Buffer.byteLength(data), authorization: `Bearer ${fs.readFileSync(cfg.tokenFile, "utf8").trim()}` },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () => {
            try {
              resolve({ status: res.statusCode ?? 0, json: JSON.parse(Buffer.concat(chunks).toString() || "null") });
            } catch (e) {
              reject(e as Error);
            }
          });
        },
      );
      req.on("timeout", () => req.destroy(new Error("TokenReview timed out")));
      req.on("error", reject);
      req.end(data);
    });
}

export function createReviewer(cfg: K8sAuthConfig, post: PostReview = defaultPost(cfg), now: () => number = Date.now) {
  const cache = new Map<string, { until: number; result: Reviewed }>();
  return async (token: string): Promise<Reviewed> => {
    const key = createHash("sha256").update(token).digest("hex");
    const hit = cache.get(key);
    if (hit) {
      if (hit.until > now()) return hit.result;
      cache.delete(key);
    }
    const remember = (result: Reviewed, until: number) => {
      if (cache.size >= MAX_ENTRIES) cache.delete(cache.keys().next().value as string);
      cache.set(key, { until, result });
      return result;
    };
    const deny = (status: 401 | 403, reason: string, who?: string) => remember({ ok: false, status, reason, who }, now() + DENY_TTL_MS);
    let r: Awaited<ReturnType<PostReview>>;
    try {
      r = await post({ apiVersion: "authentication.k8s.io/v1", kind: "TokenReview", spec: { token, audiences: [cfg.audience] } });
    } catch (e) {
      // not cached: the API server may come back at once
      return { ok: false, status: 401, reason: `TokenReview failed: ${(e as Error).message}` };
    }
    const st = (r.json as { status?: { authenticated?: boolean; audiences?: string[]; user?: { username?: string } } } | null)?.status;
    if (r.status < 200 || r.status > 299) return { ok: false, status: 401, reason: `TokenReview answered ${r.status}` };
    if (!st?.authenticated) return deny(401, "token not authenticated");
    if (!st.audiences?.includes(cfg.audience)) return deny(401, "wrong audience");
    const m = /^system:serviceaccount:([^:]+):([^:]+)$/.exec(st.user?.username ?? "");
    if (!m) return deny(403, "not a ServiceAccount token", st.user?.username);
    const [, namespace, name] = m as unknown as [string, string, string];
    if (!allowed(cfg.allow, namespace, name)) return deny(403, "ServiceAccount is not allowed", `${namespace}/${name}`);
    return remember({ ok: true, namespace, name }, Math.min(expiryMs(token) ?? Infinity, now() + MAX_TTL_MS));
  };
}

export type Reviewer = ReturnType<typeof createReviewer>;
