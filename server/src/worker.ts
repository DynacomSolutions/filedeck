import { Hono } from "hono";
import fs from "node:fs";
import net from "node:net";
import { fileURLToPath } from "node:url";
import { agentError, registerFileRoutes } from "./agent-routes.ts";
import { makeAgentJobs, registerJobRoutes } from "./archive-routes.ts";
import { readOnlyGuard } from "./readonly.ts";
import { withReadOnly } from "./pinwalk.ts";
import { Mux } from "./worker-proto.ts";
import type { Config } from "./config.ts";

/**
 * A worker process serves the file routes for one signed-in account, as that account. The agent's root process starts it with one socket on descriptor 3,
 * sends it a `WorkerInit` (HELLO) and forwards the account's requests to it over that socket (worker-proto.ts).
 */

/** The worker's start-up message. `cfg` comes from `workerConfig` and holds no secret. */
export interface WorkerInit {
  cfg: Config;
  account: { kind: "sys" | "virt"; name: string; uid: number };
  trashFolder: string;
}

/**
 * The worker's app: the agent's read-only checks and error answer, every file route, and the job list over jobs kept in memory (a worker cannot write the root
 * process's shared job file). The root process checks the agent token and the signed user, writes the audit log, and keeps `/healthz`, `/metrics`, `/api/info`
 * and the folder sizes.
 */
export function createWorkerApp(cfg: Config): Hono {
  const app = new Hono();
  app.use("*", (_c, next) => withReadOnly(cfg.root, cfg.readOnly, next)); // the pinned operations re-check where their descriptors really point
  app.use("*", readOnlyGuard(cfg.root, cfg.readOnly));
  app.onError(agentError);
  const jobs = makeAgentJobs({ ...cfg, jobsFile: "" });
  const files = registerFileRoutes(app, cfg, jobs);
  registerJobRoutes(app, jobs);
  (app as unknown as { close: () => Promise<void> }).close = async () => {
    await jobs.interrupt();
    files.close();
  };
  return app;
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
      app = createWorkerApp({ ...i.cfg, worker: true });
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
