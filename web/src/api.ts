import type { DiffMode, Loc, SearchForm } from "./urlState";
export interface Entry {
  name: string;
  path: string;
  type: "file" | "dir" | "symlink" | "other";
  size: number;
  mtime: number;
  mode: number;
  linkDir?: boolean;
}
export interface Mount {
  device: string;
  mountpoint: string;
  fstype: string;
  total: number;
  used: number;
  free: number;
  /** NFS, SMB/CIFS, other network filesystems and FUSE mounts */
  network?: boolean;
  /** e.g. "NFS", "SMB/CIFS", "SSHFS", "FUSE" */
  netKind?: string;
  /** network mount that did not answer in time */
  unreachable?: boolean;
}
export interface NodeInfo {
  name: string;
  online: boolean;
  /** "source" = network server configured on the hub (SFTP, ...), served like a node; absent = cluster node */
  kind?: "node" | "source";
  /** source protocol, e.g. "sftp" */
  type?: string;
  host?: string;
}

const enc = encodeURIComponent;
export const nodeBase = (node: string) => `/api/nodes/${enc(node)}`;
export const fileUrl = (node: string, path: string, kind: "read" | "download" = "read") =>
  `${nodeBase(node)}/api/fs/${kind}?path=${enc(path)}`;

async function j<T>(r: Response): Promise<T> {
  if (!r.ok) {
    let msg = r.statusText;
    try {
      msg = ((await r.json()) as { error?: string }).error ?? msg;
    } catch {
      /* not json */
    }
    throw new Error(msg);
  }
  return (await r.json()) as T;
}

const post = <T,>(node: string, op: string, body: unknown) =>
  fetch(`${nodeBase(node)}/api/fs/${op}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }).then((r) => j<T>(r));

export class ConflictError extends Error {
  constructor(
    message: string,
    public etag: string,
  ) {
    super(message);
  }
}

export interface TextFile {
  path: string;
  content: string;
  size: number;
  mtime: number;
  etag: string;
}
export interface WriteResult {
  path: string;
  size: number;
  mtime: number;
  etag: string;
}
export type JobState = "queued" | "running" | "done" | "failed" | "canceled";
export interface JobView {
  id: string;
  kind: string;
  title: string;
  state: JobState;
  progress: { bytes: number; totalBytes: number; entries: number; totalEntries: number; current: string };
  error?: string;
  result?: { path?: string; size?: number; files?: number; skipped?: { symlinks: number; hardlinks: number; special: number } };
  createdAt: number;
}
export interface ArchiveEntry {
  name: string;
  type: "file" | "dir" | "symlink" | "other";
  size: number;
  date: string;
  link?: string;
}
export type ArchiveFormat = "zip" | "tar.gz" | "tar.zst" | "7z";
export const ARCHIVE_EXT = [".tar.gz", ".tar.bz2", ".tar.xz", ".tar.zst", ".tar.lz4", ".tgz", ".tbz2", ".txz", ".tzst", ".tar", ".zip", ".7z", ".jar", ".war", ".whl", ".rar"];
export const isArchive = (name: string) => ARCHIVE_EXT.some((e) => name.toLowerCase().endsWith(e));
/** Streamed zip of several direct children of `dir` (files and folders). */
export const zipUrl = (node: string, dir: string, names: string[]) =>
  `${nodeBase(node)}/api/fs/zip?dir=${enc(dir)}${names.map((n) => `&name=${enc(n)}`).join("")}`;

const postJob = (node: string, kind: string, body: unknown) =>
  fetch(`${nodeBase(node)}/api/jobs/${kind}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
    .then((r) => j<JobView>(r))
    .then((v) => {
      jobStarted(node);
      return v;
    });

const jobListeners = new Set<(node: string) => void>();
/** The jobs tray subscribes to learn that a job was just started on a node. */
export const onJobStarted = (fn: (node: string) => void) => {
  jobListeners.add(fn);
  return () => void jobListeners.delete(fn);
};
const jobStarted = (node: string) => jobListeners.forEach((f) => f(node));
/** Expand the jobs drawer for work that is not a server job (browser uploads). */
export const announceJob = (node: string) => jobStarted(node);

export type ConflictPolicy = "ask" | "skip" | "overwrite" | "rename";
export type OpState = "queued" | "running" | "paused" | "waiting" | "done" | "failed" | "canceled";
export interface OpItem {
  label: string;
  state: "pending" | "running" | "done" | "skipped" | "failed";
  bytes: number;
  size: number;
  note?: string;
  error?: string;
}
/** A hub-side bulk job (copy, move, trash, delete, folder sync). */
export interface OpJob {
  id: string;
  kind: "ops";
  op: "copy" | "move" | "trash" | "delete" | "sync";
  title: string;
  state: OpState;
  conflictPolicy?: ConflictPolicy;
  progress: { bytes: number; totalBytes: number; entries: number; totalEntries: number; current: string };
  speed: number;
  counts: { total: number; done: number; skipped: number; failed: number };
  conflict?: { target: string; name: string; srcType: string; dstType: string; srcSize: number; dstSize: number };
  items?: OpItem[];
  itemsTruncated?: boolean;
  error?: string;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
}
export type OpLoc = { node: string; path: string };
export type SyncStepSpec =
  | { kind: "mkdir"; node: string; path: string }
  | { kind: "trash"; node: string; path: string }
  | { kind: "copy"; src: OpLoc; dst: { node: string; dir: string }; bytes?: number };
export type OpSpec =
  | { op: "copy" | "move"; items: OpLoc[]; dst: { node: string; dir: string }; conflict: ConflictPolicy; preserveTimes?: boolean }
  | { op: "trash" | "delete"; items: OpLoc[] }
  | { op: "sync"; steps: SyncStepSpec[]; title?: string };
export const opLive = (j: { state: OpState }) => j.state === "queued" || j.state === "running" || j.state === "paused" || j.state === "waiting";

const opFinishListeners = new Set<(j?: OpJob) => void>();
/** Panels refresh when a hub job ends (also fired for jobs started in another tab). */
export const onOpFinished = (fn: (j?: OpJob) => void) => {
  opFinishListeners.add(fn);
  return () => void opFinishListeners.delete(fn);
};
/** Jobs this tab started: if one finishes between two polls the panels still refresh. */
export const startedOps = new Set<string>();
export const emitOpFinished = (j?: OpJob) => opFinishListeners.forEach((f) => f(j));
const opReq = (path: string, method = "GET", body?: unknown) =>
  fetch(`/api/ops/jobs${path}`, { method, ...(body !== undefined ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}) });

/** Options for sync copies: replace what is there, keep modification times. */
export interface SyncOpts {
  overwrite?: boolean;
  preserveTimes?: boolean;
}
export type { DiffMode, Loc };
export interface DiffApiOptions {
  mode: DiffMode;
  toleranceMs: number;
  ignoreCase: boolean;
  ignoreHidden: boolean;
  include: string;
  exclude: string;
  depth: number;
  maxEntries: number;
}
export type DiffStatus = "identical" | "different" | "left-only" | "right-only" | "error";
export interface DiffSide {
  t: "file" | "dir" | "symlink" | "other";
  s: number;
  m: number;
  l?: string;
}
export interface DiffRow {
  p: string;
  rp?: string;
  status: DiffStatus;
  l?: DiffSide;
  r?: DiffSide;
  newer?: "left" | "right";
  why?: string;
}
export interface DiffCounts {
  identical: number;
  different: number;
  leftOnly: number;
  rightOnly: number;
  error: number;
}
export interface DiffResult {
  left: Loc;
  right: Loc;
  options: DiffApiOptions & { include: string[]; exclude: string[] };
  rows: DiffRow[];
  files: DiffCounts;
  dirs: DiffCounts;
  hashedFiles: number;
  hashedBytes: number;
  warnings: string[];
  durationMs: number;
}

export interface TrashItem {
  id: string;
  name: string;
  originalPath: string;
  deletedAt: number;
  type: Entry["type"];
  size: number;
  orphan?: boolean;
}
export interface TrashVolume {
  volume: string;
  items: TrashItem[];
  truncated: boolean;
}
export interface TrashResult {
  id: string;
  ok: boolean;
  path?: string;
  error?: string;
  conflict?: boolean;
}
export type TrashConflict = "fail" | "rename" | "replace";
const trashPost = <T,>(node: string, op: string, body: unknown) =>
  fetch(`${nodeBase(node)}/api/trash/${op}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => j<T>(r));

export interface Props {
  name: string;
  path: string;
  type: Entry["type"];
  size: number;
  diskBytes: number;
  mtime: number;
  atime: number;
  ctime: number;
  mode: number;
  uid: number;
  gid: number;
  owner: string | null;
  group: string | null;
  nlink: number;
  ino: number;
  linkTarget?: string;
  linkDir?: boolean;
  volume?: { mountpoint: string; device: string; fstype: string; network: boolean; netKind?: string; total: number; free: number };
}
export interface SizeResult {
  files: number;
  dirs: number;
  symlinks: number;
  other: number;
  bytes: number;
  diskBytes: number;
  truncated: boolean;
  mountsSkipped: number;
  errors: number;
}
export interface PermsBody {
  path: string;
  mode?: number;
  owner?: string | number;
  group?: string | number;
  recursive?: boolean;
  scope?: "all" | "files" | "dirs";
}
export interface PermsResult {
  changed: number;
  skipped: number;
  errors: number;
}

export const api = {
  startOp: (spec: OpSpec) =>
    opReq("", "POST", spec)
      .then((r) => j<OpJob>(r))
      .then((v) => {
        startedOps.add(v.id);
        jobStarted("hub");
        return v;
      }),
  opJobs: () => opReq("").then((r) => j<{ jobs: OpJob[] }>(r)),
  opJob: (id: string) => opReq(`/${id}`).then((r) => j<OpJob>(r)),
  opAction: (id: string, action: "pause" | "resume" | "cancel") => opReq(`/${id}/${action}`, "POST").then((r) => j<OpJob>(r)),
  opResolve: (id: string, action: "skip" | "overwrite" | "rename", all: boolean) => opReq(`/${id}/resolve`, "POST", { action, all }).then((r) => j<OpJob>(r)),
  dismissOp: (id: string) => opReq(`/${id}`, "DELETE").then((r) => j<unknown>(r)),
  props: (node: string, path: string) => fetch(`${nodeBase(node)}/api/fs/props?path=${enc(path)}`).then((r) => j<Props>(r)),
  startSize: (node: string, path: string) => postJob(node, "size", { path }),
  job: (node: string, id: string) => fetch(`${nodeBase(node)}/api/jobs/${id}`).then((r) => j<JobView>(r)),
  /** One entry changes at once (result); a recursive change starts a job (JobView with `id`). */
  perms: (node: string, b: PermsBody) =>
    fetch(`${nodeBase(node)}/api/fs/perms`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) })
      .then((r) => j<PermsResult | JobView>(r))
      .then((v) => {
        if ("id" in v) jobStarted(node);
        return v;
      }),
  trashList: (node: string) => fetch(`${nodeBase(node)}/api/trash/list`).then((r) => j<{ volumes: TrashVolume[] }>(r)),
  trashRestore: (node: string, volume: string, ids: string[], o: { conflict?: TrashConflict; toDir?: string } = {}) =>
    trashPost<{ results: TrashResult[] }>(node, "restore", { volume, ids, ...o }),
  trashDelete: (node: string, volume: string, ids: string[]) => trashPost<{ results: TrashResult[] }>(node, "delete", { volume, ids }),
  trashEmpty: (node: string, volume: string, olderThanDays?: number) => trashPost<{ removed: number; failed: number }>(node, "empty", { volume, ...(olderThanDays !== undefined ? { olderThanDays } : {}) }),
  readText: (node: string, path: string) => fetch(`${nodeBase(node)}/api/fs/text?path=${enc(path)}`).then((r) => j<TextFile>(r)),
  /** Save with optimistic concurrency. `etag` null creates a new file. 409 -> ConflictError with the current etag. */
  writeText: async (node: string, path: string, content: string, etag: string | null): Promise<WriteResult> => {
    const r = await fetch(`${nodeBase(node)}/api/fs/write?path=${enc(path)}${etag === null ? "&create=1" : ""}`, {
      method: "PUT",
      headers: etag === null ? {} : { "if-match": etag },
      body: content,
    });
    if (r.status === 409) {
      const b = (await r.json().catch(() => ({}))) as { error?: string; etag?: string };
      throw new ConflictError(b.error ?? "conflict", b.etag ?? "");
    }
    return j<WriteResult>(r);
  },
  /** Cluster nodes first, then the network sources (marked kind: "source"). */
  nodes: () =>
    fetch("/api/nodes")
      .then((r) => j<{ nodes: NodeInfo[]; sources?: NodeInfo[] }>(r))
      .then((r) => ({ nodes: [...r.nodes.map((n) => ({ ...n, kind: "node" as const })), ...(r.sources ?? []).map((s) => ({ ...s, kind: "source" as const }))] })),
  mounts: (node: string) => fetch(`${nodeBase(node)}/api/mounts`).then((r) => j<{ mounts: Mount[] }>(r)),
  list: (node: string, path: string, hidden: boolean) =>
    fetch(`${nodeBase(node)}/api/fs/list?path=${enc(path)}${hidden ? "&hidden=1" : ""}`).then((r) =>
      j<{ path: string; entries: Entry[]; truncated: boolean }>(r),
    ),
  mkdir: (node: string, path: string) => post(node, "mkdir", { path }),
  rename: (node: string, from: string, to: string) => post(node, "rename", { from, to }),
  move: (node: string, from: string[], toDir: string) => post(node, "move", { from, toDir }),
  copy: (node: string, from: string[], toDir: string, o: SyncOpts = {}) => post(node, "copy", { from, toDir, ...o }),
  trash: (node: string, paths: string[]) => post(node, "trash", { paths }),
  remove: (node: string, paths: string[]) => post(node, "delete", { paths }),
  startCompress: (node: string, dir: string, names: string[], format: ArchiveFormat, name: string) =>
    postJob(node, "compress", { dir, names, format, name }),
  startExtract: (node: string, path: string, destDir: string, subfolder: boolean) =>
    postJob(node, "extract", { path, destDir, subfolder }),
  jobs: (node: string) => fetch(`${nodeBase(node)}/api/jobs`).then((r) => j<{ jobs: JobView[] }>(r)),
  cancelJob: (node: string, id: string) => fetch(`${nodeBase(node)}/api/jobs/${id}/cancel`, { method: "POST" }).then((r) => j<JobView>(r)),
  dismissJob: (node: string, id: string) => fetch(`${nodeBase(node)}/api/jobs/${id}`, { method: "DELETE" }).then((r) => j<unknown>(r)),
  archiveList: (node: string, path: string) =>
    fetch(`${nodeBase(node)}/api/archive/list?path=${enc(path)}`).then((r) =>
      j<{ entries: ArchiveEntry[]; truncated: boolean; bytes: number }>(r),
    ),
  transfer: (src: { node: string; path: string }, dst: { node: string; dir: string }, op: "copy" | "move", o: SyncOpts = {}) =>
    fetch("/api/transfer", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ src, dst, op, ...o }),
    }).then((r) => j<unknown>(r)),
  startDiff: (left: Loc, right: Loc, options: DiffApiOptions) =>
    fetch("/api/diff/jobs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ left, right, options }),
    }).then((r) => j<JobView>(r)),
  diffJob: (id: string) => fetch(`/api/diff/jobs/${id}`).then((r) => j<JobView>(r)),
  diffResult: (id: string) => fetch(`/api/diff/jobs/${id}/result`).then((r) => j<DiffResult>(r)),
  cancelDiff: (id: string) => fetch(`/api/diff/jobs/${id}/cancel`, { method: "POST" }).then((r) => j<JobView>(r)),
  dismissDiff: (id: string) => fetch(`/api/diff/jobs/${id}`, { method: "DELETE" }).then((r) => j<unknown>(r)),
  upload: (node: string, dir: string, file: File, onProgress?: (f: number) => void) =>
    new Promise<void>((resolve, reject) => {
      const x = new XMLHttpRequest();
      x.open("PUT", `${nodeBase(node)}/api/fs/upload?dir=${enc(dir)}&name=${enc(file.name)}`);
      x.upload.onprogress = (e) => e.lengthComputable && onProgress?.(e.loaded / e.total);
      x.onload = () => {
        if (x.status < 300) return resolve();
        let msg = x.statusText;
        try {
          msg = (JSON.parse(x.responseText) as { error?: string }).error ?? msg;
        } catch {
          /* ignore */
        }
        reject(new Error(msg));
      };
      x.onerror = () => reject(new Error("network error"));
      x.send(file);
    }),
};

export const join = (dir: string, name: string) => (dir === "/" ? "" : dir) + "/" + name;
export const parent = (p: string) => p.replace(/\/[^/]+\/?$/, "") || "/";

export function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`;
  const u = ["KiB", "MiB", "GiB", "TiB", "PiB"];
  let i = -1;
  do {
    n /= 1024;
    i++;
  } while (n >= 1024 && i < u.length - 1);
  return `${n.toFixed(n < 10 ? 1 : 0)} ${u[i]}`;
}
export const fmtDate = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace("T", " ");

export const MAX_EDIT = 5 * 1024 * 1024;
const NOT_TEXT = new Set(["png", "jpg", "jpeg", "gif", "webp", "avif", "bmp", "ico", "mp4", "m4v", "webm", "mov", "mkv", "mp3", "m4a", "ogg", "wav", "flac", "opus", "pdf", "zip", "gz", "tgz", "7z", "xz", "bz2", "tar", "iso", "bin", "exe", "so"]);
/** Cheap client-side check; the agent still refuses binary or oversize content. */
export const canEdit = (e: Entry) =>
  (e.type === "file" || (e.type === "symlink" && !e.linkDir)) && e.size <= MAX_EDIT && !NOT_TEXT.has(e.name.slice(e.name.lastIndexOf(".") + 1).toLowerCase());

export const stat = (node: string, path: string) => fetch(`${nodeBase(node)}/api/fs/stat?path=${enc(path)}`).then((r) => j<Entry>(r));
/** Create an empty file (fails with 409 when it exists). */
export const createFile = (node: string, path: string) => api.writeText(node, path, "", null);
const MODE_BITS = "rwxrwxrwx";
/** `-rw-r--r--` style string for a st_mode. */
export function fmtMode(mode: number, type: Entry["type"]): string {
  let s = type === "dir" ? "d" : type === "symlink" ? "l" : "-";
  for (let i = 0; i < 9; i++) s += mode & (1 << (8 - i)) ? MODE_BITS[i] : "-";
  return s;
}

export interface SearchHit {
  /** path below the searched folder */
  p: string;
  t: Entry["type"];
  s: number;
  m: number;
  /** content hits: first matching line, its text, and the number of matching lines */
  l?: number;
  x?: string;
  n?: number;
}
export interface SearchDone {
  scanned: number;
  grepped: number;
  skipped: number;
  capped: boolean;
  truncated: boolean;
  depthLimited: boolean;
  errors: number;
}

/** Streams a search (NDJSON from the agent) and reports each batch; abort the signal to cancel the walk on the node. */
export async function searchStream(node: string, path: string, f: SearchForm, hidden: boolean, signal: AbortSignal, onBatch: (hits: SearchHit[], scanned: number) => void): Promise<SearchDone> {
  const qs = new URLSearchParams({ path, q: f.q, mode: f.mode, ic: f.ic ? "1" : "0", content: f.content, cre: f.cre ? "1" : "0", cic: f.cic ? "1" : "0", types: f.types });
  if (hidden) qs.set("hidden", "1");
  const r = await fetch(`${nodeBase(node)}/api/fs/search?${qs}`, { signal });
  if (!r.ok) await j<unknown>(r);
  const reader = (r.body as ReadableStream<Uint8Array>).getReader();
  const dec = new TextDecoder();
  let buf = "";
  let done: SearchDone | null = null;
  for (;;) {
    const { value, done: end } = await reader.read();
    buf += dec.decode(value, { stream: !end });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (!line) continue;
      const o = JSON.parse(line) as { e?: { h: SearchHit[]; sc: number }; done?: SearchDone; error?: string };
      if (o.error) throw new Error(o.error);
      if (o.e) onBatch(o.e.h, o.e.sc);
      if (o.done) done = o.done;
    }
    if (end) break;
  }
  if (!done) throw new Error("search ended unexpectedly");
  return done;
}
