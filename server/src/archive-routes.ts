import type { Hono, Context } from "hono";
import { Readable } from "node:stream";
import path from "node:path";
import * as ops from "./fsops.ts";
import * as ar from "./archive.ts";
import { Jobs } from "./jobs.ts";
import type { Config } from "./config.ts";
import { passwordFromHeader } from "./sevenzip.ts";

const bad = (m: string) => new ops.FsError(400, m);

async function body<T>(c: Context): Promise<T> {
  try {
    return (await c.req.json()) as T;
  } catch {
    throw bad("invalid JSON body");
  }
}
const str = (v: unknown, what: string) => {
  if (typeof v !== "string" || !v) throw bad(`${what} must be a non-empty string`);
  return v;
};
const strs = (v: unknown, what: string) => {
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string" || !x)) throw bad(`${what} must be an array of strings`);
  return v as string[];
};

function dispo(name: string) {
  const ascii = name.replace(/[^\x20-\x7e]|["\\]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

export function registerArchiveRoutes(app: Hono, cfg: Config): Jobs {
  const root = cfg.root;
  const limits: ar.ArchiveLimits = { maxEntries: cfg.archiveMaxEntries, maxBytes: cfg.archiveMaxBytes };
  const jobs = new Jobs(cfg.jobConcurrency, 100, (e) => ops.mapError(e).message);

  // The password (if any) arrives base64-encoded in `x-filedeck-password`, never in a URL or a body, so it is not audit-logged.
  const pw = (c: Context) => passwordFromHeader(c.req.header("x-filedeck-password"));

  app.get("/api/archive/list", async (c) => {
    const lim = Number(c.req.query("limit"));
    return c.json(await ar.listArchive(root, c.req.query("path") ?? "", Number.isInteger(lim) && lim > 0 && lim <= 5000 ? lim : 5000, pw(c)));
  });

  // Multi-select / folder download: a zip streamed straight to the client.
  app.on(["GET", "HEAD"], "/api/fs/zip", async (c) => {
    const dir = c.req.query("dir") ?? "/";
    const names = c.req.queries("name") ?? [];
    const sel = await ar.prepareSelection(root, dir, names);
    const base = sel.names.length === 1 ? sel.names[0]! : path.posix.basename(sel.d.virtual) || "files";
    const headers = {
      "Content-Type": "application/zip",
      "Content-Disposition": dispo(base + ".zip"),
      "X-Content-Type-Options": "nosniff",
    };
    if (c.req.method === "HEAD") return new Response(null, { headers });
    const stream = ar.zipStream(sel.d.real, sel.names, c.req.raw.signal);
    return new Response(Readable.toWeb(stream) as ReadableStream, { headers });
  });

  app.get("/api/jobs", (c) => c.json({ jobs: jobs.list() }));
  app.get("/api/jobs/:id", (c) => {
    const j = jobs.get(c.req.param("id"));
    return j ? c.json(j) : c.json({ error: "not found" }, 404);
  });
  app.post("/api/jobs/:id/cancel", (c) => {
    const j = jobs.cancel(c.req.param("id"));
    return j ? c.json(j) : c.json({ error: "not found" }, 404);
  });
  app.delete("/api/jobs/:id", (c) => (jobs.dismiss(c.req.param("id")) ? c.json({ ok: true }) : c.json({ error: "not found or still active" }, 404)));

  app.post("/api/jobs/compress", async (c) => {
    const b = await body<{ dir?: string; names?: string[]; format?: string; name?: string; level?: number; encryptHeaders?: boolean; splitBytes?: number; exclude?: string[]; destDir?: string }>(c);
    const plan = await ar.prepareCompress(root, str(b.dir, "dir"), strs(b.names, "names"), str(b.format, "format"), b.name, {
      level: b.level,
      encryptHeaders: b.encryptHeaders === true,
      splitBytes: b.splitBytes,
      exclude: b.exclude === undefined ? [] : strs(b.exclude, "exclude"),
      destDir: b.destDir === undefined ? undefined : str(b.destDir, "destDir"),
      password: pw(c),
    });
    const job = jobs.create("compress", `Compress ${plan.names.length} item(s) to ${plan.outName}`, (ctl) => ar.runCompress(plan, limits, ctl));
    return c.json(job, 202);
  });

  app.post("/api/jobs/extract", async (c) => {
    const b = await body<{ path?: string; destDir?: string; subfolder?: boolean; overwrite?: string; entries?: string[] }>(c);
    const plan = await ar.prepareExtract(root, str(b.path, "path"), str(b.destDir, "destDir"), b.subfolder !== false, {
      overwrite: b.overwrite as ar.OverwritePolicy | undefined,
      entries: b.entries === undefined ? [] : strs(b.entries, "entries"),
      password: pw(c),
    });
    const job = jobs.create("extract", `Extract ${plan.entries.length ? `${plan.entries.length} item(s) from ` : ""}${plan.archiveName}`, (ctl) => ar.runExtract(plan, limits, ctl));
    return c.json(job, 202);
  });

  return jobs;
}
