import { Hono } from "hono";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { agentError, registerFileRoutes, registerWorkerRoutes } from "./agent-routes.ts";
import { makeAgentJobs, registerJobRoutes } from "./archive-routes.ts";
import { isReadOnly, readOnlyGuard } from "./readonly.ts";
import { grantGuard, insideGrants, mayChange, mountsInGrants, type Grant } from "./grant-guard.ts";
import { FsError } from "./fsops.ts";
import { TRASH_OWNER } from "./paths.ts";
import { setTrashScope } from "./trash-scope.ts";
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
  registerWorkerRoutes(app, cfg, grants); // (for the root process only: its gate refuses /_ paths over HTTP)
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

/**
 * Exits with one line unless the worker's TMPDIR (also its HOME) is its own folder, mode 0700, given by its real path (no link in any part):
 * its archive staging and the tools it starts write there, so nobody else may change or replace it.
 */
function ownTmp(): void {
  const t = process.env.TMPDIR ?? "";
  let why = "";
  try {
    const st = fs.lstatSync(t);
    if (!path.isAbsolute(t)) why = "not an absolute path";
    else if (!st.isDirectory()) why = st.isSymbolicLink() ? "a link" : "not a folder";
    else if (st.uid !== process.getuid?.() || (st.mode & 0o777) !== 0o700) why = `owner ${st.uid}, mode ${(st.mode & 0o7777).toString(8)}`;
    else if (fs.realpathSync(t) !== t) why = "a link on its path";
  } catch (e) {
    why = (e as NodeJS.ErrnoException).code ?? (e as Error).message;
  }
  if (!why) return;
  process.stderr.write(`worker: its temporary folder ${JSON.stringify(t)} is not its own 0700 folder (${why}); stopped\n`);
  process.exit(1);
}

type Status = ConstructorParameters<typeof FsError>[0];
const STATUSES = new Set<number>([400, 403, 404, 409, 500, 503]);

/**
 * The worker's trash scope: its account's own folder in each volume's trash store, which it asks the root process for over its
 * connection (`POST /_root/trash-dir`; the root process takes the account from this worker's spec). Asked once per volume (a failure
 * is asked again next time). A virtual account restores only into its grants.
 */
export function workerTrashScope(mux: Pick<Mux, "fetch">, folder: string, root: string, grants?: Grant[]) {
  const dirs = new Map<string, Promise<string>>();
  const ask = async (volume: string): Promise<string> => {
    const res = await mux.fetch(new Request("http://root/_root/trash-dir", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ volume }) }));
    const v = (await res.json().catch(() => ({}))) as { dir?: unknown; error?: unknown };
    if (!res.ok || typeof v.dir !== "string") {
      const status = (STATUSES.has(res.status) ? res.status : 500) as Status;
      throw new FsError(status, typeof v.error === "string" ? v.error : "no trash folder");
    }
    return v.dir;
  };
  return {
    folder,
    ensure(volume: string): Promise<string> {
      let p = dirs.get(volume);
      if (!p) {
        p = ask(volume);
        dirs.set(volume, p);
        p.catch(() => dirs.get(volume) === p && dirs.delete(volume));
      }
      return p;
    },
    forget(volume: string): void {
      dirs.delete(volume);
    },
    // (where a restore puts an item comes from its meta.json, which the account can write: so it is checked as a change there)
    ...(grants ? { mayRestore: (v: string) => insideGrants(root, grants, v, true) && mayChange(root, grants, v, { follow: false, contains: true }) } : {}),
  };
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
  ownTmp();
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
      if (typeof i.trashFolder !== "string" || !TRASH_OWNER.test(i.trashFolder)) throw new Error("bad start-up message");
      unreachable(i.cfg);
      // every trash route works in the account's own folder
      setTrashScope(workerTrashScope(mux, i.trashFolder, i.cfg.root, i.grants));
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
