import type { Hono, Context } from "hono";
import { Readable } from "node:stream";
import path from "node:path";
import fs from "node:fs/promises";
import { resolveRead } from "./paths.ts";
import * as ops from "./fsops.ts";
import * as ar from "./archive.ts";
import { Jobs } from "./jobs.ts";
import { JobStore } from "./job-store.ts";
import type { Config } from "./config.ts";
import { extractBlocked, hitsReadOnly, jobMayWrite } from "./readonly.ts";
import { passwordFromHeader } from "./sevenzip.ts";
import { withReadOnly } from "./pinwalk.ts";
import { ZipTickets } from "./zip-tickets.ts";
import { downloadGate, listGate } from "./tool-gate.ts";
import { clientKey } from "./search.ts";

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
/** most names a selection may hold (the same bound as the job queue's items) */
const MAX_NAMES = ar.MAX_SELECTED; // one limit for the zip route, the ticket route, compression and the web client
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
  void ar.sweepWorkArea(root, cfg.procMounts); // leftovers of a crashed run are removed from the private work folder, nowhere else
  const limits: ar.ArchiveLimits = { maxEntries: cfg.archiveMaxEntries, maxBytes: cfg.archiveMaxBytes };
  const shared = cfg.jobsFile ? { store: new JobStore(cfg.jobsFile), scope: cfg.node, leaseMs: 10_000 } : undefined;
  const jobs = new Jobs(cfg.jobConcurrency, 100, (e) => ops.mapError(e).message, undefined, shared);

  // Queued jobs are checked again when they start, on where the destination really is by then (a folder may have been swapped for a link meanwhile).
  const mayWrite = (real: string, contains: boolean) => {
    if (!jobMayWrite(root, cfg.readOnly, real, { contains })) throw new ops.FsError(403, "read-only volume");
  };
  const runCompress = async (plan: ar.CompressPlan, ctl: Parameters<typeof ar.runCompress>[2]) => {
    mayWrite(path.dirname(plan.outReal), false);
    return withReadOnly(root, cfg.readOnly, () => ar.runCompress(plan, limits, ctl, mayWrite));
  };
  const runExtract = async (plan: ar.ExtractPlan, ctl: Parameters<typeof ar.runExtract>[2]) => {
    const merge = plan.overwrite !== "rename";
    mayWrite(plan.destReal, merge && !plan.subfolder);
    if (merge && plan.subfolder) mayWrite(path.join(plan.destReal, ar.archiveBase(plan.archiveName)), true);
    return withReadOnly(root, cfg.readOnly, () => ar.runExtract(plan, limits, ctl, mayWrite)); // a queued job runs outside the request that made it: the scope is opened here
  };

  jobs.register("compress", async (p) => {
    const b = p as { dir: string; names: string[]; format: string; name?: string; level?: number; encryptHeaders?: boolean; splitBytes?: number; exclude?: string[]; destDir?: string };
    try {
      if ([b.dir, b.destDir].some((t) => t !== undefined && hitsReadOnly(root, cfg.readOnly, t))) throw new ops.FsError(403, "read-only volume");
      const plan = await ar.prepareCompress(root, b.dir, b.names, b.format, b.name, { level: b.level, encryptHeaders: b.encryptHeaders === true, splitBytes: b.splitBytes, exclude: b.exclude ?? [], destDir: b.destDir });
      return { run: (ctl) => runCompress(plan, ctl) };
    } catch (e) {
      return { run: async () => Promise.reject(e) }; // a refusal fails the job with its message
    }
  });

  // The password (if any) arrives base64-encoded in `x-filedeck-password`, never in a URL or a body, so it is not audit-logged.
  const pw = (c: Context) => passwordFromHeader(c.req.header("x-filedeck-password"));

  app.get("/api/archive/list", async (c) => {
    const lim = Number(c.req.query("limit"));
    const slot = await listGate.acquire(c.req.raw.signal, clientKey(c, cfg.agentToken)); // a listing is never held up by downloads: its own pool
    let res: Awaited<ReturnType<typeof ar.listArchive>>;
    try {
      res = await ar.listArchive(root, c.req.query("path") ?? "", Number.isInteger(lim) && lim > 0 && lim <= 5000 ? lim : 5000, pw(c));
    } finally {
      slot.release();
    }
    const { passwordUsed, ...rest } = res;
    // tells the hub the password was needed and right (so it may save it); stripped before the client sees it
    return c.json(rest, 200, passwordUsed ? { "x-filedeck-pw": "ok" } : {});
  });

  // Device, inode and size identity of a file (the device keeps two volumes' equal inode numbers apart), so the hub's vault can find a saved password after a rename or move.
  app.get("/api/fs/fid", async (c) => {
    const r = resolveRead(root, c.req.query("path") ?? "");
    const st = await fs.stat(r.real);
    if (!st.isFile()) throw bad("not a regular file");
    return c.json({ fid: `${st.dev}:${st.ino}:${st.size}` });
  });

  // Multi-select / folder download: a zip streamed straight to the client. Short selections name the
  // items in the query; a long list is posted for a one-use ticket (about a minute) that the GET then redeems.
  const tickets = new ZipTickets();
  app.on(["GET", "HEAD"], "/api/fs/zip", async (c) => {
    const id = c.req.query("ticket");
    let dir = c.req.query("dir") ?? "/";
    let names = c.req.queries("name") ?? [];
    if (id !== undefined) {
      const sel = c.req.method === "GET" ? tickets.take(id) : tickets.peek(id);
      if (!sel) return c.json({ error: "download link expired or already used" }, 410);
      ({ dir, names } = sel);
    }
    const sel = await ar.prepareSelection(root, dir, names);
    const base = sel.names.length === 1 ? sel.names[0]! : path.posix.basename(sel.d.virtual) || "files";
    const headers = {
      "Content-Type": "application/zip",
      "Content-Disposition": dispo(base + ".zip"),
      "X-Content-Type-Options": "nosniff",
    };
    if (c.req.method === "HEAD") return new Response(null, { headers });
    await ar.assertSandboxUsable();
    const client = clientKey(c, cfg.agentToken);
    const slot = await downloadGate.acquire(c.req.raw.signal, client); // a client over its own limit (or a full pool) is answered 429 here, before the response starts
    const stream = ar.zipStream(sel.d.real, sel.names, c.req.raw.signal, { root, slot, client });
    return new Response(Readable.toWeb(stream) as ReadableStream, { headers });
  });
  app.post("/api/fs/zip-ticket", async (c) => {
    const b = await body<{ dir?: string; names?: string[] }>(c);
    const dir = b.dir === undefined ? "/" : str(b.dir, "dir");
    const names = strs(b.names, "names");
    if (names.length > MAX_NAMES) throw bad(`names must hold at most ${MAX_NAMES} entries`);
    await ar.prepareSelection(root, dir, names); // refuse a bad selection now, not at download time
    const id = tickets.issue({ dir, names });
    if (!id) return c.json({ error: "too many pending downloads" }, 429);
    return c.json({ id }, 201);
  });

  app.get("/api/jobs", (c) => c.json({ jobs: jobs.list() }));
  app.get("/api/jobs/:id", (c) => {
    jobs.touch(c.req.param("id")); // a client polling a CLI du job keeps it alive
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
    // Allowlisted fields only, and none at all when a password was given: that job is failed after a restart, never stored.
    const params = plan.password ? undefined : { dir: b.dir, names: b.names, format: b.format, name: b.name, level: b.level, encryptHeaders: b.encryptHeaders, splitBytes: b.splitBytes, exclude: b.exclude, destDir: b.destDir };
    const job = jobs.create("compress", `Compress ${plan.names.length} item(s) to ${plan.outName}`, (ctl) => runCompress(plan, ctl), undefined, undefined, { params });
    return c.json(job, 202);
  });

  app.post("/api/jobs/extract", async (c) => {
    const b = await body<{ path?: string; destDir?: string; subfolder?: boolean; overwrite?: string; entries?: string[] }>(c);
    const slot = await listGate.acquire(c.req.raw.signal, clientKey(c, cfg.agentToken)); // preparing reads the archive's listing (and checks a password): the listing pool
    let plan: Awaited<ReturnType<typeof ar.prepareExtract>>;
    try {
      plan = await ar.prepareExtract(root, str(b.path, "path"), str(b.destDir, "destDir"), b.subfolder !== false, {
        overwrite: b.overwrite as ar.OverwritePolicy | undefined,
        entries: b.entries === undefined ? [] : strs(b.entries, "entries"),
        password: pw(c),
      });
    } finally {
      slot.release();
    }
    // judged on the resolved destination and the real archive name, which are what the extraction will use
    if (extractBlocked(root, cfg.readOnly, plan, ar.archiveBase)) throw new ops.FsError(403, "read-only volume");
    const job = jobs.create("extract", `Extract ${plan.entries.length ? `${plan.entries.length} item(s) from ` : ""}${plan.archiveName}`, (ctl) => runExtract(plan, ctl));
    return c.json(job, 202, plan.viaSz ? { "x-filedeck-pw": "ok" } : {});
  });

  return jobs;
}
