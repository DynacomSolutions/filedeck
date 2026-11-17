import { Hono } from "hono";
import fs from "node:fs";
import net from "node:net";
import { fileURLToPath } from "node:url";
import { agentError, registerFileRoutes } from "./agent-routes.ts";
import { makeAgentJobs, registerJobRoutes } from "./archive-routes.ts";
import { isReadOnly, readOnlyGuard } from "./readonly.ts";
import { grantGuard, mountsInGrants, type Grant } from "./grant-guard.ts";
import { listMounts } from "./mounts.ts";
import { withReadOnly } from "./pinwalk.ts";
import { Mux } from "./worker-proto.ts";
import type { Config } from "./config.ts";

/**
 * A worker process serves the file routes for one signed-in account, as that account. The agent's root process starts it with one socket on descriptor 3,
 * sends it a `WorkerInit` (HELLO) and forwards the account's requests to it over that socket (worker-proto.ts).
 */

/** The header on each worker answer that holds the number of the worker's live (queued or running) jobs. */
export const JOBS_HEADER = "x-filedeck-jobs";

/** The worker's start-up message. `cfg` comes from `workerConfig` and holds no secret. */
export interface WorkerInit {
  cfg: Config;
  account: { kind: "sys" | "virt"; name: string; uid: number };
  trashFolder: string;
  /** a virtual account's grants (paths in their compared form): every path of a request must lie inside one (grant-guard.ts) */
  grants?: Grant[];
}

/**
 * The worker's app: the agent's read-only checks and error answer, every file route, and the job list over jobs kept in memory (a worker cannot write the root
 * process's shared job file). Every answer carries `x-filedeck-jobs`. The root process checks the agent token and the signed user, writes the audit log, and
 * keeps `/healthz`, `/metrics`, `/api/info` and the folder sizes.
 */
export function createWorkerApp(cfg: Config, grants?: Grant[]): Hono {
  const app = new Hono();
  const jobs = makeAgentJobs({ ...cfg, jobsFile: "" });
  // every answer says how many jobs are queued or running, so the root process does not stop a worker that still has work
  app.use("*", async (c, next) => {
    await next();
    const n = String(jobs.active);
    try {
      c.res.headers.set(JOBS_HEADER, n);
    } catch {
      // (headers that cannot be changed: copy the answer)
      const res = new Response(c.res.body, c.res);
      res.headers.set(JOBS_HEADER, n);
      c.res = res;
    }
  });
  if (grants) app.use("*", grantGuard(cfg.root, grants)); // (after the job count step, so a refusal carries the count too)
  app.use("*", (_c, next) => withReadOnly(cfg.root, cfg.readOnly, next)); // the pinned operations re-check where their descriptors really point
  app.use("*", readOnlyGuard(cfg.root, cfg.readOnly));
  app.onError(agentError);
  // a virtual account sees only the mounts at or below its grants (registered first, so this answers instead of the general route)
  if (grants) app.get("/api/mounts", async (c) => c.json({ mounts: mountsInGrants(await listMounts(cfg.root, cfg.procMounts), grants).map((m) => (isReadOnly(cfg.readOnly, m.mountpoint) ? { ...m, readOnly: true } : m)) }));
  const files = registerFileRoutes(app, cfg, jobs);
  registerJobRoutes(app, jobs);
  (app as unknown as { close: () => Promise<void> }).close = async () => {
    await jobs.interrupt();
    files.close();
  };
  return app;
}

/**
 * Exits with one clear line when the worker cannot reach its own cache folders: the account must be able to pass through every folder
 * above them (`FILEDECK_INDEX_DIR`, `FILEDECK_THUMB_DIR` and their parents need the search bit for others).
 */
function unreachable(cfg: Config): void {
  for (const [name, dir] of [["index", cfg.indexDir], ["thumbnail", cfg.thumbDir]] as const) {
    if (!dir) continue;
    try {
      fs.accessSync(dir, fs.constants.R_OK | fs.constants.W_OK | fs.constants.X_OK);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "ENOENT") continue; // (made when it is first used)
      process.stderr.write(`worker: cannot use its ${name} folder ${dir} (${code}): the account must be able to pass through every folder above it\n`);
      process.exit(1);
    }
  }
}

function fail(e: unknown): never {
  const msg = e instanceof Error ? e.stack ?? e.message : String(e);
  process.stderr.write(`worker: ${msg.replace(/\s*\n\s*/g, " | ")}\n`);
  process.exit(1);
}

/** Runs the worker on descriptor 3 until the root process ends the socket. */
async function main(): Promise<void> {
  process.on("uncaughtException", fail);
  process.on("unhandledRejection", fail);
  const sock = new net.Socket({ fd: 3, readable: true, writable: true });
  let app: Hono | undefined;
  const mux = new Mux(sock, "worker", {
    // (the root process sends requests only after READY; this answer is for one that does not)
    onRequest: async (r) => (app ? app.fetch(r) : Response.json({ error: "worker not ready" }, { status: 503 })),
  });
  mux.onHello((init) => {
    try {
      const i = init as Partial<WorkerInit> | null;
      if (!i || typeof i.cfg !== "object" || i.cfg === null) throw new Error("bad start-up message");
      if (i.grants !== undefined && !Array.isArray(i.grants)) throw new Error("bad start-up message");
      unreachable(i.cfg);
      app = createWorkerApp({ ...i.cfg, worker: true }, i.grants);
      mux.ready();
    } catch (e) {
      fail(e);
    }
  });
  await mux.closed;
  // a malformed or repeated start-up message, or a protocol error, closes the mux: that is a failure, not the root process ending the socket
  if (mux.failure !== undefined) fail(new Error(`connection to the agent failed: ${mux.failure}`));
  if (!app) fail(new Error("the agent ended the connection before the start-up message"));
  // stop the running jobs (and their child processes) and close the index, for at most 3 s
  const closing = (app as unknown as { close: () => Promise<void> }).close().catch(() => undefined);
  await Promise.race([closing, new Promise((res) => setTimeout(res, 3000).unref())]);
  process.exit(0);
}

const isMain = (() => {
  try {
    return !!process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();
if (isMain) void main();
