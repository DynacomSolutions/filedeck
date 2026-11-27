import { useEffect, useState } from "react";
import { BACKGROUND_HEADER } from "./api";
import { checkSignedIn, streamRetryDelay } from "./eventStream";
import { HISTORY_CAPACITY, PressureFormatError, readPressure, RingBuffer, sampleOf, stableOrder, type PressureSample, type PressureSnapshot, type RowOrder } from "./pressure";

export type PressureStatus = "connecting" | "live" | "reconnecting" | "offline" | "unavailable" | "error";

export interface PressureStreamState {
  status: PressureStatus;
  message: string;
  /** failed connection attempts in a row, for the message and the back-off */
  failures: number;
  latest: PressureSnapshot | null;
  samples: PressureSample[];
  order: RowOrder | null;
  /** a snapshot arrived and the disk was not in it */
  missing: boolean;
}

const RECONNECT_MS = 3000;
/** The stream is dropped and opened again when nothing arrives for this long (the hub sends a snapshot every second). */
const STALL_MS = 15_000;

const start: PressureStreamState = { status: "connecting", message: "Connecting…", failures: 0, latest: null, samples: [], order: null, missing: false };

/**
 * Follows GET /api/v1/pressure/stream (NDJSON) for one disk. The history lives in a bounded ring buffer for as long as the
 * component stays mounted: a new `url` (another top-N) reconnects and keeps the history, so mount one instance per node and disk.
 * A null `url` keeps the stream closed (the node is offline). The stream also closes while the page is hidden.
 */
export function usePressureStream(url: string | null, disk: string): PressureStreamState {
  const [state, setState] = useState<PressureStreamState>(start);
  const [history] = useState(() => new RingBuffer<PressureSample>(HISTORY_CAPACITY));

  useEffect(() => {
    if (!url) return;
    let stopped = false;
    let failures = 0;
    let current: AbortController | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const patch = (next: Partial<PressureStreamState>) => setState((previous) => ({ ...previous, ...next }));
    const connect = async () => {
      if (stopped || current || retry !== undefined || document.hidden) return;
      const controller = new AbortController();
      current = controller;
      patch({ status: failures ? "reconnecting" : "connecting", message: failures ? "Reconnecting…" : "Connecting…", failures });
      let stall: ReturnType<typeof setTimeout> | undefined;
      const watch = () => {
        clearTimeout(stall);
        stall = setTimeout(() => controller.abort(), STALL_MS);
      };
      let reconnect = true;
      let received = false;
      try {
        watch();
        const r = await fetch(url, { headers: BACKGROUND_HEADER, signal: controller.signal });
        if (!r.ok || !r.body || !r.headers.get("content-type")?.startsWith("application/x-ndjson")) {
          const error = await r.json().catch(() => null) as { error?: string } | null;
          if (current !== controller) return;
          if (r.status === 404 || r.status === 501) {
            reconnect = false;
            patch({ status: "unavailable", message: "This hub or node does not provide disk pressure yet.", failures: 0 });
          } else if (r.status === 401 || r.status === 403) {
            reconnect = false;
            patch({ status: "error", message: error?.error ?? "Disk pressure requires an administrator account." });
          } else {
            patch({ status: r.status === 502 || r.status === 503 || r.status === 504 ? "offline" : "error", message: error?.error ?? `The pressure stream is unavailable (HTTP ${r.status}).` });
          }
          return;
        }
        if (current !== controller) return;
        await readPressure(r.body, (event) => {
          if (current !== controller) return;
          watch();
          if (event.type === "ready") {
            received = true;
            failures = 0;
            patch({ status: "live", message: "Live", failures: 0 });
          } else if (event.type === "offline") {
            patch({ status: "offline", message: "Node offline. Waiting for its stream…" });
          } else if (event.type === "error") {
            patch({ status: "error", message: event.error ?? "The node refused the stream." });
          } else if (event.type === "snapshot") {
            received = true;
            failures = 0;
            const snapshot = event.snapshot;
            const sample = sampleOf(snapshot, disk);
            if (sample) history.push(sample);
            const found = snapshot.disks.find((d) => d.name === disk);
            setState((previous) => ({
              status: "live", message: "Live", failures: 0, latest: snapshot, samples: history.toArray(), missing: !found,
              order: stableOrder(previous.order, found?.consumers ?? [], Date.now()),
            }));
          }
        });
        if (current === controller) {
          patch({ status: "reconnecting", message: "Connection ended. Reconnecting…" });
          void checkSignedIn();
        }
      } catch (error) {
        if (current === controller) {
          patch({ status: "reconnecting", message: error instanceof PressureFormatError ? error.message + " Reconnecting…" : "Reconnecting…" });
        }
      } finally {
        clearTimeout(stall);
        if (current === controller) {
          current = undefined;
          if (reconnect && !stopped && !document.hidden) {
            failures = received ? 1 : failures + 1;
            retry = setTimeout(() => {
              retry = undefined;
              void connect();
            }, streamRetryDelay(RECONNECT_MS, failures));
          }
        }
      }
    };
    const disconnect = () => {
      clearTimeout(retry);
      retry = undefined;
      const controller = current;
      current = undefined;
      controller?.abort();
    };
    const visible = () => {
      if (document.hidden) disconnect();
      else void connect();
    };
    document.addEventListener("visibilitychange", visible);
    void connect();
    return () => {
      stopped = true;
      disconnect();
      document.removeEventListener("visibilitychange", visible);
    };
  }, [url, disk, history]);

  return state;
}
