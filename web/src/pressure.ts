// Disk pressure: the wire types of the hub routes (GET /api/v1/pressure/stream and /nodes), the NDJSON reader, the bounded
// history and the ranking of consumers. Pure: no browser or React imports, so the tests run it directly.
import { encodeState } from "./urlState";

export type ConsumerKind = "cgroup" | "process" | "path";
export type PressureSource = "ebpf" | "proc";

export interface PressureConsumer {
  kind: ConsumerKind;
  id: string;
  label: string;
  cgroup?: string;
  pod?: { namespace: string; name: string; container?: string; uid?: string };
  unit?: string;
  pid?: number;
  comm?: string;
  path?: string;
  rIops: number;
  wIops: number;
  rBps: number;
  wBps: number;
  eventsPerSec?: number;
  psiFull10?: number;
}

export interface PressureDisk {
  name: string;
  dev?: string;
  mounts: string[];
  util: number;
  rIops: number;
  wIops: number;
  rBps: number;
  wBps: number;
  queueDepth: number;
  rAwaitMs: number;
  wAwaitMs: number;
  inflight: number;
  consumers: PressureConsumer[];
}

export interface PressureWindowAverages { avg10: number; avg60: number; avg300: number }

export interface PressureSnapshot {
  type: "snapshot";
  node: string;
  at: number;
  intervalMs: number;
  source: PressureSource;
  psi: { some: PressureWindowAverages; full: PressureWindowAverages };
  disks: PressureDisk[];
}

export interface PressureNodeSummary {
  node: string;
  disks: { name: string; util: number; psiFull10: number }[];
  source?: PressureSource;
  at?: number;
}

export type PressureEvent =
  | { type: "ready" }
  | { type: "ping" }
  | { type: "offline" }
  | { type: "error"; error?: string }
  | { type: "snapshot"; snapshot: PressureSnapshot };

export class PressureFormatError extends Error {}

const MAX_LINE = 1024 * 1024;
const KINDS: readonly ConsumerKind[] = ["cgroup", "process", "path"];

const num = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);
const text = (value: unknown): string | undefined => (typeof value === "string" && value ? value : undefined);
const record = (value: unknown): Record<string, unknown> => (value && typeof value === "object" ? value as Record<string, unknown> : {});

function averages(value: unknown): PressureWindowAverages {
  const o = record(value);
  return { avg10: num(o.avg10), avg60: num(o.avg60), avg300: num(o.avg300) };
}

function consumer(value: unknown): PressureConsumer | null {
  const o = record(value);
  const kind = KINDS.find((k) => k === o.kind);
  const id = text(o.id);
  if (!kind || !id) return null;
  const pod = record(o.pod);
  const podNamespace = text(pod.namespace);
  const podName = text(pod.name);
  const out: PressureConsumer = {
    kind, id, label: text(o.label) ?? id,
    rIops: num(o.rIops), wIops: num(o.wIops), rBps: num(o.rBps), wBps: num(o.wBps),
  };
  if (text(o.cgroup)) out.cgroup = text(o.cgroup);
  if (podNamespace && podName) out.pod = { namespace: podNamespace, name: podName, ...(text(pod.container) ? { container: text(pod.container) } : {}), ...(text(pod.uid) ? { uid: text(pod.uid) } : {}) };
  if (text(o.unit)) out.unit = text(o.unit);
  if (typeof o.pid === "number" && Number.isFinite(o.pid)) out.pid = o.pid;
  if (text(o.comm)) out.comm = text(o.comm);
  if (text(o.path)) out.path = text(o.path);
  if (typeof o.eventsPerSec === "number" && Number.isFinite(o.eventsPerSec)) out.eventsPerSec = o.eventsPerSec;
  if (typeof o.psiFull10 === "number" && Number.isFinite(o.psiFull10)) out.psiFull10 = o.psiFull10;
  return out;
}

function disk(value: unknown): PressureDisk | null {
  const o = record(value);
  const name = text(o.name);
  if (!name) return null;
  return {
    name, ...(text(o.dev) ? { dev: text(o.dev) } : {}),
    mounts: Array.isArray(o.mounts) ? o.mounts.filter((m): m is string => typeof m === "string") : [],
    util: num(o.util), rIops: num(o.rIops), wIops: num(o.wIops), rBps: num(o.rBps), wBps: num(o.wBps),
    queueDepth: num(o.queueDepth), rAwaitMs: num(o.rAwaitMs), wAwaitMs: num(o.wAwaitMs), inflight: num(o.inflight),
    consumers: Array.isArray(o.consumers) ? o.consumers.flatMap((c) => consumer(c) ?? []) : [],
  };
}

/** One NDJSON line of the stream. Unknown event types return null so a newer agent does not break an older page. */
export function parsePressureLine(line: string): PressureEvent | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch (error) {
    throw new PressureFormatError("The pressure stream sent invalid JSON.", { cause: error });
  }
  const o = record(value);
  if (typeof o.type !== "string") throw new PressureFormatError("The pressure stream sent an event without a type.");
  if (o.type === "ready" || o.type === "ping" || o.type === "offline") return { type: o.type };
  if (o.type === "error") return { type: "error", ...(text(o.error) ? { error: text(o.error) } : {}) };
  if (o.type !== "snapshot") return null;
  const node = text(o.node);
  if (!node || typeof o.at !== "number" || !Number.isFinite(o.at) || !Array.isArray(o.disks)) throw new PressureFormatError("The pressure stream sent an incomplete snapshot.");
  const psi = record(o.psi);
  return {
    type: "snapshot",
    snapshot: {
      type: "snapshot", node, at: o.at,
      intervalMs: num(o.intervalMs) > 0 ? num(o.intervalMs) : 1000,
      source: o.source === "ebpf" ? "ebpf" : "proc",
      psi: { some: averages(psi.some), full: averages(psi.full) },
      disks: o.disks.flatMap((d) => disk(d) ?? []),
    },
  };
}

/** Reads an NDJSON body until it ends. Rejects on a malformed line and always releases the reader. */
export async function readPressure(body: ReadableStream<Uint8Array>, onEvent: (event: PressureEvent) => void): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        if (pending.trim()) throw new PressureFormatError("The pressure stream ended with an incomplete line.");
        return;
      }
      const lines = (pending + decoder.decode(value, { stream: true })).split("\n");
      pending = lines.pop() ?? "";
      if (pending.length > MAX_LINE) throw new PressureFormatError("The pressure stream sent an oversized line.");
      for (const line of lines) {
        if (!line.trim()) continue;
        if (line.length > MAX_LINE) throw new PressureFormatError("The pressure stream sent an oversized line.");
        const event = parsePressureLine(line);
        if (event) onEvent(event);
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** A bounded FIFO: the oldest item goes when the buffer is full. */
export class RingBuffer<T> {
  private items: T[];
  private start = 0;
  private size = 0;
  constructor(readonly capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new RangeError("The capacity must be a whole number of 1 or more.");
    this.items = new Array<T>(capacity);
  }
  get length(): number {
    return this.size;
  }
  push(item: T): void {
    if (this.size < this.capacity) {
      this.items[(this.start + this.size++) % this.capacity] = item;
    } else {
      this.items[this.start] = item;
      this.start = (this.start + 1) % this.capacity;
    }
  }
  /** Oldest first. A copy: later pushes do not change it. */
  toArray(): T[] {
    return Array.from({ length: this.size }, (_, i) => this.items[(this.start + i) % this.capacity] as T);
  }
  clear(): void {
    this.items = new Array<T>(this.capacity);
    this.start = 0;
    this.size = 0;
  }
}

/** One point of the live graphs for one disk. */
export interface PressureSample {
  at: number;
  util: number;
  rIops: number;
  wIops: number;
  rBps: number;
  wBps: number;
  queueDepth: number;
  rAwaitMs: number;
  wAwaitMs: number;
  psiSome10: number;
  psiFull10: number;
}

/** The longest window the page offers, in minutes. */
export const MAX_HISTORY_MIN = 15;
/** Samples kept: 15 minutes at the default interval of one second, with room for a faster interval. */
export const HISTORY_CAPACITY = MAX_HISTORY_MIN * 60 * 2;

export function sampleOf(snapshot: PressureSnapshot, diskName: string): PressureSample | null {
  const d = snapshot.disks.find((x) => x.name === diskName);
  if (!d) return null;
  return {
    at: snapshot.at, util: d.util, rIops: d.rIops, wIops: d.wIops, rBps: d.rBps, wBps: d.wBps, queueDepth: d.queueDepth,
    rAwaitMs: d.rAwaitMs, wAwaitMs: d.wAwaitMs, psiSome10: snapshot.psi.some.avg10, psiFull10: snapshot.psi.full.avg10,
  };
}

/** The samples inside the window that ends at the newest sample. */
export function windowSamples(samples: readonly PressureSample[], minutes: number): PressureSample[] {
  const last = samples.at(-1);
  if (!last) return [];
  const from = last.at - minutes * 60_000;
  return samples.filter((sample) => sample.at >= from);
}

/** Largest axis value: the next 1, 2, 2.5, 5 or 10 step above the data, never below `floor`. */
export function niceMax(value: number, floor = 1): number {
  const v = Math.max(value, floor);
  const exponent = Math.floor(Math.log10(v));
  const base = 10 ** exponent;
  for (const step of [1, 2, 2.5, 5, 10]) if (v <= step * base + 1e-9) return step * base;
  return 10 * base;
}

/** SVG path segments of a series. A gap longer than `gapMs` (a reconnect) breaks the line. */
export function linePaths(samples: readonly PressureSample[], pick: (sample: PressureSample) => number, from: number, to: number, yMax: number, size: { width: number; height: number }, gapMs: number): string[] {
  const span = Math.max(1, to - from);
  const paths: string[] = [];
  let current: string[] = [];
  let previous: number | null = null;
  const flush = () => {
    if (current.length === 1) current.push(current[0]!.replace(/^M/, "L"));
    if (current.length) paths.push(current.join(" "));
    current = [];
  };
  for (const sample of samples) {
    if (sample.at < from) continue;
    if (previous !== null && sample.at - previous > gapMs) flush();
    previous = sample.at;
    const x = ((sample.at - from) / span) * size.width;
    const y = size.height - Math.min(1, Math.max(0, pick(sample) / yMax)) * size.height;
    current.push(`${current.length ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`);
  }
  flush();
  return paths;
}

export const totalIops = (c: PressureConsumer): number => c.rIops + c.wIops;
export const totalBps = (c: PressureConsumer): number => c.rBps + c.wBps;

/** Busiest first: IOPS, then bytes per second, then the id, so equal rows never swap between updates. */
export function rankConsumers(consumers: readonly PressureConsumer[]): PressureConsumer[] {
  return [...consumers].sort((a, b) => totalIops(b) - totalIops(a) || totalBps(b) - totalBps(a) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** The table moves its rows at most this often. */
export const RERANK_MS = 2000;

export interface RowOrder {
  ids: string[];
  at: number;
}

/**
 * The order of the table rows for a new snapshot. Values update every snapshot, the order only every `RERANK_MS`:
 * in between, rows keep their place, rows that left drop out and new rows join at the end.
 */
export function stableOrder(previous: RowOrder | null, consumers: readonly PressureConsumer[], now: number): RowOrder {
  const ranked = rankConsumers(consumers).map((c) => c.id);
  if (!previous || now - previous.at >= RERANK_MS || now < previous.at) return { ids: ranked, at: now };
  const present = new Set(ranked);
  const kept = previous.ids.filter((id) => present.has(id));
  const known = new Set(kept);
  return { ids: [...kept, ...ranked.filter((id) => !known.has(id))], at: previous.at };
}

/** The consumers in the table order. Rows missing from the order (a filter or a new group) follow in rank order. */
export function inOrder(consumers: readonly PressureConsumer[], order: readonly string[]): PressureConsumer[] {
  const byId = new Map(consumers.map((c) => [c.id, c]));
  const listed = order.flatMap((id) => byId.get(id) ?? []);
  const seen = new Set(listed.map((c) => c.id));
  return [...listed, ...rankConsumers(consumers.filter((c) => !seen.has(c.id)))];
}

/** Who owns the consumer: `namespace/name` of a pod, a systemd unit, or nothing known. */
export function consumerOwner(c: PressureConsumer): string | null {
  if (c.pod) return `${c.pod.namespace}/${c.pod.name}`;
  if (c.unit) return c.unit;
  return null;
}

export function consumerProcess(c: PressureConsumer): string | null {
  if (c.comm && c.pid !== undefined) return `${c.comm} (${c.pid})`;
  return c.comm ?? (c.pid !== undefined ? String(c.pid) : null);
}

/** The deep link that opens a folder of a node in the file browser. */
export function folderHref(node: string, path: string): string {
  return "/" + encodeState({ tree: { kind: "leaf", id: "p1", node, path }, active: "p1" });
}

export const fmtIops = (n: number): string => (n >= 100 ? Math.round(n).toLocaleString("en-GB") : n.toLocaleString("en-GB", { maximumFractionDigits: 1 }));
export const fmtMBps = (bps: number): string => (bps / 1e6).toLocaleString("en-GB", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
export const fmtPercent = (ratio: number): string => `${Math.round(ratio * 100)} %`;
export const fmtPsi = (value: number): string => `${value.toLocaleString("en-GB", { minimumFractionDigits: 1, maximumFractionDigits: 1 })} %`;
export const fmtMs = (ms: number): string => `${ms.toLocaleString("en-GB", { maximumFractionDigits: ms < 10 ? 1 : 0 })} ms`;

/** The body of GET /api/v1/pressure/nodes: an array (or an object with `nodes`). Entries without a node name are dropped. */
export function parseNodeSummaries(body: unknown): PressureNodeSummary[] {
  const list = Array.isArray(body) ? body : record(body).nodes;
  if (!Array.isArray(list)) return [];
  return list.flatMap((entry): PressureNodeSummary[] => {
    const o = record(entry);
    const node = text(o.node);
    if (!node) return [];
    return [{
      node,
      disks: Array.isArray(o.disks) ? o.disks.flatMap((d) => {
        const x = record(d);
        const name = text(x.name);
        return name ? [{ name, util: num(x.util), psiFull10: num(x.psiFull10) }] : [];
      }) : [],
      ...(o.source === "ebpf" || o.source === "proc" ? { source: o.source } : {}),
      ...(typeof o.at === "number" && Number.isFinite(o.at) ? { at: o.at } : {}),
    }];
  });
}
