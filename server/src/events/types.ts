/**
 * The change events of one agent: what the native watcher sees, in the form the bus, the journal and every transport share.
 * An event is encoded to one JSON line once (see `encodeEvent`); every subscriber gets the same bytes.
 */

export const KINDS = ["create", "delete", "modify", "close_write", "attrib", "move", "overflow", "reset", "ready", "pressure"] as const;
export type EventKind = (typeof KINDS)[number];

/** Kinds that say something about the stream and not about one entry: every subscriber gets them, whatever its filter says. */
export const CONTROL_KINDS: ReadonlySet<string> = new Set(["overflow", "reset", "ready"]);

export interface EventWindow {
  /** ms since the epoch: events from this time on may be missing */
  from: number;
  /** ms since the epoch: the watcher is seeing events again from here (absent while it is still away) */
  to?: number;
}

/** What the publisher gives the bus. The bus adds the cursor. */
export interface NewEvent {
  /** ms since the epoch (default: now) */
  time?: number;
  kind: EventKind;
  /** the entry is a folder */
  dir?: boolean;
  /** agent virtual path of the entry (a move: where it is now); absent on a control event for the whole node */
  path?: string;
  /** a move: where the entry was */
  from?: string;
  /** a control event: `node` (every filesystem) or `filesystem` (the one that holds `path`) */
  scope?: "node" | "filesystem";
  /** a control event: the time window in which events may have been missed */
  window?: EventWindow;
  /** a control event: why */
  reason?: string;
  /** `ready`: mounts that no event covers (virtual paths) */
  unwatched?: string[];
  /** `pressure`: the level of the filesystem that is mounted at `path`, its free and total bytes, and the bytes lost in the last hour and six hours */
  level?: "ok" | "reserve" | "critical";
  availBytes?: number;
  sizeBytes?: number;
  loss1h?: number;
  loss6h?: number;
}

export interface ChangeEvent extends NewEvent {
  cursor: string;
  time: number;
  node: string;
  dir: boolean;
  labels?: Record<string, string>;
  fromLabels?: Record<string, string>;
}

/** The fields a filter looks at. */
export interface Matchable {
  kind: EventKind;
  dir: boolean;
  path?: string;
  from?: string;
  labels?: Record<string, string>;
  /** a move: the labels of the place the entry came from (absent when they are the labels of `path`) */
  fromLabels?: Record<string, string>;
}

/** An event as the bus holds it: the fields a filter needs and the finished line (JSON and a line feed). */
export interface Encoded extends Matchable {
  seq: number;
  time: number;
  line: Buffer;
}

/**
 * The line sent when a subscriber's own buffer filled: the stream ends, and the client reconnects with `since` = `cursor`
 * (the last event it was sent, or the `since` it asked for) and reads what it missed from the journal.
 */
export function laggedLine(node: string, cursor: string | undefined): Buffer {
  return Buffer.from(JSON.stringify({ kind: "lagged", node, ...(cursor ? { cursor } : {}), reason: "the subscriber was too slow", time: Date.now() }) + "\n");
}

export function pingLine(node: string): Buffer {
  return Buffer.from(JSON.stringify({ kind: "ping", node, time: Date.now() }) + "\n");
}

export function encodeEvent(ev: ChangeEvent): Buffer {
  // fixed field order, the cursor first: the journal finds a line's cursor without parsing it (see journal.ts)
  const o: Record<string, unknown> = { cursor: ev.cursor, time: ev.time, node: ev.node, kind: ev.kind, dir: ev.dir };
  if (ev.path !== undefined) o.path = ev.path;
  if (ev.from !== undefined) o.from = ev.from;
  if (ev.labels) o.labels = ev.labels;
  if (ev.fromLabels) o.fromLabels = ev.fromLabels;
  if (ev.scope) o.scope = ev.scope;
  if (ev.window) o.window = ev.window;
  if (ev.reason) o.reason = ev.reason;
  if (ev.unwatched) o.unwatched = ev.unwatched;
  if (ev.kind === "pressure") Object.assign(o, { level: ev.level, availBytes: ev.availBytes, sizeBytes: ev.sizeBytes, loss1h: ev.loss1h, loss6h: ev.loss6h });
  return Buffer.from(JSON.stringify(o) + "\n");
}
