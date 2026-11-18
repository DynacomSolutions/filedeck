import type { Context } from "hono";

/**
 * The owner of a job a request starts: `<kind>:<name>` of the claim the agent's check stored (sign-in on). Only the root process has
 * one, and there only for a request made under act as root (all others go to a worker); with sign-in off, and in a worker, none.
 */
export const requestOwner = (c: Context): string | undefined => {
  const u = c.get("user");
  return u?.kind && u.name ? `${u.kind}:${u.name}` : undefined;
};

/**
 * When a job a request starts must stop, by this process's clock: the act-as-root end of the claim the agent's check stored, counted
 * from the claim's issue time (so the hub's clock and this one need not agree). Only for a request made under act as root, whose job
 * runs as root here and must stop with the switch; else undefined.
 */
export const requestRootEnd = (c: Context): number | undefined => {
  const u = c.get("user") as { asRoot?: unknown; asRootUntil?: unknown; iat?: unknown } | undefined;
  if (u?.asRoot !== true || typeof u.asRootUntil !== "number" || typeof u.iat !== "number") return undefined;
  return Date.now() + Math.max(0, u.asRootUntil - u.iat);
};
/**
 * The job meta of a request: its owner and, under act as root, its end by this process's clock (`until`) and the switch's end as the hub
 * gave it (`rootSwitch`), which names the switch.
 */
export const requestJobMeta = (c: Context): { owner?: string; until?: number; rootSwitch?: number } => {
  const owner = requestOwner(c);
  const until = requestRootEnd(c);
  const rootSwitch = until === undefined ? undefined : (c.get("user") as { asRootUntil?: number }).asRootUntil;
  return { ...(owner !== undefined ? { owner } : {}), ...(until !== undefined ? { until, rootSwitch } : {}) };
};
