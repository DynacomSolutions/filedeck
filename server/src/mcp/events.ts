import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { HubCaller } from "./hub-call.ts";
import type { Scope } from "./grants.ts";
import type { McpMetrics } from "./metrics.ts";

/**
 * The internal event source interface of the MCP server. A module (the node and job watch is the first one) adds tools and resources to
 * every session, says which of its resources need a live watch while a client is subscribed, and pushes events through the sink. The core
 * (server.ts) never knows what a module watches, so a new module (disk verification runs, stage changes, disk alerts) is one more entry
 * in the module list and needs no change in the core.
 */

/** One thing that happened: a short machine-readable summary, with a `kind` such as `scan.finished`. */
export interface McpEvent {
  kind: string;
  [field: string]: unknown;
}

/**
 * A change of one resource. The notification the client gets holds the `uri` and `_meta.filedeck = {eventId, revision, uri}`. `events` say what
 * happened since the last update; they stay in the hub (logs, tests). The client reads the resource to see the new state.
 */
export interface McpUpdate {
  uri: string;
  /** the resource's revision after this change (see revisions.ts); the same number a read of it gives, unless it changed again */
  revision: number;
  events: McpEvent[];
  /** only sessions with this audience get it (the account the data was read as); every session when left out */
  audience?: string;
}

/** What one client session is: who it is, what it may do and what it reads as. A module gets it in `register`, `follow` and `followList`. */
export interface McpSession {
  /** the id of the grant (the metrics label `grant`) */
  grant: string;
  /** the account the session reads as when sign-in is on, else the empty string. It is also the audience of notifications. */
  audience: string;
  scope: Scope;
  call: HubCaller;
  metrics: McpMetrics;
}

/** Where a module sends its events. Sessions that subscribed to the URI get `notifications/resources/updated`. */
export interface McpEventSink {
  /** The state behind `update.uri` changed. */
  updated(update: McpUpdate): void;
  /** The set of listed resources changed. Sessions that listed resources get `notifications/resources/list_changed`. */
  listChanged(change: { revision: number; audience?: string }): void;
}

/** Ends the interest in a watch. Calling it twice is safe. */
export type McpRelease = () => void;

export interface McpModule {
  readonly name: string;
  /** Adds the module's tools and resources to the server of one session. Add only what `session.scope` allows. */
  register(server: McpServer, session: McpSession): void;
  /**
   * A client subscribed to `uri`. Return null when the URI is not this module's. Otherwise start what must run to follow it, wait until its
   * state is known (so a change after the answer is never missed), and return how to end the interest. Throw to refuse the subscription.
   */
  follow(uri: string, session: McpSession): Promise<McpRelease | null>;
  /** A session listed resources: it will get `list_changed`. Return how to end the interest. */
  followList(session: McpSession): McpRelease;
  /** Called once before the first session; the module keeps the sink. */
  start(sink: McpEventSink): void;
  /** Ends every watch of the module. */
  stop(): Promise<void>;
}
