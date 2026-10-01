import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { Readable } from "node:stream";
import path from "node:path";
import * as ops from "./fsops.ts";
import { listMounts } from "./mounts.ts";
import { resolveRead } from "./paths.ts";
import { Watches } from "./watch.ts";
import type { Config } from "./config.ts";

const SAFE_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Content-Security-Policy": "sandbox; default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'",
};

function dispo(name: string) {
  const ascii = name.replace(/[^\x20-\x7e]|["\\]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

export function createAgent(cfg: Config) {
  const app = new Hono();
  const watches = new Watches();
  const root = cfg.root;

  app.onError((e, c) => {
    const { status, message } = ops.mapError(e);
    if (status === 500) console.error("agent error", e);
    return c.json({ error: message }, status as 400);
  });

  app.get("/healthz", (c) => c.text("ok"));
  app.get("/api/info", (c) => c.json({ node: cfg.node, root: cfg.root, watches: watches.size }));
  app.get("/api/mounts", async (c) => c.json({ mounts: await listMounts(root, cfg.procMounts) }));

  app.get("/api/fs/list", async (c) =>
    c.json(await ops.list(root, c.req.query("path") ?? "/", c.req.query("hidden") === "1")),
  );
  app.get("/api/fs/stat", async (c) => c.json(await ops.stat(root, c.req.query("path") ?? "/")));

  const serve = async (c: import("hono").Context, download: boolean) => {
    const f = await ops.openFile(root, c.req.query("path") ?? "");
    const name = path.basename(f.r.real);
    const range = ops.parseRange(c.req.header("range"), f.size);
    const headers: Record<string, string> = {
      ...SAFE_HEADERS,
      "Content-Type": f.mime,
      "Accept-Ranges": "bytes",
      "Last-Modified": new Date(f.mtime).toUTCString(),
      "Content-Disposition": download ? dispo(name) : "inline",
    };
    if (range === "invalid") {
      return new Response(null, { status: 416, headers: { ...headers, "Content-Range": `bytes */${f.size}` } });
    }
    if (c.req.method === "HEAD") {
      return new Response(null, { status: 200, headers: { ...headers, "Content-Length": String(f.size) } });
    }
    if (range) {
      const body = Readable.toWeb(ops.streamFile(f.r.real, range)) as ReadableStream;
      return new Response(body, {
        status: 206,
        headers: {
          ...headers,
          "Content-Length": String(range.end - range.start + 1),
          "Content-Range": `bytes ${range.start}-${range.end}/${f.size}`,
        },
      });
    }
    const body = Readable.toWeb(ops.streamFile(f.r.real)) as ReadableStream;
    return new Response(body, { status: 200, headers: { ...headers, "Content-Length": String(f.size) } });
  };
  app.on(["GET", "HEAD"], "/api/fs/read", (c) => serve(c, false));
  app.on(["GET", "HEAD"], "/api/fs/download", (c) => serve(c, true));

  app.get("/api/fs/text", async (c) => c.json(await ops.readText(root, c.req.query("path") ?? "", cfg.maxEdit)));

  // Editor save: atomic overwrite guarded by If-Match (etag from /api/fs/text or a previous save).
  // `create=1` (no If-Match) makes a new file and fails with 409 if it exists.
  app.put("/api/fs/write", async (c) => {
    const ifMatch = c.req.header("if-match");
    const create = c.req.query("create") === "1";
    if (!create && !ifMatch) throw new ops.FsError(428, "If-Match header required");
    const buf = Buffer.from(await c.req.arrayBuffer());
    try {
      return c.json(await ops.writeText(root, c.req.query("path") ?? "", buf, create ? null : (ifMatch as string), cfg.maxEdit));
    } catch (e) {
      if (e instanceof ops.FsError && e.extra) return c.json({ error: e.message, ...e.extra }, e.status as 409);
      throw e;
    }
  });

  app.put("/api/fs/upload", async (c) => {
    const body = c.req.raw.body;
    if (!body) return c.json({ error: "empty body" }, 400);
    const name = c.req.query("name") ?? "";
    const r = await ops.upload(
      root,
      c.req.query("dir") ?? "/",
      name,
      Readable.fromWeb(body as never),
      c.req.query("overwrite") === "1",
      cfg.maxUpload,
    );
    return c.json(r, 201);
  });

  const json = async <T,>(c: import("hono").Context): Promise<T> => {
    try {
      return (await c.req.json()) as T;
    } catch {
      throw new ops.FsError(400, "invalid JSON body");
    }
  };
  const strs = (v: unknown): string[] => {
    if (!Array.isArray(v) || v.length === 0 || v.length > 10000 || v.some((x) => typeof x !== "string")) {
      throw new ops.FsError(400, "paths must be a non-empty array of strings");
    }
    return v as string[];
  };
  const str = (v: unknown, what: string): string => {
    if (typeof v !== "string") throw new ops.FsError(400, `${what} must be a string`);
    return v;
  };

  app.post("/api/fs/mkdir", async (c) => {
    const b = await json<{ path: string }>(c);
    return c.json({ path: await ops.mkdir(root, str(b.path, "path")) }, 201);
  });
  app.post("/api/fs/rename", async (c) => {
    const b = await json<{ from: string; to: string; overwrite?: boolean }>(c);
    return c.json({ path: await ops.rename(root, str(b.from, "from"), str(b.to, "to"), b.overwrite === true) });
  });
  app.post("/api/fs/move", async (c) => {
    const b = await json<{ from: string[]; toDir: string }>(c);
    const results = [];
    for (const f of strs(b.from)) results.push(await ops.move(root, f, str(b.toDir, "toDir")));
    return c.json({ paths: results });
  });
  app.post("/api/fs/copy", async (c) => {
    const b = await json<{ from: string[]; toDir: string }>(c);
    const results = [];
    for (const f of strs(b.from)) results.push(await ops.copy(root, f, str(b.toDir, "toDir")));
    return c.json({ paths: results });
  });
  app.post("/api/fs/trash", async (c) => {
    const b = await json<{ paths: string[] }>(c);
    const items = [];
    for (const p of strs(b.paths)) items.push(await ops.trash(root, p));
    return c.json({ items });
  });
  app.post("/api/fs/delete", async (c) => {
    const b = await json<{ paths: string[] }>(c);
    for (const p of strs(b.paths)) await ops.permanentDelete(root, p);
    return c.json({ ok: true });
  });

  // Live change feed: one event per change in the watched directory.
  app.get("/api/events", (c) => {
    const dir = resolveRead(root, c.req.query("path") ?? "/");
    return streamSSE(c, async (stream) => {
      let dirty = false;
      const unsub = watches.subscribe(dir.real, () => {
        dirty = true;
      });
      if (!unsub) {
        await stream.writeSSE({ event: "error", data: "watch limit reached" });
        return;
      }
      let open = true;
      stream.onAbort(() => {
        open = false;
        unsub();
      });
      await stream.writeSSE({ event: "ready", data: dir.virtual });
      let idle = 0;
      while (open) {
        await stream.sleep(250);
        if (dirty) {
          dirty = false;
          idle = 0;
          await stream.writeSSE({ event: "change", data: dir.virtual });
        } else if (++idle >= 100) {
          idle = 0;
          await stream.writeSSE({ event: "ping", data: "" });
        }
      }
      unsub();
    });
  });

  return app;
}
