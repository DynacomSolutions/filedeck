export interface NodeStatus {
  sampledAt: number;
  sizeStore: { available: boolean; damaged: boolean };
  roots: { path: string; scannedAt: number | null; fullScan: boolean; state: "missing" | "partial" | "current" | "stale" | "unknown" }[];
  watcher: {
    kind: "native" | "fanotify";
    running: boolean;
    ready: boolean;
    mounts: number;
    watched: number;
    covered: number;
    unsupported: number;
    aliases: number;
    unwatched: number;
    excluded: number;
    backlog: number;
    lostEvents: number;
    unresolved: number | null;
    unwatchedPaths: string[];
    coverage: { path: string; state: "watched" | "unwatched" | "unknown" }[];
  };
  journal: {
    serving: boolean;
    epoch: string | null;
    oldestCursor: string | null;
    newestCursor: string | null;
    oldestAgeMs: number;
    bytes: number;
    subscribers: { socket: number; http: number; internal: number };
    lagMs: number;
    overflows: number;
    dropped: number;
  };
}

export type HubNodeStatus =
  | { node: string; state: "available"; status: NodeStatus }
  | { node: string; state: "unsupported" }
  | { node: string; state: "unavailable"; reason: string };
