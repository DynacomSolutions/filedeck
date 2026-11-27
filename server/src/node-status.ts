import type { Hono } from "hono";
import type { Config } from "./config.ts";
import type { UserClaim } from "./auth/identity.ts";
import type { HubNodeStatus, NodeStatus } from "./node-status-types.ts";
import { EventBus } from "./events/bus.ts";
import type { NewEvent } from "./events/types.ts";
import { FanWatch } from "./fanwatch.ts";
import { MacWatch } from "./macwatch.ts";
import { networkKind, parseMounts, readMountTable } from "./mounts.ts";
import type { SizeStore } from "./size-store.ts";

export const NODE_STATUS_PATH = "/api/node-status";
const SNAPSHOT_MS = 10_000;

/** Keep the coverage report that the native watcher already sends. */
export class StatusEventBus extends EventBus {
  private unwatched = new Set<string>();

  unwatchedPaths(): string[] {
    return [...this.unwatched].sort();
  }

  override publish(event: NewEvent): void {
    if (event.kind === "ready") this.unwatched = new Set(event.unwatched);
    if (event.scope === "filesystem" && event.path && event.kind === "reset" && !event.window?.to) {
      this.unwatched.add(event.path);
    }
    super.publish(event);
  }
}

function watcherSnapshot(fan: FanWatch | MacWatch, bus: StatusEventBus): Omit<NodeStatus["watcher"], "coverage"> {
  const status = fan.status();
  const { running, ready, mounts, watched, unwatched, excluded, backlog, lostEvents } = status;
  return {
    kind: fan instanceof MacWatch ? "native" : "fanotify",
    running, ready, mounts, watched, unwatched, excluded, backlog, lostEvents,
    unresolved: fan instanceof FanWatch ? fan.status().helper.unresolved ?? 0 : null,
    unwatchedPaths: running ? bus.unwatchedPaths() : [],
  };
}

function journalSnapshot(bus: StatusEventBus) {
  const { head, oldest, epoch, oldestAgeMs, bytes } = bus.journal;
  return {
    serving: bus.serving,
    epoch: bus.serving ? epoch : null,
    oldestCursor: bus.serving && oldest <= head ? bus.cursorOf(oldest) : null,
    newestCursor: bus.serving && head > 0 ? bus.cursorOf(head) : null,
    oldestAgeMs, bytes,
    subscribers: bus.subscribers(),
    lagMs: bus.lagMs,
    overflows: bus.overflows,
    dropped: bus.droppedLagged,
  };
}

async function readStatus(cfg: Config, sizes: SizeStore, fan: FanWatch | MacWatch, bus: StatusEventBus): Promise<NodeStatus> {
  const table = await readMountTable(cfg.root, cfg.procMounts);
  const mounts = parseMounts(table);
  const nativeCoverage = fan instanceof MacWatch ? fan.mountCoverage() : undefined;
  const paths = [...new Set(["/", ...mounts.map((m) => m.mountpoint), ...(nativeCoverage ?? []).map((m) => m.path)])].sort();
  const roots: NodeStatus["roots"] = [];
  // Read indexed rows in sequence. This request never walks a folder or starts a job.
  for (const path of paths) {
    const row = await sizes.treeTop(path);
    const complete = !!row && !row.partial && row.scanned_at > 0 && row.tot.errors === 0;
    roots.push({
      path,
      scannedAt: row && !row.partial && row.scanned_at > 0 ? row.scanned_at : null,
      fullScan: complete,
      state: !row ? sizes.health().available ? "missing" : "unknown"
        : !complete ? "partial" : await sizes.vouches(path) ? "current" : "stale",
    } as const);
  }

  const watcher = watcherSnapshot(fan, bus);
  const unwatched = new Set(watcher.unwatchedPaths);
  const uncoveredDevices = new Set(mounts.filter((m) => unwatched.has(m.mountpoint)).map((m) => `${m.device}\0${m.fstype}`));
  const coverage = nativeCoverage ?? mounts.map((m) => {
    const failedMark = watcher.kind === "fanotify" && uncoveredDevices.has(`${m.device}\0${m.fstype}`);
    return {
      path: m.mountpoint,
      state: !watcher.running || unwatched.has(m.mountpoint) || networkKind(m.fstype) || failedMark
        ? "unwatched" : fan.covers(m.mountpoint) ? "watched" : "unknown",
    } as const;
  });

  return {
    sampledAt: Date.now(),
    sizeStore: sizes.health(),
    roots,
    watcher: { ...watcher, coverage },
    journal: journalSnapshot(bus),
  };
}

export function registerNodeStatus(app: Hono, cfg: Config, sizes: SizeStore, fan: FanWatch | MacWatch, bus: StatusEventBus) {
  let snapshot: NodeStatus | undefined;
  let pending: Promise<NodeStatus> | undefined;
  app.get(NODE_STATUS_PATH, async (c) => {
    if (cfg.auth && (c.get("user") as UserClaim | undefined)?.admin !== true) {
      return c.json({ error: "administrators only" }, 403);
    }
    if (!snapshot || Date.now() - snapshot.sampledAt >= SNAPSHOT_MS) {
      pending ??= readStatus(cfg, sizes, fan, bus).finally(() => { pending = undefined; });
      snapshot = await pending;
    }
    return c.json(snapshot, 200, { "cache-control": "no-store" });
  });
}

export async function readHubNodeStatus(nodes: string[], call: (node: string, path: string, init?: RequestInit) => Promise<Response>, signal: AbortSignal): Promise<HubNodeStatus[]> {
  return Promise.all(nodes.map(async (node): Promise<HubNodeStatus> => {
    try {
      const response = await call(node, NODE_STATUS_PATH, { signal: AbortSignal.any([signal, AbortSignal.timeout(4000)]) });
      if (response.status === 404) {
        await response.body?.cancel();
        return { node, state: "unsupported" };
      }
      if (response.ok) return { node, state: "available", status: await response.json() as NodeStatus };
      await response.body?.cancel();
    } catch {
      // Other nodes can still answer when one node is down.
    }
    return { node, state: "unavailable" };
  }));
}
