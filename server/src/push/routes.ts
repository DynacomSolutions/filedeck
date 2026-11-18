import type { Context, Hono } from "hono";
import { currentUser } from "../auth/context.ts";
import { pushHostAllowed, type PushStore } from "./store.ts";

/** subscriptions kept per account; a new one past this replaces the oldest */
const MAX_PER_OWNER = 20;
const B64U = /^[A-Za-z0-9_-]+={0,2}$/;

/** The account a request's subscriptions belong to: `sys:<name>` / `virt:<name>`, `` with sign-in off. */
export const pushOwner = (): string => {
  const id = currentUser();
  return id ? `${id.kind}:${id.name}` : "";
};

/**
 * The push routes (hub). `GET /api/push/key`: the hub's VAPID public key. `POST /api/push/subscribe`: this browser's subscription, kept
 * with the account and the session (it ends with the session). `DELETE /api/push/subscribe`: removes the caller's own. Off
 * (`FILEDECK_PUSH=off`): every route answers 404, and the page keeps to its local notifications.
 */
export function registerPush(app: Hono, o: { store?: PushStore; signIn: boolean; hosts: string[] }): void {
  const off = (c: Context) => c.json({ error: "push notifications are off" }, 404);
  const { store } = o;
  if (!store) {
    app.all("/api/push/*", off);
    return;
  }
  app.get("/api/push/key", (c) => c.json({ publicKey: store.keys().publicKey }));
  app.post("/api/push/subscribe", async (c) => {
    const b = (await c.req.json().catch(() => null)) as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } } | null;
    const endpoint = b?.endpoint;
    const p256dh = b?.keys?.p256dh;
    const auth = b?.keys?.auth;
    if (typeof endpoint !== "string" || endpoint.length > 2048 || !pushHostAllowed(endpoint, o.hosts)) return c.json({ error: "endpoint: not a push service address" }, 400);
    if (typeof p256dh !== "string" || !B64U.test(p256dh) || Buffer.from(p256dh, "base64url").length !== 65) return c.json({ error: "keys.p256dh: not a P-256 public key" }, 400);
    if (typeof auth !== "string" || !B64U.test(auth) || Buffer.from(auth, "base64url").length !== 16) return c.json({ error: "keys.auth: not a 16-byte secret" }, 400);
    const session = o.signIn ? ((c.get("authSession" as never) as string | undefined) ?? null) : null;
    // a subscription ends with its session: a request with none (the API token) cannot make one
    if (o.signIn && !session) return c.json({ error: "push notifications need a signed-in session" }, 403);
    const owner = pushOwner();
    store.add({ endpoint, p256dh, auth, owner, session });
    const mine = store.of(owner);
    for (const s of mine.slice(0, Math.max(0, mine.length - MAX_PER_OWNER))) store.drop(s.endpoint);
    return c.json({ ok: true });
  });
  app.delete("/api/push/subscribe", async (c) => {
    const b = (await c.req.json().catch(() => null)) as { endpoint?: unknown } | null;
    if (typeof b?.endpoint !== "string") return c.json({ error: "endpoint: required" }, 400);
    return c.json({ removed: store.remove(b.endpoint, pushOwner()) });
  });
}
