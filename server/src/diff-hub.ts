import type { Hono } from "hono";
import { FsError } from "./fsops.ts";
import { Jobs, type JobView } from "./jobs.ts";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { normalizeOptions, DIFF_STATUSES, type DiffOptions, type Status } from "./folderdiff.ts";
import { CompareSession, type DirSource, type LsEntry } from "./cmp-engine.ts";
import type { Target } from "./hub.ts";

async function agentError(r: Response, what: string): Promise<FsError> {
  let msg = r.statusText;
  try {
    msg = ((await r.json()) as { error?: string }).error ?? msg;
  } catch {
    /* not json */
  }
  const status = r.status === 404 ? 404 : r.status === 403 ? 403 : r.status === 400 ? 400 : 500;
  return new FsError(status as 400, `${what}: ${msg}`);
}

/** DirSource that talks to one agent (or network source) over HTTP; listings and hashes run next to the data. */
export function agentSource(base: Target, vpath: string, label: string): DirSource {
  const at = (rel: string) => (rel ? (vpath === "/" ? "" : vpath) + "/" + rel : vpath);
  return {
    async list(rel, signal) {
      const r = await base.fetch(`/api/fs/lsdir?path=${encodeURIComponent(at(rel))}`, { signal });
      if (!r.ok) throw await agentError(r, `${label} folder`);
      const j = (await r.json()) as { entries: LsEntry[]; cached?: boolean };
      return { entries: j.entries, cached: j.cached === true };
    },
    async hash(rel, signal) {
      const r = await base.fetch(`/api/fs/hash?path=${encodeURIComponent(at(rel))}`, { signal });
      if (!r.ok) throw await agentError(r, "hash");
      return ((await r.json()) as { sha256: string }).sha256;
    },
    async changes(since, signal) {
      const r = await base.fetch(`/api/fs/index-changes?since=${since}`, { signal });
      if (!r.ok) throw await agentError(r, `${label} changes`);
      const j = (await r.json()) as { seq: number; dirs: string[]; reset: boolean };
      const pre = vpath === "/" ? "" : vpath;
      const dirs: string[] = [];
      for (const d of j.dirs) {
        if (d === vpath) dirs.push("");
        else if (d.startsWith(pre + "/")) dirs.push(d.slice(pre.length + 1));
      }
      return { seq: j.seq, dirs, reset: j.reset };
    },
  };
}

interface Loc {
  node: string;
  path: string;
}

export function registerHubDiff(app: Hono, agents: Map<string, Target>, diffDir = ""): Jobs {
  const jobs = new Jobs(2, 20, (e) => {
    if (e instanceof FsError) return e.message;
    if ((e as Error)?.name === "AbortError") return "canceled";
    return "agent unreachable";
  });
  const meta = new Map<string, { left: Loc; right: Loc; options: DiffOptions }>();
  /** live sessions (rows spill to one SQLite file each under diffDir); closed when their job is dismissed or evicted */
  const sessions = new Map<string, CompareSession>();
  if (diffDir) {
    fs.rmSync(diffDir, { recursive: true, force: true }); // leftovers of a previous process
    fs.mkdirSync(diffDir, { recursive: true });
  }
  const prune = () => {
    for (const id of meta.keys()) if (!jobs.get(id)) meta.delete(id);
    for (const [id, s] of sessions) if (!jobs.get(id)) (s.close(), sessions.delete(id));
  };

  const loc = (v: unknown, what: string): Loc => {
    const o = v as Partial<Loc> | null;
    if (!o || typeof o.node !== "string" || typeof o.path !== "string" || !o.path.startsWith("/")) {
      throw new FsError(400, `${what} must be {node, path} with an absolute path`);
    }
    if (!agents.has(o.node)) throw new FsError(404, `unknown node ${o.node}`);
    return { node: o.node, path: o.path };
  };
  const strip = (j: JobView) => {
    const { result: _r, ...rest } = j;
    const s = sessions.get(j.id);
    return { ...rest, ...(meta.get(j.id) ?? {}), ...(s ? { stats: { ...s.stats, warnings: s.warnings }, ...s.counts() } : {}) };
  };
  const session = (id: string) => {
    const s = sessions.get(id);
    if (!s) throw new FsError(404, "not found");
    return s;
  };
  const fail = (e: unknown) => {
    const m = e instanceof FsError ? { status: e.status, message: e.message } : { status: 400, message: "bad request" };
    return Response.json({ error: m.message }, { status: m.status });
  };

  app.post("/api/diff/jobs", async (c) => {
    try {
      const b = (await c.req.json().catch(() => null)) as { left?: unknown; right?: unknown; options?: unknown } | null;
      if (!b) throw new FsError(400, "invalid JSON body");
      const left = loc(b.left, "left");
      const right = loc(b.right, "right");
      const options = normalizeOptions(b.options);
      const ls = agentSource(agents.get(left.node) as Target, left.path, "left");
      const rs = agentSource(agents.get(right.node) as Target, right.path, "right");
      const t0 = Date.now();
      const sess = new CompareSession(ls, rs, options, diffDir ? path.join(diffDir, `${randomUUID()}.db`) : ":memory:");
      const job = jobs.create("folderdiff", `Compare ${left.node}:${left.path} with ${right.node}:${right.path}`, async (ctl) => {
        const s = sess;
        await s.run(ctl.signal, ctl.progress);
        return { left, right, options, ...s.counts(), hashedFiles: s.stats.hashed, hashedBytes: s.stats.hashedBytes, warnings: s.warnings, durationMs: Date.now() - t0 };
      });
      sessions.set(job.id, sess);
      sess.startLive(); // follow both agents' change feeds while the compare is open
      meta.set(job.id, { left, right, options });
      prune();
      return c.json(strip(job), 202);
    } catch (e) {
      return fail(e);
    }
  });
  app.get("/api/diff/jobs", (c) => c.json({ jobs: jobs.list().map(strip) }));
  app.get("/api/diff/jobs/:id", (c) => {
    const j = jobs.get(c.req.param("id"));
    return j ? c.json(strip(j)) : c.json({ error: "not found" }, 404);
  });
  // Legacy whole result (every row at once); kept bounded. The SPA reads rows per folder instead.
  app.get("/api/diff/jobs/:id/result", (c) => {
    const j = jobs.get(c.req.param("id"));
    if (!j) return c.json({ error: "not found" }, 404);
    if (j.state !== "done") return c.json({ error: `job is ${j.state}` }, 409);
    const s = sessions.get(j.id);
    return c.json({ ...(j.result as object), rows: s ? s.rows(500_000) : [] });
  });
  // One folder of a running or finished compare: its rows with their current (possibly pending) status.
  app.get("/api/diff/jobs/:id/rows", (c) => {
    try {
      const f = session(c.req.param("id")).folder(c.req.query("rel") ?? "");
      return f ? c.json(f) : c.json({ error: "no such folder in this compare" }, 404);
    } catch (e) {
      return fail(e);
    }
  });
  // Folders the UI shows right now: listed and hashed before anything else.
  app.post("/api/diff/jobs/:id/focus", async (c) => {
    try {
      const b = (await c.req.json().catch(() => null)) as { rels?: unknown } | null;
      const rels = Array.isArray(b?.rels) ? (b!.rels as unknown[]).filter((x): x is string => typeof x === "string") : [];
      session(c.req.param("id")).setFocus(rels);
      return c.json({ ok: true });
    } catch (e) {
      return fail(e);
    }
  });
  // Every row under the given folders (NDJSON), for planning a sync of a selection.
  app.post("/api/diff/jobs/:id/subtree", async (c) => {
    try {
      const b = (await c.req.json().catch(() => null)) as { rels?: unknown } | null;
      const rels = Array.isArray(b?.rels) ? (b!.rels as unknown[]).filter((x): x is string => typeof x === "string").slice(0, 10_000) : [];
      return ndjson(session(c.req.param("id")).subtree(rels));
    } catch (e) {
      return fail(e);
    }
  });
  // Paths of every final row with the given statuses (NDJSON), for "select differing".
  app.get("/api/diff/jobs/:id/paths", (c) => {
    try {
      const want = (c.req.query("status") ?? "").split(",").filter((x): x is Status => (DIFF_STATUSES as readonly string[]).includes(x));
      return ndjson(session(c.req.param("id")).withStatus(want));
    } catch (e) {
      return fail(e);
    }
  });
  app.post("/api/diff/jobs/:id/cancel", (c) => {
    const j = jobs.cancel(c.req.param("id"));
    return j ? c.json(strip(j)) : c.json({ error: "not found" }, 404);
  });
  app.delete("/api/diff/jobs/:id", (c) => {
    const id = c.req.param("id");
    const ok = jobs.dismiss(id);
    if (ok) {
      meta.delete(id);
      sessions.get(id)?.close();
      sessions.delete(id);
    }
    return ok ? c.json({ ok: true }) : c.json({ error: "not found or still active" }, 404);
  });
  return jobs;
}

/** Stream a generator as NDJSON, a few hundred items per chunk, so big subtrees never sit in memory at once. */
function ndjson(gen: Generator<unknown>): Response {
  const enc = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    pull(ctl) {
      let out = "";
      for (let i = 0; i < 500; i++) {
        const r = gen.next();
        if (r.done) {
          if (out) ctl.enqueue(enc.encode(out));
          ctl.close();
          return;
        }
        out += JSON.stringify(r.value) + "\n";
      }
      ctl.enqueue(enc.encode(out));
    },
    cancel() {
      gen.return(undefined);
    },
  });
  return new Response(body, { headers: { "content-type": "application/x-ndjson", "cache-control": "no-store" } });
}
