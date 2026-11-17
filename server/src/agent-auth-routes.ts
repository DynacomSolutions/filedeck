import type { Hono } from "hono";
import type { HostPam } from "./host-pam.ts";
import type { AccountResolver } from "./local-accounts.ts";

/**
 * The agent's sign-in routes (sign-in on only; with it off they do not exist). The hub calls them with the agent token and no user
 * (`isAgentAuthRoute`), and the root process answers them itself. Each answers 200 with a result; the hub decides what the person sees.
 *
 * - `POST /api/auth/password {name, password}`: `{result}` from the machine's PAM (`HostPam`); `unavailable` when PAM cannot be used here.
 *
 * The password is never logged, never put in an audit line (the audit keeps only named fields, and `password` is not one) and never
 * echoed in an error.
 */
export function registerAgentAuthRoutes(app: Hono, o: { pam?: HostPam | Promise<HostPam | undefined>; accounts: () => Promise<AccountResolver> }): void {
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
}
