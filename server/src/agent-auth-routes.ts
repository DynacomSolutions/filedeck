import type { Hono } from "hono";
import type { HostPam } from "./host-pam.ts";
import type { KeyCheck } from "./agent-keys.ts";
import { validSystemName, type AccountResolver } from "./local-accounts.ts";

/**
 * The agent's sign-in routes (sign-in on only; with it off they do not exist). The hub calls them with the agent token and no user
 * (`isAgentAuthRoute`), and the root process answers them itself. Each answers 200 with a result; the hub decides what the person sees.
 *
 * - `POST /api/auth/password {name, password}`: `{result}` from the machine's PAM (`HostPam`); `unavailable` when PAM cannot be used here.
 * - `POST /api/auth/key {name, publicKey, message, signature}` (`message` and `signature` base64): `{result}` from `KeyCheck` (the key
 *   listed in the user's own authorized_keys, read as the user); `unavailable` when there is no key check here or the account lookup fails.
 *
 * The password, the key and the signature are never logged, never put in an audit line (an `/api/auth/` body keeps only its `name`) and
 * never echoed in an error.
 */
export function registerAgentAuthRoutes(
  app: Hono,
  o: { pam?: HostPam | Promise<HostPam | undefined>; keys?: KeyCheck | Promise<KeyCheck | undefined>; accounts: () => Promise<AccountResolver>; log?: (s: string) => void },
): void {
  const log = o.log ?? ((s: string) => console.error(s));
  app.post("/api/auth/password", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      body = undefined;
    }
    const { name, password } = (body && typeof body === "object" && !Array.isArray(body) ? body : {}) as { name?: unknown; password?: unknown };
    if (typeof name !== "string" || typeof password !== "string") return c.json({ error: "name and password are needed" }, 400);
    const pam = await o.pam;
    return c.json({ result: pam ? await pam.check(name, password) : "unavailable" });
  });

  app.post("/api/auth/key", async (c) => {
    const body = await c.req.json().catch(() => undefined);
    const b = keyBody(body);
    if (!b) return c.json({ error: "name, publicKey, message and signature are needed" }, 400);
    const keys = await o.keys;
    if (!keys) return c.json({ result: "unavailable" });
    try {
      return c.json({ result: await keys.check(b.name, b.publicKey, b.message, b.signature) });
    } catch (e) {
      log(`keys: unavailable (${(e as Error)?.message ?? String(e)})`);
      return c.json({ result: "unavailable" });
    }
  });
}

/** Base64 of at most `max` decoded bytes (padded, the standard alphabet), or null. */
function base64(v: unknown, max: number): Buffer | null {
  if (typeof v !== "string" || v.length === 0 || v.length > Math.ceil(max / 3) * 4 || v.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(v)) return null;
  return Buffer.from(v, "base64");
}

/** The most a sign-in message may hold (four SSH strings: a fixed tag, the hub's id, the name and a 32-byte challenge) and a signature (64 bytes for both key types). */
const MAX_MESSAGE = 1024;
const MAX_SIGNATURE = 128;
/** One `authorized_keys`-style line: the type, the key and a comment. */
const MAX_PUBLIC_KEY = 4096;

function keyBody(body: unknown): { name: string; publicKey: string; message: Buffer; signature: Buffer } | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const { name, publicKey, message, signature } = body as Record<string, unknown>;
  if (typeof name !== "string" || !validSystemName(name)) return null;
  if (typeof publicKey !== "string" || publicKey.length === 0 || publicKey.length > MAX_PUBLIC_KEY || /[\r\n\0]/.test(publicKey)) return null;
  const m = base64(message, MAX_MESSAGE);
  const s = base64(signature, MAX_SIGNATURE);
  if (!m || !s) return null;
  return { name, publicKey, message: m, signature: s };
}
