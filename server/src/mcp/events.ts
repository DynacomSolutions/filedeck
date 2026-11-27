import { createHash } from "node:crypto";
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

/** Version of the published contract (docs/mcp.md). It rises when a field or a URI changes in a way that can break a client. */
export const CONTRACT = 2;

/** A virtual resource for the revision of `resources/list` (it has no body). Its `list_changed` notices use it as their `uri`. */
export const LIST_URI = "filedeck://resources";

/** One thing that happened: a short machine-readable summary, with a `kind` such as `scan.finished`. */
export interface McpEvent {
  kind: string;
  [field: string]: unknown;
}

/**
 * The id of one notice: the same for the same audience, URI and revision, in every process and after every restart, and different for any other
 * combination. A replay of a logical event has the id of the first one, so a client drops it. The audience is part of it because each audience has its
 * own revisions. The form is `<12 hexadecimal characters>.<revision>`: a client keeps it as an opaque string.
 */
export function eventIdOf(audience: string | undefined, uri: string, revision: number): string {
  return `${createHash("sha256").update(JSON.stringify([audience ?? "", uri])).digest("hex").slice(0, 12)}.${revision}`;
}

/** The id that ties the notices of one source change together: the same for the same set of `<uri>@<revision>` parts, whatever their order. */
export function changeIdOf(parts: readonly string[]): string {
  return createHash("sha256").update(JSON.stringify([...parts].sort())).digest("hex").slice(0, 12);
}

/**
 * A change of one resource. The notification the client gets holds the `uri` and `_meta.eventId` (the same value is in `_meta.filedeck.eventId`, with
 * `revision`, `uri`, `changeId` and the stream fields). `events` say what happened since the last update; they stay in the hub (logs, tests). The
 * client reads the resource to see the new state.
 */
export interface McpUpdate {
  uri: string;
  /** the resource's revision after this change (see revisions.ts); the same number a read of it gives, unless it changed again */
  revision: number;
  events: McpEvent[];
  /** only sessions with this audience get it (the account the data was read as); every session when left out */
  audience?: string;
  /** shared by every notice (one for each resource) that one change of a source causes; see `changeIdOf` */
  changeId?: string;
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
  /** The set of listed resources changed. Every session, from `initialize`, gets `notifications/resources/list_changed` when it may see the change. */
  listChanged(change: { revision: number; audience?: string; changeId?: string; allows?: (session: McpSession) => boolean }): void;
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
  /** A session was opened: it will get `list_changed`, so the watches that the list of resources needs must run. Return how to end the interest. */
  followList(session: McpSession): McpRelease;
  /** Called once before the first session; the module keeps the sink. */
  start(sink: McpEventSink): void;
  /** Ends every watch of the module. */
  stop(): Promise<void>;
}
