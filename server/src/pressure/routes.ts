import type { Hono } from "hono";
import type { PressureCollector } from "./collector.ts";
import type { Snapshot } from "./types.ts";
import { pressureMetricLines } from "./metrics.ts";

export const DISK_PRESSURE_PATH = "/api/v1/disk-pressure";
export const DISK_PRESSURE_STREAM_PATH = "/api/v1/disk-pressure/stream";
const MAX_STREAMS = 32;
const NDJSON = { "content-type": "application/x-ndjson", "cache-control": "no-store", "x-accel-buffering": "no" };
const enc = new TextEncoder();

/** `disk` and `top` of a pressure request, or an error text. `top` is 0 to 100 (default 20). */
export function pressureQuery(q: URLSearchParams): { disk?: string; top: number } | { error: string } {
  const disk = q.get("disk") ?? undefined;
  if (disk !== undefined && !/^[A-Za-z0-9._:-]{1,64}$/.test(disk)) return { error: "disk is a device name such as nvme0n1" };
  const t = q.get("top");
  let top = 20;
  if (t !== null) {
    if (!/^\d{1,3}$/.test(t) || Number(t) > 100) return { error: "top is a whole number from 0 to 100" };
    top = Number(t);
  }
  return { ...(disk !== undefined ? { disk } : {}), top };
}

/**
 * `GET /api/v1/disk-pressure` (one snapshot) and `GET /api/v1/disk-pressure/stream` (NDJSON: `{"type":"ready"}`, then one snapshot per interval) on the agent.
 * Same callers as `/api/v1/changes`: the hub, with the agent token. A slow reader gets the latest snapshot and skips the ones in between.
 * Both routes exist only with FILEDECK_PRESSURE on; the metrics (`/metrics`) are added by `pressureMetricLines`.
 */
export function registerPressureRoutes(app: Hono, collector: PressureCollector): void {
  app.get(DISK_PRESSURE_PATH, async (c) => {
    const q = pressureQuery(new URL(c.req.url).searchParams);
    if ("error" in q) return c.json({ error: q.error }, 400);
    const s = await collector.read(c.req.raw.signal);
    if (!s) return c.json({ error: "no sample yet" }, 503);
    return new Response(collector.format(s, q.disk, q.top), { headers: { "content-type": "application/json", "cache-control": "no-store" } });
  });
  let open = 0;
  app.get(DISK_PRESSURE_STREAM_PATH, (c) => {
    const q = pressureQuery(new URL(c.req.url).searchParams);
    if ("error" in q) return c.json({ error: q.error }, 400);
    if (open >= MAX_STREAMS) return c.json({ error: "too many pressure streams" }, 429);
    const signal = c.req.raw.signal;
    let leave: (() => void) | undefined;
    let wake: (() => void) | undefined;
    let latest: Snapshot | undefined;
    let closed = false;
    const end = () => {
      if (closed) return;
      closed = true;
      open--;
      leave?.();
      wake?.();
    };
    open++;
    const body = new ReadableStream<Uint8Array>(
      {
        start(ctl) {
          ctl.enqueue(enc.encode('{"type":"ready"}\n'));
          signal.addEventListener("abort", end, { once: true });
          // a live view: the collector samples for as long as this stream is open
          leave = collector.subscribe((s) => {
            latest = s;
            wake?.();
          });
        },
        async pull(ctl) {
          // one snapshot at a time: while the client is slow, pull is not called and the snapshots in between are dropped
          while (!latest && !closed) await new Promise<void>((r) => (wake = r));
          wake = undefined;
          const s = latest;
          latest = undefined;
          if (!s || closed) {
            end();
            try {
              ctl.close();
            } catch {
              /* already closed */
            }
            return;
          }
          ctl.enqueue(enc.encode(collector.format(s, q.disk, q.top) + "\n"));
        },
        cancel: end,
      },
      { highWaterMark: 0 },
    );
    return new Response(body, { headers: NDJSON });
  });
}

export { pressureMetricLines };
