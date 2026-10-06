import type { Hono } from "hono";
import path from "node:path";
import { FsError } from "./fsops.ts";
import { passwordFromHeader } from "./sevenzip.ts";
import { Vault, type Scope } from "./vault.ts";
import type { Target } from "./hub.ts";

/**
 * Hub side of the vault: lists/forgets entries, and wraps the proxied requests
 * that may need a password (encrypted archives, PDFs):
 *
 *  - a password typed by the user arrives in `x-filedeck-password`; if the agent
 *    reports it was actually needed and correct (`x-filedeck-pw: ok`) it is
 *    saved, as the user asked (`x-filedeck-save`: ttl | forever | no,
 *    `x-filedeck-scope`: file | folder);
 *  - otherwise a saved password for the file (or its folder) is added to the
 *    forwarded request, never to the response;
 *  - a saved password the agent rejects is forgotten.
 */

/** Requests (agent-relative) that take a password, and where their file path is. */
const ROUTES: { method: string; rest: string; from: "query" | "body" }[] = [
  { method: "GET", rest: "/api/archive/list", from: "query" },
  { method: "POST", rest: "/api/jobs/extract", from: "body" },
  { method: "GET", rest: "/api/pdf/status", from: "query" },
  { method: "GET", rest: "/api/pdf/decrypted", from: "query" },
];

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");
const MAX_BODY = 1024 * 1024;
const jsonErr = (status: number, error: string) => new Response(JSON.stringify({ error }), { status, headers: { "content-type": "application/json" } });

export const isPasswordRoute = (method: string, rest: string) => ROUTES.some((r) => r.method === method && r.rest === rest);

export function registerVaultRoutes(app: Hono, vault: Vault, nodeExists: (n: string) => boolean) {
  app.get("/api/vault", (c) =>
    c.json({ entries: vault.list(), persistent: vault.persistent, ttlSeconds: Math.round(vault.ttlMs / 1000), maxHours: Math.round(vault.maxMs / 3600_000) }),
  );
  app.post("/api/vault/forget", async (c) => {
    const b = (await c.req.json().catch(() => null)) as { node?: unknown; path?: unknown } | null;
    if (!b || typeof b.node !== "string" || typeof b.path !== "string" || !b.path.startsWith("/") || !nodeExists(b.node)) return c.json({ error: "node and absolute path required" }, 400);
    return c.json({ removed: vault.forgetPath(b.node, b.path) });
  });
  app.post("/api/vault/:id/extend", (c) => {
    const entry = vault.extend(c.req.param("id"));
    return entry ? c.json(entry) : c.json({ error: "saved password has expired" }, 404);
  });
  app.delete("/api/vault/:id", (c) => (vault.forget(c.req.param("id")) ? c.json({ ok: true }) : c.json({ error: "not found" }, 404)));
  app.delete("/api/vault", (c) => c.json({ removed: vault.forgetAll() }));
}

export async function proxyWithVault(o: {
  vault: Vault;
  node: string;
  target: Target;
  method: string;
  rest: string;
  search: string;
  headers: Headers;
  body: ReadableStream<Uint8Array> | null;
  signal?: AbortSignal;
}): Promise<Response> {
  const route = ROUTES.find((r) => r.method === o.method && r.rest === o.rest)!;
  const headers = new Headers(o.headers);
  const save = headers.get("x-filedeck-save") ?? "ttl";
  const scope: Scope = headers.get("x-filedeck-scope") === "folder" ? "folder" : "file";
  headers.delete("x-filedeck-save");
  headers.delete("x-filedeck-scope");

  let bodyText: string | undefined;
  let file: string | undefined;
  if (route.from === "query") file = new URLSearchParams(o.search).get("path") ?? undefined;
  else {
    const chunks: Buffer[] = [];
    let n = 0;
    if (o.body) {
      for await (const ch of o.body as unknown as AsyncIterable<Uint8Array>) {
        n += ch.length;
        if (n > MAX_BODY) return jsonErr(413, "request too large");
        chunks.push(Buffer.from(ch));
      }
    }
    bodyText = Buffer.concat(chunks).toString("utf8");
    try {
      const j = JSON.parse(bodyText) as { path?: unknown };
      if (typeof j.path === "string") file = j.path;
    } catch {
      /* the agent reports the bad body */
    }
  }

  let typed: string | undefined;
  try {
    typed = passwordFromHeader(headers.get("x-filedeck-password") ?? undefined);
  } catch (e) {
    if (e instanceof FsError) return jsonErr(e.status, e.message);
    throw e;
  }
  headers.delete("x-filedeck-password");
  const q = encodeURIComponent;
  const fidOf = async (): Promise<string | undefined> => {
    if (!file) return undefined;
    try {
      const r = await o.target.fetch(`/api/fs/fid?path=${q(file)}`);
      return r.ok ? ((await r.json()) as { fid?: string }).fid : undefined;
    } catch {
      return undefined;
    }
  };

  let hit: { password: string; id: string; scope: Scope } | undefined;
  if (typed) headers.set("x-filedeck-password", b64(typed));
  else if (file && file.startsWith("/")) {
    hit = o.vault.get(o.node, file, undefined, false);
    if (!hit && o.vault.hasNode(o.node)) hit = o.vault.get(o.node, file, await fidOf(), false);
    if (hit) headers.set("x-filedeck-password", b64(hit.password));
  }

  const send = (h: Headers) => {
    const init: RequestInit & { duplex?: string } = { method: o.method, headers: h, signal: o.signal, redirect: "manual" };
    if (bodyText !== undefined) {
      init.body = bodyText;
      h.delete("content-length"); // re-serialised by fetch
    } else if (o.method !== "GET" && o.method !== "HEAD") {
      init.body = o.body;
      init.duplex = "half";
    }
    return o.target.fetch(o.rest + o.search, init);
  };
  let r = await send(new Headers(headers));
  if (hit && !typed && r.status === 401) {
    // The saved password does not open this file. A file's own entry is stale (changed or re-encrypted), so it is
    // forgotten; a folder entry is only a guess for this file and keeps serving the others in the folder. Either way
    // the request is repeated without it, so whatever needs no password (an archive's file names) still works.
    if (hit.scope === "file") o.vault.forget(hit.id);
    await r.body?.cancel().catch(() => undefined);
    const bare = new Headers(headers);
    bare.delete("x-filedeck-password");
    hit = undefined;
    r = await send(bare);
  }
  const used = r.headers.get("x-filedeck-pw") === "ok";
  const out = new Headers(r.headers);
  out.delete("x-filedeck-pw");
  out.delete("content-length");
  if (used && hit) {
    o.vault.touch(hit.id);
    out.set("x-filedeck-pw-source", "saved");
  }
  if (used && typed && save !== "no" && file && file.startsWith("/")) {
    const where = scope === "folder" ? path.posix.dirname(file) : file;
    o.vault.put(o.node, where, typed, { remember: save === "forever", scope, fid: scope === "file" ? await fidOf() : undefined });
  }
  return new Response(r.body, { status: r.status, headers: out });
}
