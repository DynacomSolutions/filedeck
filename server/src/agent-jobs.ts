import type { Context, Hono } from "hono";
import type { UserClaim } from "./auth/identity.ts";
import type { Config } from "./config.ts";
import { FsError } from "./fsops.ts";
import { insideGrants } from "./grant-guard.ts";
import { cleanVirtual } from "./paths.ts";
import type { JobView, Jobs } from "./jobs.ts";
import type { SizeAccess } from "./props.ts";
import { MAX_CAN_LIST } from "./agent-routes.ts";
import type { WorkerPool, WorkerSpec } from "./worker-pool.ts";
import { GateAnswer, clientResponse, grantsOf, workerKey, type AccountWorkers } from "./agent-workers.ts";

/**
 * Sign-in on: the root routes that hold or reach an account's data follow the account. The jobs of the root process (folder sizes)
 * belong to the account that started them, the job routes also reach the account's own worker (its archive and permission jobs), and
 * folder sizes leave out what the account cannot open (props.ts, `SizeAccess`). Sign-in off: none of this is used.
 */

/** The owner of a request's jobs: `<kind>:<name>` of its claim. */
export const ownerOf = (claim: UserClaim): string => `${claim.kind}:${claim.name}`;

/** the claim of a request (the gate has checked it; a root route without one is a probe, which never comes here) */
function claimOf(c: Context): UserClaim {
  const claim = c.get("user" as never) as UserClaim | undefined;
  if (!claim) throw new GateAnswer(Response.json({ error: "no user" }, { status: 401 }), "no user");
  return claim;
}
const workerOf = (claim: UserClaim) => ({ key: workerKey(claim), kind: claim.kind, name: claim.name, epoch: claim.epoch });
const notFound = () => Response.json({ error: "not found" }, { status: 404 });
/** what a person who follows a job of another account sees of it: not the path the scan is at, not the queue (other people's jobs) */
const followerView = (v: JobView): JobView => {
  const { queue: _q, ...rest } = v;
  return { ...rest, progress: { ...v.progress, current: "" } };
};
/**
 * A root job as its owner sees it: never the path the walk is at (the walk runs as root, so it passes folders the owner cannot open), and
 * of the jobs ahead in the queue, another account's only by its state (no id, no title).
 */
export function ownView(jobs: Pick<Jobs, "ownerOf">, me: string, v: JobView): JobView {
  const out: JobView = { ...v, progress: { ...v.progress, current: "" } };
  if (v.queue) out.queue = { position: v.queue.position, ahead: v.queue.ahead.map((x) => (x.id !== undefined && jobs.ownerOf(x.id) === me ? x : { state: x.state })) };
  return out;
}
/** jobs that may be followed by others, kept at most */
const MAX_FOLLOWED = 1024;

/** Per root job, the accounts other than its owner who may follow it (their size or du request joined its scan). Shared by the size and job routes. */
export class Followers {
  private readonly by = new Map<string, Set<string>>();
  constructor(private readonly jobs: Pick<Jobs, "ownerOf" | "get">) {}
  add(owner: string, id: string): void {
    if (this.jobs.ownerOf(id) === owner) return;
    if (this.by.size >= MAX_FOLLOWED) for (const k of this.by.keys()) if (!this.jobs.get(k)) this.by.delete(k);
    if (this.by.size >= MAX_FOLLOWED) this.by.delete(this.by.keys().next().value!);
    let s = this.by.get(id);
    if (!s) this.by.set(id, (s = new Set()));
    s.add(owner);
  }
  has(owner: string, id: string): boolean {
    return this.by.get(id)?.has(owner) === true;
  }
  delete(id: string): void {
    this.by.delete(id);
  }
}

/**
 * The job routes with sign-in on, in place of `registerJobRoutes`. `GET /api/jobs`: the root process's jobs of the request's owner, then
 * the jobs of the account's worker when one runs (none is ever started for this). `GET`, `POST .../cancel` and `DELETE` on an id: a job
 * the root process knows (its own, or one in the shared job file) is the owner's only, else 404 `{"error":"not found"}`; an id it does not
 * know goes to the account's worker, 404 when none runs. A person whose size or du request joined another account's scan may follow
 * that job (`GET`, without its current path), but it is not listed to them and they cannot cancel or dismiss it (`follows`).
 *
 * (The brief gave `specFor`; no spec is needed, since these routes never start a worker: only the key and the epoch of the claim.)
 */
export function registerOwnedJobRoutes(
  app: Hono,
  jobs: Jobs,
  o: { pool: Pick<WorkerPool, "fetchLive">; workers: Pick<AccountWorkers, "poolError">; followers: Followers; log?: (s: string) => void },
): void {
  const log = o.log ?? ((s) => console.error(s));
  const followers = o.followers;

  /** the account's worker, when one runs: its answer as the client gets it, or undefined (none runs) */
  const toWorker = async (c: Context, claim: UserClaim, p: string, method: string): Promise<Response | undefined> => {
    const w = workerOf(claim);
    const signal = c.req.raw.signal;
    let res: Response | undefined;
    try {
      res = await o.pool.fetchLive(w, new Request(`http://worker${p}`, { method, signal }));
    } catch (e) {
      return o.workers.poolError(e, w.key, signal);
    }
    return res && clientResponse(res, w.key, log, signal, method);
  };

  app.get("/api/jobs", async (c) => {
    const claim = claimOf(c);
    const me = ownerOf(claim);
    const all = jobs.list(me).map((v) => ownView(jobs, me, v));
    const res = await toWorker(c, claim, "/api/jobs", "GET");
    if (res && res.status === 401) return res; // (the account changed)
    if (res?.ok) {
      const v = (await res.json().catch(() => null)) as { jobs?: unknown } | null;
      if (Array.isArray(v?.jobs)) all.push(...(v.jobs as JobView[]).filter((j) => j !== null && typeof j === "object"));
    } else if (res) {
      void res.body?.cancel().catch(() => {});
      log(`worker ${workerKey(claim)}: job list answered ${res.status}; listed without the worker's jobs`);
    }
    return c.json({ jobs: all.sort((a, b) => (Number(b.createdAt) || 0) - (Number(a.createdAt) || 0)) });
  });

  /** a job of the root process: whether the request's owner started it, or follows it; undefined when the root process does not know the id */
  const local = (c: Context, id: string) => {
    const v = jobs.get(id);
    if (!v) return undefined;
    const me = ownerOf(claimOf(c));
    return { v, me, mine: jobs.ownerOf(id) === me, follower: followers.has(me, id) };
  };
  const path = (id: string, rest = "") => `/api/jobs/${encodeURIComponent(id)}${rest}`;

  app.get("/api/jobs/:id", async (c) => {
    const id = c.req.param("id");
    const l = local(c, id);
    if (l) {
      if (!l.mine && !l.follower) return notFound();
      jobs.touch(id); // a client polling a CLI du job keeps it alive
      const v = jobs.get(id) ?? l.v;
      return c.json(l.mine ? ownView(jobs, l.me, v) : followerView(v));
    }
    return (await toWorker(c, claimOf(c), path(id), "GET")) ?? notFound();
  });
  app.post("/api/jobs/:id/cancel", async (c) => {
    const id = c.req.param("id");
    const l = local(c, id);
    if (l) {
      if (!l.mine) return notFound();
      const j = jobs.cancel(id);
      return j ? c.json(ownView(jobs, l.me, j)) : notFound();
    }
    return (await toWorker(c, claimOf(c), path(id, "/cancel"), "POST")) ?? notFound();
  });
  app.delete("/api/jobs/:id", async (c) => {
    const id = c.req.param("id");
    const l = local(c, id);
    if (l) {
      if (!l.mine) return notFound();
      if (!jobs.dismiss(id)) return c.json({ error: "not found or still active" }, 404);
      followers.delete(id);
      return c.json({ ok: true });
    }
    return (await toWorker(c, claimOf(c), path(id), "DELETE")) ?? notFound();
  });
}

/**
 * How folder sizes follow the account (props.ts `SizeAccess`). `canList` asks the account's worker (`POST /_worker/can-list`, at most
 * `MAX_CAN_LIST` paths a call), which is started the normal way when none runs, since the answer needs it. A virtual account is first
 * held to its grants on the path as asked (`inside`: 403 `outside your folders`, also for a folder that only leads to a grant, whose total
 * would tell the size of everything else in it). Inside a grant, a folder's total counts everything below it; for a system account, a
 * folder it can open counts also the folders below it that it cannot (docs/security.md).
 */
export function sizeAccess(
  cfg: Config,
  o: { pool: Pick<WorkerPool, "fetch">; workers: Pick<AccountWorkers, "specFor" | "poolError">; jobs: Pick<Jobs, "ownerOf">; followers: Followers; log?: (s: string) => void },
): SizeAccess {
  const log = o.log ?? ((s) => console.error(s));
  /** one spec per request (an answer asks once per batch of entries) */
  const specs = new WeakMap<Context, Promise<WorkerSpec>>();
  const specOf = (c: Context): Promise<WorkerSpec> => {
    let p = specs.get(c);
    if (!p) specs.set(c, (p = o.workers.specFor(claimOf(c))));
    return p;
  };
  return {
    async canList(c, paths) {
      const spec = await specOf(c);
      const signal = c.req.raw.signal;
      const out: boolean[] = [];
      for (let i = 0; i < paths.length; i += MAX_CAN_LIST) {
        const part = paths.slice(i, i + MAX_CAN_LIST);
        const req = new Request("http://worker/_worker/can-list", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ paths: part }), signal });
        let res: Response;
        try {
          res = await o.pool.fetch(spec, req);
        } catch (e) {
          throw new GateAnswer(o.workers.poolError(e, spec.key, signal), "the account's worker did not answer");
        }
        if (!res.ok) throw new GateAnswer(clientResponse(res, spec.key, log, signal), "the account's worker refused");
        const v = (await res.json().catch(() => null)) as { ok?: unknown } | null;
        if (!Array.isArray(v?.ok) || v.ok.length !== part.length) {
          log(`worker ${spec.key}: bad answer to can-list`);
          throw new GateAnswer(Response.json({ error: "bad answer from the worker" }, { status: 502 }), "bad answer from the worker");
        }
        out.push(...v.ok.map((x) => x === true));
      }
      return out;
    },
    inside(c, p, exact) {
      const claim = claimOf(c);
      if (claim.kind !== "virt") return;
      const grants = grantsOf(claim);
      // (not exact: the path as written, no lstat here; the person cannot open it, so its links are not theirs to see)
      const ok = exact ? insideGrants(cfg.root, grants, p) : ((v: string) => grants.some((g) => g.path === "/" || v === g.path || v.startsWith(g.path + "/")))("/" + cleanVirtual(p).join("/"));
      if (!ok) throw new FsError(403, "outside your folders");
    },
    owner: (c) => ownerOf(claimOf(c)),
    follows: (c, id) => o.followers.add(ownerOf(claimOf(c)), id),
    view(c, v) {
      const me = ownerOf(claimOf(c));
      o.followers.add(me, v.id);
      return o.jobs.ownerOf(v.id) === me ? ownView(o.jobs, me, v) : followerView(v);
    },
    log,
  };
}
