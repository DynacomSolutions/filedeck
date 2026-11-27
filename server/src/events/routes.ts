import type { Hono } from "hono";
import type { EventBus } from "./bus.ts";
import { filterFromParams } from "./filter.ts";
import { subscriberBody } from "./stream.ts";

/**
 * `GET /api/v1/changes` on the agent: the change events of this machine as NDJSON, one JSON line per event, that stays open. Query: the filter
 * (`prefix`, `glob`, `kind`, `type`, `label`, each as often as needed) and `since=<cursor>` (the journal from there, then live events).
 * The hub is the only caller (agent token); with sign-in on the hub allows it to administrators only. See docs/change-events.md.
 */
export function registerChangeRoutes(app: Hono, bus: EventBus): void {
  app.get("/api/v1/changes", async (c) => {
    const q = new URL(c.req.url).searchParams;
    const filter = filterFromParams(q);
    const sub = await bus.subscribe(filter, q.get("since") || undefined, "http");
    return new Response(subscriberBody(sub, c.req.raw.signal), {
      headers: { "content-type": "application/x-ndjson", "cache-control": "no-store", "x-accel-buffering": "no" },
    });
  });
}
