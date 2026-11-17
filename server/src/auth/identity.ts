import { createHmac, hkdfSync, timingSafeEqual } from "node:crypto";

/** A path a virtual account may use on one node, and whether it may change it. */
export interface Grant {
  path: string;
  write: boolean;
}

/** What a virtual account may do on one node: the system user the agent acts as, and the paths it may reach. */
export interface NodeAccess {
  runAs: string;
  grants: Grant[];
}

/** Who a request belongs to. `sys` is a system account; `virt` is a virtual account with per-node access. */
export type Identity =
  | { kind: "sys"; name: string; admin: boolean; epoch: number }
  | { kind: "virt"; name: string; admin: boolean; epoch: number; nodes: Record<string, NodeAccess> };

/** The signed statement the hub sends to one agent about the person behind a request. */
export interface UserClaim {
  kind: "sys" | "virt";
  name: string;
  epoch: number;
  runAs?: string;
  grants?: Grant[];
  /** issue time, ms since the epoch */
  iat: number;
}

export const USER_HEADER = "x-filedeck-user";

const MAX_AGE_MS = 60_000;
const MAX_SKEW_MS = 5_000;

/** The claim for one node, or null when a virtual account has no access there. */
export function claimFor(id: Identity, node: string, now: number): UserClaim | null {
  if (id.kind === "sys") return { kind: "sys", name: id.name, epoch: id.epoch, iat: now };
  const access = id.nodes[node];
  if (!access) return null;
  return { kind: "virt", name: id.name, epoch: id.epoch, runAs: access.runAs, grants: access.grants.map((g) => ({ ...g })), iat: now };
}

function key(agentToken: string): Buffer {
  return Buffer.from(hkdfSync("sha256", agentToken, "", "filedeck-user-header-v1", 32));
}

function mac(payload: string, agentToken: string): Buffer {
  return createHmac("sha256", key(agentToken)).update(payload).digest();
}

/** `base64url(JSON) "." base64url(HMAC)`. The key comes from the shared agent token. */
export function signClaim(claim: UserClaim, agentToken: string): string {
  const payload = Buffer.from(JSON.stringify(claim)).toString("base64url");
  return `${payload}.${mac(payload, agentToken).toString("base64url")}`;
}

/** The claim when the MAC matches and the claim is fresh; null otherwise. Never throws. */
export function verifyClaim(value: string, agentToken: string, now: number): UserClaim | null {
  try {
    const parts = value.split(".");
    if (parts.length !== 2) return null;
    const payload = parts[0] as string;
    const sig = parts[1] as string;
    const given = Buffer.from(sig, "base64url");
    const want = mac(payload, agentToken);
    if (given.length !== want.length || !timingSafeEqual(given, want)) return null;
    const c = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as UserClaim;
    if (!c || typeof c !== "object" || typeof c.iat !== "number" || !Number.isFinite(c.iat)) return null;
    if (c.kind !== "sys" && c.kind !== "virt") return null;
    if (typeof c.name !== "string" || typeof c.epoch !== "number") return null;
    if (c.kind === "virt") {
      if (typeof c.runAs !== "string" || !Array.isArray(c.grants)) return null;
      for (const g of c.grants) {
        if (!g || typeof g !== "object" || typeof g.path !== "string" || typeof g.write !== "boolean") return null;
      }
    }
    if (now - c.iat > MAX_AGE_MS || c.iat - now > MAX_SKEW_MS) return null;
    return c;
  } catch {
    return null;
  }
}
