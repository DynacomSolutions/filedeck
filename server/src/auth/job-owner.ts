import { runAs, userContext } from "./context.ts";
import type { Identity } from "./identity.ts";

/**
 * Whether `who` may see a job `owner` started: its owner (same kind and name) and admins may. With auth off there is no
 * caller and every job is shown, as before. A job without an owner, seen with auth on, is shown to admins only.
 */
export function seesJob(who: Identity | undefined, owner: Identity | undefined): boolean {
  if (!who || who.admin) return true;
  return !!owner && owner.kind === who.kind && owner.name === who.name;
}

const plainObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && Object.getPrototypeOf(v) === Object.prototype;

/** The owner stored with a job, or undefined for none or for a value that does not read back as an Identity. */
export function ownerFrom(json: string | null | undefined): Identity | undefined {
  if (!json) return undefined;
  try {
    const o = JSON.parse(json) as unknown;
    if (!plainObject(o) || typeof o.name !== "string" || typeof o.admin !== "boolean" || typeof o.epoch !== "number") return undefined;
    if (o.kind === "sys") return o as Identity;
    if (o.kind === "virt" && plainObject(o.nodes)) return o as Identity;
    return undefined;
  } catch {
    return undefined;
  }
}

/** Run `fn` as the job's owner; a job without one runs as nobody, never as whoever happened to start it moving. */
export function asOwner<T>(owner: Identity | undefined, fn: () => T): T {
  return owner ? runAs(owner, fn) : userContext.exit(fn);
}
