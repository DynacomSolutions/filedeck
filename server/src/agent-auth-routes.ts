import type { Hono } from "hono";
import { validClientAddress, type HostPam } from "./host-pam.ts";
import { logLine, type KeyCheck } from "./agent-keys.ts";
import { signInAccount, validSystemName, type AccountResolver } from "./local-accounts.ts";

/**
 * The agent's sign-in routes (sign-in on only; with it off they do not exist). The hub calls them with the agent token and no user
 * (`isAgentAuthRoute`), and the root process answers them itself. Each answers 200 with a result; the hub decides what the person sees.
 *
 * - `POST /api/auth/password {name, password, address}`: `{result}` from the machine's PAM (`HostPam`); `unavailable` when PAM cannot be
 *   used here or the account lookup fails. `address` is the client's address as the hub sees it (an IPv4 or IPv6 address); PAM gets it as
 *   PAM_RHOST. Without a valid one the attempt is refused with 400, before any lookup. Before PAM runs, a name that does not resolve is `unknown`, and one with uid 0, gid 0 or group 0 is
 *   `refused` (the hub then stops: such a name never signs in, whatever another machine says).
 * - `POST /api/auth/key {name, publicKey, message, signature}` (`message` and `signature` base64): `{result}` from `KeyCheck` (the key
 *   listed in the user's own authorized_keys, read as the user; `refused` for uid 0, gid 0 or group 0); `unavailable` when there is no key
 *   check here or the account lookup fails.
 * - `POST /api/auth/lookup {name}`: `{exists}`; `{exists: false, refused: true}` for uid 0, gid 0 or group 0, and false for a lookup that
 *   fails (one log line). The hub
 *   asks it for the machines a system user may see; it never passes a client's request on to it, so its rate is the hub's.
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
    const { name, password, address } = (body && typeof body === "object" && !Array.isArray(body) ? body : {}) as { name?: unknown; password?: unknown; address?: unknown };
    if (typeof name !== "string" || typeof password !== "string") return c.json({ error: "name and password are needed" }, 400);
    // (PAM must see where the attempt comes from: without it, pam_access would take a web sign-in for one at the console)
    if (!validClientAddress(address)) return c.json({ error: "the client's address is needed" }, 400);
    const pam = await o.pam;
    if (!pam) return c.json({ result: "unavailable" });
    // uid 0 is refused here too, whatever the helper would say (it refuses it as well)
    let account: Awaited<ReturnType<typeof signInAccount>>;
    try {
      account = await signInAccount(await o.accounts(), name);
    } catch (e) {
      log(`pam: unavailable (${logLine((e as Error)?.message ?? String(e))})`);
      return c.json({ result: "unavailable" });
    }
    if (account === "root") return c.json({ result: "refused" });
    if (!account) return c.json({ result: "unknown" });
    return c.json({ result: await pam.check(name, password, address) });
  });

  app.post("/api/auth/lookup", async (c) => {
    const body = (await c.req.json().catch(() => undefined)) as unknown;
    const name = body && typeof body === "object" && !Array.isArray(body) && Object.keys(body).length === 1 ? (body as { name?: unknown }).name : undefined;
    if (typeof name !== "string" || !validSystemName(name)) return c.json({ error: "a name is needed" }, 400);
    try {
      const a = await signInAccount(await o.accounts(), name);
      return c.json(a === "root" ? { exists: false, refused: true } : { exists: a !== null });
    } catch (e) {
      log(`lookup: ${name} could not be resolved (${logLine((e as Error)?.message ?? String(e))})`);
      return c.json({ exists: false });
    }
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
  const b = Buffer.from(v, "base64");
  return b.length > 0 && b.length <= max ? b : null;
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
