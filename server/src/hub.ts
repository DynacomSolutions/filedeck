import { Hono } from "hono";
import { serveStatic } from "@hono/node-server/serve-static";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { registerHubDiff } from "./diff-hub.ts";
import { registerOps } from "./ops-routes.ts";
import type { Config } from "./config.ts";
import { makeThumbnailer } from "./thumbs.ts";
import { createSourceApp } from "./sources/source-app.ts";
import { buildSources } from "./sources/registry.ts";
import type { SourceBackend } from "./sources/types.ts";
import { audit, type AuditSink } from "./audit.ts";

/** Where a request for a node or a network source goes. Agents are HTTP; sources run inside the hub. */
export interface Target {
  fetch(rest: string, init?: RequestInit): Promise<Response>;
}

const HOP = new Set(["connection", "keep-alive", "transfer-encoding", "te", "trailer", "upgrade", "proxy-authorization", "proxy-authenticate", "host", "content-length"]);

function clean(h: Headers, keepLength: boolean): Headers {
  const out = new Headers();
  h.forEach((v, k) => {
    if (HOP.has(k.toLowerCase()) && !(keepLength && k.toLowerCase() === "content-length")) return;
    out.set(k, v);
  });
  return out;
}

export function createHub(cfg: Config, injected?: Record<string, SourceBackend>, auditSink?: AuditSink) {
  const app = new Hono() as Hono & { close(): Promise<void> };
  app.use("*", audit("hub", auditSink));
  app.close = async () => void (await Promise.all([...sources.values()].map((s) => s.backend.close().catch(() => undefined))));
  const agents = new Map<string, Target>(cfg.nodes.map((n) => [n.name, { fetch: (rest, init) => fetch(n.url + rest, init) }]));
  const sources = buildSources(cfg);
  for (const [name, backend] of Object.entries(injected ?? {})) {
    sources.set(name, { config: { name, type: backend.type, host: "test", root: "/" }, backend });
  }
  const sourceOpts = { maxUpload: cfg.maxUpload, maxEdit: cfg.maxEdit, hashConcurrency: cfg.hashConcurrency, walkMaxEntries: cfg.walkMaxEntries, searchConcurrency: cfg.searchConcurrency, searchMaxFileBytes: cfg.searchMaxFileBytes, searchMaxBytes: cfg.searchMaxBytes, thumbs: makeThumbnailer(cfg) };
  for (const [name, s] of sources) {
    if (agents.has(name)) throw new Error(`source ${name} collides with a node of the same name`);
    const sapp = createSourceApp(name, s.backend, sourceOpts);
    agents.set(name, { fetch: (rest, init) => Promise.resolve(sapp.fetch(new Request("http://source" + rest, init))) });
  }
  // Reachability of a source is cached briefly so the sidebar poll does not open a connection per request.
  const pingCache = new Map<string, { at: number; ok: boolean }>();
  const sourceOnline = async (name: string) => {
    const hit = pingCache.get(name);
    if (hit && Date.now() - hit.at < 10_000) return hit.ok;
    let ok = false;
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        (sources.get(name) as { backend: SourceBackend }).backend.ping(),
        new Promise((_, rej) => {
          timer = setTimeout(() => rej(new Error("timeout")), 4000);
        }),
      ]);
      ok = true;
    } catch {
      ok = false;
    } finally {
      clearTimeout(timer);
    }
    pingCache.set(name, { at: Date.now(), ok });
    return ok;
  };

  app.get("/healthz", (c) => c.text("ok"));

  app.get("/api/nodes", async (c) => {
    const nodes = await Promise.all(
      cfg.nodes.map(async (n) => {
        try {
          const r = await fetch(`${n.url}/healthz`, { signal: AbortSignal.timeout(2000) });
          return { name: n.name, online: r.ok };
        } catch {
          return { name: n.name, online: false };
        }
      }),
    );
    const srcs = await Promise.all(
      [...sources.values()].map(async ({ config }) => ({ name: config.name, type: config.type, host: config.host, online: await sourceOnline(config.name) })),
    );
    return c.json({ nodes, sources: srcs });
  });

  // Folder diff jobs run here: the hub reads both agents' listings and asks each agent to hash its own files.
  registerHubDiff(app, agents);
  // Bulk copy/move/trash/delete/sync run as hub jobs (survive the browser closing, pausable, conflict policy).
  registerOps(app, agents, (n) => sources.has(n));

  // Cross-node / cross-source transfer: the hub streams src -> dst. Files and folders; both ends are
  // agents or network sources. Moving removes the source afterwards (node trash, permanent on sources).
  class TransferError extends Error {
    constructor(
      public status: number,
      message: string,
    ) {
      super(message);
    }
  }
  const q = encodeURIComponent;
  const failed = async (r: Response, what: string): Promise<TransferError> => {
    let msg = r.statusText;
    try {
      msg = ((await r.json()) as { error?: string }).error ?? msg;
    } catch {
      /* not json */
    }
    return new TransferError(r.status >= 400 && r.status < 600 ? r.status : 502, `${what}: ${msg}`);
  };
  interface StatLite {
    type: string;
    mtime?: number;
  }
  const statOf = async (t: Target, p: string): Promise<StatLite | null> => {
    const r = await t.fetch(`/api/fs/stat?path=${q(p)}`);
    if (r.status === 404) return null;
    if (!r.ok) throw await failed(r, "stat");
    return (await r.json()) as StatLite;
  };
  const joinP = (dir: string, name: string) => (dir === "/" ? "" : dir) + "/" + name;
  interface TOpts {
    overwrite: boolean;
    preserveTimes: boolean;
  }
  async function transferFile(src: Target, sp: string, st: StatLite, dst: Target, dir: string, name: string, o: TOpts) {
    const down = await src.fetch(`/api/fs/download?path=${q(sp)}`);
    if (!down.ok) throw await failed(down, "source read");
    const headers: Record<string, string> = {};
    const len = down.headers.get("content-length");
    if (len !== null) headers["content-length"] = len;
    const up = await dst.fetch(
      `/api/fs/upload?dir=${q(dir)}&name=${q(name)}` + (o.overwrite ? "&overwrite=1" : "") + (o.preserveTimes && st.mtime ? `&mtime=${Math.floor(st.mtime)}` : ""),
      { method: "PUT", body: down.body ?? "", duplex: "half", headers } as RequestInit,
    );
    if (!up.ok) {
      await down.body?.cancel().catch(() => undefined);
      throw await failed(up, "destination write");
    }
    return (await up.json()) as { path: string };
  }
  async function transferTree(src: Target, sp: string, dst: Target, dir: string, o: TOpts, depth = 0): Promise<{ path: string }> {
    const st = await statOf(src, sp);
    if (!st) throw new TransferError(404, "source not found");
    const name = path.posix.basename(sp);
    if (st.type === "file") return transferFile(src, sp, st, dst, dir, name, o);
    if (st.type !== "dir") throw new TransferError(400, "only files and folders can be transferred");
    if (depth > 64) throw new TransferError(400, "folder nesting too deep");
    const dp = joinP(dir, name);
    const cur = await statOf(dst, dp);
    if (cur && (cur.type !== "dir" || !o.overwrite)) throw new TransferError(409, "destination exists");
    if (!cur) {
      const mk = await dst.fetch("/api/fs/mkdir", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: dp }) });
      if (!mk.ok) throw await failed(mk, "destination mkdir");
    }
    const ls = await src.fetch(`/api/fs/list?path=${q(sp)}&hidden=1`);
    if (!ls.ok) throw await failed(ls, "source list");
    const { entries } = (await ls.json()) as { entries: { path: string; type: string }[] };
    for (const e of entries) {
      if (e.type === "symlink" || e.type === "other") continue; // links and special files are not transferred
      await transferTree(src, e.path, dst, dp, o, depth + 1);
    }
    return { path: dp };
  }

  app.post("/api/transfer", async (c) => {
    const b = (await c.req.json().catch(() => null)) as {
      src?: { node: string; path: string };
      dst?: { node: string; dir: string };
      op?: "copy" | "move";
      /** replace an existing file of the same name at the destination (folders are merged) */
      overwrite?: boolean;
      /** give the destination file the source's modification time */
      preserveTimes?: boolean;
    } | null;
    const src = b?.src && agents.get(b.src.node);
    const dst = b?.dst && agents.get(b.dst.node);
    if (!b?.src || !b.dst || !src || !dst) return c.json({ error: "unknown node" }, 404);
    if (typeof b.src.path !== "string" || typeof b.dst.dir !== "string" || !b.src.path.startsWith("/") || b.src.path === "/") {
      return c.json({ error: "invalid path" }, 400);
    }
    try {
      const res = await transferTree(src, b.src.path, dst, b.dst.dir, { overwrite: b.overwrite === true, preserveTimes: b.preserveTimes === true });
      if (b.op === "move") {
        const isSource = sources.has(b.src.node);
        const rm = await src.fetch(isSource ? "/api/fs/delete" : "/api/fs/trash", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ paths: [b.src.path] }),
        });
        if (!rm.ok) throw await failed(rm, "copied, but removing the source failed");
      }
      return c.json(res, 201);
    } catch (e) {
      if (e instanceof TransferError) return c.json({ error: e.message }, e.status as 400);
      if ((e as Error)?.name === "AbortError") return new Response(null, { status: 499 });
      return c.json({ error: "transfer failed" }, 502);
    }
  });

  // Reverse proxy: /api/nodes/<node>/<rest> -> <agent>/<rest>
  app.all("/api/nodes/:node/*", async (c) => {
    const target = agents.get(c.req.param("node"));
    if (!target) return c.json({ error: "unknown node" }, 404);
    const url = new URL(c.req.url);
    const rest = url.pathname.slice(`/api/nodes/${c.req.param("node")}`.length);
    const hasBody = !["GET", "HEAD"].includes(c.req.method);
    const init: RequestInit & { duplex?: string } = {
      method: c.req.method,
      headers: clean(c.req.raw.headers, false),
      signal: c.req.raw.signal,
      redirect: "manual",
    };
    if (hasBody) {
      init.body = c.req.raw.body;
      init.duplex = "half";
      const len = c.req.header("content-length");
      if (len) (init.headers as Headers).set("content-length", len);
    }
    try {
      const r = await target.fetch(rest + url.search, init);
      return new Response(r.body, { status: r.status, headers: clean(r.headers, true) });
    } catch (e) {
      if ((e as Error).name === "AbortError") return new Response(null, { status: 499 });
      return c.json({ error: "agent unreachable" }, 502);
    }
  });

  // SPA
  const index = path.join(cfg.staticDir, "index.html");
  app.use("/*", serveStatic({ root: path.relative(process.cwd(), cfg.staticDir) || "." }));
  app.get("*", async (c) => {
    try {
      return c.html(await readFile(index, "utf8"));
    } catch {
      return c.text("web UI not built", 503);
    }
  });
  return app;
}
