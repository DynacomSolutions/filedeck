import type { Hono } from "hono";
import { FsError } from "./fsops.ts";
import { Jobs, type JobView } from "./jobs.ts";
import { compareTrees, normalizeOptions, type DiffOptions, type DiffSource } from "./folderdiff.ts";
import type { WalkEntry, WalkOpts, WalkSummary } from "./walk.ts";

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

/** DiffSource that talks to one agent over HTTP; content hashes are computed agent-side. */
export function agentSource(base: string, vpath: string, label: string): DiffSource {
  const at = (rel: string) => (vpath === "/" ? "" : vpath) + "/" + rel;
  return {
    async walk(o: WalkOpts, signal, onEntries) {
      const q = new URLSearchParams({ path: vpath, depth: String(o.depth), max: String(o.max) });
      if (o.hidden) q.set("hidden", "1");
      if (o.ignoreCase) q.set("ignoreCase", "1");
      for (const p of o.include) q.append("include", p);
      for (const p of o.exclude) q.append("exclude", p);
      const r = await fetch(`${base}/api/fs/walk?${q}`, { signal });
      if (!r.ok || !r.body) throw await agentError(r, `${label} folder`);
      const entries: WalkEntry[] = [];
      let summary: WalkSummary | null = null;
      const dec = new TextDecoder();
      let buf = "";
      const eat = (line: string) => {
        if (!line) return;
        const m = JSON.parse(line) as { e?: WalkEntry[]; done?: WalkSummary; error?: string };
        if (m.error) throw new FsError(500, `${label} folder: ${m.error}`);
        if (m.e) {
          entries.push(...m.e);
          onEntries(entries.length);
        }
        if (m.done) summary = m.done;
      };
      for await (const chunk of r.body as unknown as AsyncIterable<Uint8Array>) {
        buf += dec.decode(chunk, { stream: true });
        let i: number;
        while ((i = buf.indexOf("\n")) >= 0) {
          eat(buf.slice(0, i));
          buf = buf.slice(i + 1);
        }
      }
      eat(buf);
      if (!summary) throw new FsError(500, `${label} folder: listing ended early`);
      return { ...(summary as WalkSummary), entries };
    },
    async hash(rel, signal) {
      const r = await fetch(`${base}/api/fs/hash?path=${encodeURIComponent(at(rel))}`, { signal });
      if (!r.ok) throw await agentError(r, "hash");
      return ((await r.json()) as { sha256: string }).sha256;
    },
  };
}

interface Loc {
  node: string;
  path: string;
}

export function registerHubDiff(app: Hono, agents: Map<string, string>): Jobs {
  const jobs = new Jobs(2, 20, (e) => {
    if (e instanceof FsError) return e.message;
    if ((e as Error)?.name === "AbortError") return "canceled";
    return "agent unreachable";
  });
  const meta = new Map<string, { left: Loc; right: Loc; options: DiffOptions }>();

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
    return { ...rest, ...(meta.get(j.id) ?? {}) };
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
      const ls = agentSource(agents.get(left.node) as string, left.path, "left");
      const rs = agentSource(agents.get(right.node) as string, right.path, "right");
      const t0 = Date.now();
      const job = jobs.create("folderdiff", `Compare ${left.node}:${left.path} with ${right.node}:${right.path}`, async (ctl) => {
        const res = await compareTrees(ls, rs, options, ctl);
        return { left, right, options, ...res, durationMs: Date.now() - t0 };
      });
      meta.set(job.id, { left, right, options });
      for (const id of meta.keys()) if (!jobs.get(id)) meta.delete(id);
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
  app.get("/api/diff/jobs/:id/result", (c) => {
    const j = jobs.get(c.req.param("id"));
    if (!j) return c.json({ error: "not found" }, 404);
    if (j.state !== "done") return c.json({ error: `job is ${j.state}` }, 409);
    return c.json(j.result);
  });
  app.post("/api/diff/jobs/:id/cancel", (c) => {
    const j = jobs.cancel(c.req.param("id"));
    return j ? c.json(strip(j)) : c.json({ error: "not found" }, 404);
  });
  app.delete("/api/diff/jobs/:id", (c) => {
    const id = c.req.param("id");
    const ok = jobs.dismiss(id);
    if (ok) meta.delete(id);
    return ok ? c.json({ ok: true }) : c.json({ error: "not found or still active" }, 404);
  });
  return jobs;
}
