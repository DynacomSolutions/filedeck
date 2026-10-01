import { Hono } from "hono";
import { serveStatic } from "@hono/node-server/serve-static";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { registerHubDiff } from "./diff-hub.ts";
import type { Config } from "./config.ts";

const HOP = new Set(["connection", "keep-alive", "transfer-encoding", "te", "trailer", "upgrade", "proxy-authorization", "proxy-authenticate", "host", "content-length"]);

function clean(h: Headers, keepLength: boolean): Headers {
  const out = new Headers();
  h.forEach((v, k) => {
    if (HOP.has(k.toLowerCase()) && !(keepLength && k.toLowerCase() === "content-length")) return;
    out.set(k, v);
  });
  return out;
}

export function createHub(cfg: Config) {
  const app = new Hono();
  const agents = new Map(cfg.nodes.map((n) => [n.name, n.url]));

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
    return c.json({ nodes });
  });

  // Folder diff jobs run here: the hub reads both agents' listings and asks each agent to hash its own files.
  registerHubDiff(app, agents);

  // Cross-node transfer (files only for now): stream src agent -> dst agent.
  app.post("/api/transfer", async (c) => {
    const b = (await c.req.json().catch(() => null)) as {
      src?: { node: string; path: string };
      dst?: { node: string; dir: string };
      op?: "copy" | "move";
      /** replace an existing file of the same name at the destination */
      overwrite?: boolean;
      /** give the destination file the source's modification time */
      preserveTimes?: boolean;
    } | null;
    const src = b?.src && agents.get(b.src.node);
    const dst = b?.dst && agents.get(b.dst.node);
    if (!b?.src || !b.dst || !src || !dst) return c.json({ error: "unknown node" }, 404);
    const name = path.posix.basename(b.src.path);
    const stat = await fetch(`${src}/api/fs/stat?path=${encodeURIComponent(b.src.path)}`);
    if (!stat.ok) return new Response(stat.body, { status: stat.status, headers: { "content-type": "application/json" } });
    const st = (await stat.json()) as { type: string; mtime?: number };
    if (st.type !== "file") return c.json({ error: "cross-node folder transfer is not supported yet" }, 501);
    const down = await fetch(`${src}/api/fs/download?path=${encodeURIComponent(b.src.path)}`);
    if (!down.ok || !down.body) return c.json({ error: "source read failed" }, 502);
    const up = await fetch(
      `${dst}/api/fs/upload?dir=${encodeURIComponent(b.dst.dir)}&name=${encodeURIComponent(name)}` +
        (b.overwrite === true ? "&overwrite=1" : "") +
        (b.preserveTimes === true && st.mtime ? `&mtime=${Math.floor(st.mtime)}` : ""),
      { method: "PUT", body: down.body, duplex: "half", headers: { "content-length": down.headers.get("content-length") ?? "" } } as RequestInit,
    );
    if (!up.ok) return new Response(up.body, { status: up.status, headers: { "content-type": "application/json" } });
    if (b.op === "move") {
      await fetch(`${src}/api/fs/trash`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ paths: [b.src.path] }),
      });
    }
    return c.json(await up.json(), 201);
  });

  // Reverse proxy: /api/nodes/<node>/<rest> -> <agent>/<rest>
  app.all("/api/nodes/:node/*", async (c) => {
    const base = agents.get(c.req.param("node"));
    if (!base) return c.json({ error: "unknown node" }, 404);
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
      const r = await fetch(base + rest + url.search, init);
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
