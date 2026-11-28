import type { Hono } from "hono";
import type { Config } from "./config.ts";
import type { UserClaim } from "./auth/identity.ts";
import { FsError } from "./fsops.ts";
import { resolveRead } from "./paths.ts";
import type { Holders } from "./holders.ts";

/** The path of the holders question, on the agent and (behind `/api/nodes/<node>`) on the hub. */
export const HOLDERS_PATH = "/api/v1/holders";

/**
 * `GET /api/v1/holders?path=<folder or file>` on the agent: the processes that hold anything under the path (a working folder, a root folder, an
 * executable, an open file or a mapping), as the live table of the eBPF helper sees them (holders.ts).
 *
 * The answer is 200 with `proven: true` only when the table has no gap that matters, and "no holder" is a proof only then. Where the feature is off or
 * cannot run (no BPF, no BTF, no permission, not Linux) the answer is still 200, with `feature.state` and `proven: false`, never an error.
 * With sign-in on only administrators may ask, as for the change events: it names the processes of the whole machine.
 */
export function registerHolderRoutes(app: Hono, cfg: Config, holders: Holders): void {
  app.get(HOLDERS_PATH, async (c) => {
    if (cfg.auth && (c.get("user") as UserClaim | undefined)?.admin !== true) return c.json({ error: "administrators only" }, 403);
    const p = c.req.query("path");
    if (p === undefined || p === "") throw new FsError(400, "path is required");
    const r = resolveRead(cfg.root, p);
    return c.json(await holders.query(r.real, r.virtual), 200, { "cache-control": "no-store" });
  });
}
