import { createHash } from "node:crypto";
import type { MiddlewareHandler } from "hono";
import { compress } from "hono/compress";
import type { Brand } from "./brand.ts";

/**
 * Response headers and compression for the hub's web surface (the SPA shell,
 * its static files and the API). Nothing here reads a request body or a file.
 */

/** Content-Security-Policy of the SPA shell: scripts only from this origin plus the page's own inline theme script (by hash). */
export function shellCsp(html: string, brand: Brand): string {
  const hashes = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => `'sha256-${createHash("sha256").update(m[1] as string).digest("base64")}'`);
  const origin = (u: string | undefined) => (u && /^https:\/\//.test(u) ? new URL(u).origin : "");
  const extra = (u: string | undefined) => (origin(u) ? ` ${origin(u)}` : "");
  return [
    "default-src 'self'",
    `script-src 'self' ${hashes.join(" ")}`.trim(),
    `style-src 'self' 'unsafe-inline'${extra(brand.css)}`, // Monaco and the layout set inline styles
    `img-src 'self' data: blob:${extra(brand.icon)}`,
    "font-src 'self' data:",
    "media-src 'self' blob:",
    "connect-src 'self' blob: data:",
    "worker-src 'self' blob:", // the editor's language workers
    "frame-src 'self'", // the PDF preview frames a file of this origin
    "manifest-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
}

const HASHED_ASSET = /^\/assets\/[^/]+-[A-Za-z0-9_-]{8}\.[A-Za-z0-9]+$/;

/** Cache-Control for a static file: build output with a content hash in its name never changes. */
export function staticCacheControl(urlPath: string): string | undefined {
  return HASHED_ASSET.test(urlPath) ? "public, max-age=31536000, immutable" : undefined;
}

/**
 * Hardening headers on every response. The SPA shell gets the full CSP and a
 * frame ban in `shell`; API responses are never cached and may be framed only
 * by this origin (the PDF preview). A header the agent already set (a file
 * read's own sandboxing CSP, a thumbnail's cache lifetime) is left alone.
 */
export function webHeaders(): MiddlewareHandler {
  return async (c, next) => {
    await next();
    const res = c.res;
    const h = new Headers(res.headers);
    const setNew = (k: string, v: string) => {
      if (!h.has(k)) h.set(k, v);
    };
    setNew("x-content-type-options", "nosniff");
    setNew("referrer-policy", "no-referrer");
    if (c.req.path.startsWith("/api/")) {
      setNew("cache-control", "no-store");
      setNew("x-frame-options", "SAMEORIGIN");
    }
    c.res = new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
  };
}

const NOT_FOR_GZIP = /ndjson|event-stream/i;

/**
 * gzip for text responses: the shell, scripts, styles and JSON (also the agents' JSON passed through the proxy).
 * Never for streamed lists or events, for anything that can be range-read, or for file reads
 * (an agent's file reply carries Accept-Ranges and keeps its exact length).
 */
export function textCompression(): MiddlewareHandler {
  const gz = compress({
    encoding: "gzip",
    contentTypeFilter: (type) => /^(?:text\/(?:html|css|javascript|plain|xml)|application\/(?:json|javascript|xml)|image\/svg\+xml)(?:;|\s|$)/i.test(type) && !NOT_FOR_GZIP.test(type),
  });
  return async (c, next) => {
    await next();
    const r = c.res;
    if (c.req.method === "HEAD" || r.status !== 200 || r.headers.has("accept-ranges") || r.headers.has("content-range") || r.headers.has("content-disposition")) return;
    if (c.req.path.startsWith("/api/") && !(r.headers.get("content-type") ?? "").startsWith("application/json")) return;
    await gz(c, async () => undefined);
  };
}
