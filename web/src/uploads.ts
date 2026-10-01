import { useSyncExternalStore } from "react";
import { announceJob, emitOpFinished, nodeBase } from "./api";
import type { Picked } from "./dropTree";
export { dropEntries, gatherDrop, pickedFromInput } from "./dropTree";
export type { Picked } from "./dropTree";

/**
 * Browser-driven uploads, shown in the jobs drawer. Small files are one streamed PUT; big files go
 * as ordered chunks to the agent's resumable endpoint (`/api/upload/*`), so a dropped connection,
 * a pause or a reload resumes from what the server already holds (the upload id is a hash of the
 * file's identity, so picking the same file again continues it). Folders keep their tree.
 * Network sources have no resumable endpoint (501); those fall back to a streamed PUT.
 */
export const CHUNK_SIZE = 8 * 1024 * 1024;
const THRESHOLD = 8 * 1024 * 1024;
const PARALLEL = 3;
const RETRIES = 5;

export type UpState = "pending" | "running" | "done" | "failed";
export interface UpFile {
  /** path below the destination folder, "/" separated, last segment is the name */
  rel: string;
  file: File;
  state: UpState;
  sent: number;
  /** final name when it had to change because the name was taken */
  note?: string;
  error?: string;
}
export type BatchState = "running" | "paused" | "done" | "failed" | "canceled";
export interface UpBatch {
  id: string;
  node: string;
  dir: string;
  title: string;
  dirs: string[];
  files: UpFile[];
  state: BatchState;
  bytes: number;
  totalBytes: number;
  /** bytes per second, smoothed */
  speed: number;
  createdAt: number;
  finishedAt?: number;
}

interface Internal extends UpBatch {
  ctrls: Set<AbortController>;
  gen: number;
  workers: number;
  /** chunked files with a part file on the server, dropped on cancel */
  parts: Map<UpFile, { dir: string; name: string; id: string }>;
}

const enc = encodeURIComponent;
let batches: Internal[] = [];
let snapshot: UpBatch[] = [];
const subs = new Set<() => void>();
let seq = 0;
const publish = () => {
  snapshot = [...batches];
  subs.forEach((f) => f());
};
export const useUploads = () => useSyncExternalStore((f) => (subs.add(f), () => void subs.delete(f)), () => snapshot);

const dirname = (rel: string) => (rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "");
const basename = (rel: string) => rel.slice(rel.lastIndexOf("/") + 1);
const cat = (a: string, b: string) => (a === "/" ? "" : a) + (b ? "/" + b : "");

export async function fileId(node: string, dir: string, name: string, f: File): Promise<string> {
  const s = `${node}\0${dir}\0${name}\0${f.size}\0${f.lastModified}`;
  if (globalThis.crypto?.subtle) {
    const h = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
    return [...new Uint8Array(h)].slice(0, 16).map((b) => b.toString(16).padStart(2, "0")).join("");
  }
  let a = 0x811c9dc5;
  let b = 0x9747b28c;
  for (let i = 0; i < s.length; i++) {
    a = Math.imul(a ^ s.charCodeAt(i), 16777619) >>> 0;
    b = Math.imul(b ^ s.charCodeAt(i), 2246822519) >>> 0;
  }
  return (a.toString(16).padStart(8, "0") + b.toString(16).padStart(8, "0")).repeat(2);
}

interface Res {
  status: number;
  json: Record<string, unknown>;
}
function xhr(method: string, url: string, body: Blob | null, onProgress: ((loaded: number) => void) | null, signal: AbortSignal): Promise<Res> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new DOMException("aborted", "AbortError"));
    const x = new XMLHttpRequest();
    x.open(method, url);
    if (onProgress) x.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded);
    x.onload = () => {
      let json: Record<string, unknown> = {};
      try {
        json = JSON.parse(x.responseText) as Record<string, unknown>;
      } catch {
        /* not json */
      }
      resolve({ status: x.status, json });
    };
    x.onerror = () => reject(new Error("network error"));
    x.ontimeout = () => reject(new Error("network timeout"));
    signal.addEventListener("abort", () => (x.abort(), reject(new DOMException("aborted", "AbortError"))), { once: true });
    x.send(body);
  });
}
const msg = (r: Res) => String(r.json.error ?? `HTTP ${r.status}`);
const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((res, rej) => {
    const t = setTimeout(res, ms);
    signal.addEventListener("abort", () => (clearTimeout(t), rej(new DOMException("aborted", "AbortError"))), { once: true });
  });
const isAbort = (e: unknown) => (e as Error)?.name === "AbortError";

async function mkdirIgnore(node: string, path: string, signal: AbortSignal) {
  const r = await xhrJson("POST", `${nodeBase(node)}/api/fs/mkdir`, { path }, signal);
  if (r.status >= 300 && r.status !== 409) throw new Error(msg(r));
}
function xhrJson(method: string, url: string, body: unknown, signal: AbortSignal): Promise<Res> {
  return fetch(url, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal }).then(async (r) => ({ status: r.status, json: (await r.json().catch(() => ({}))) as Record<string, unknown> }));
}

async function putWhole(b: Internal, f: UpFile, dir: string, name: string, signal: AbortSignal): Promise<string> {
  const mt = f.file.lastModified ? `&mtime=${Math.floor(f.file.lastModified)}` : "";
  let cur = name;
  for (let n = 1; n < 200; n++) {
    const r = await xhr("PUT", `${nodeBase(b.node)}/api/fs/upload?dir=${enc(dir)}&name=${enc(cur)}${mt}`, f.file, (l) => (f.sent = l), signal);
    if (r.status < 300) return cur;
    if (r.status === 409 && /exists/.test(msg(r))) {
      cur = freeName(name, n);
      f.sent = 0;
      continue;
    }
    throw new Error(msg(r));
  }
  throw new Error("could not find a free name");
}

function freeName(name: string, n: number) {
  const dot = name.lastIndexOf(".");
  const [base, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
  return `${base} (${n})${ext}`;
}

/** Returns the final name. Throws "unsupported" when the node has no resumable endpoint. */
async function putChunked(b: Internal, f: UpFile, dir: string, name: string, signal: AbortSignal): Promise<string> {
  const base = `${nodeBase(b.node)}/api/upload`;
  let cur = name;
  let id = "";
  let offset = 0;
  // pick a free name (or resume the part file of this very file), as one status call per candidate
  for (let n = 1; n < 200; n++) {
    id = await fileId(b.node, dir, cur, f.file);
    const r = await fetch(`${base}/status?dir=${enc(dir)}&name=${enc(cur)}&id=${id}`, { signal });
    if (r.status === 501 || r.status === 404 || r.status === 405) throw new Error("unsupported");
    const j = (await r.json().catch(() => ({}))) as { offset?: number; exists?: boolean; error?: string };
    if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
    if (j.exists) {
      cur = freeName(name, n);
      continue;
    }
    offset = j.offset ?? 0;
    break;
  }
  b.parts.set(f, { dir, name: cur, id });
  const mt = f.file.lastModified ? `&mtime=${Math.floor(f.file.lastModified)}` : "";
  const size = f.file.size;
  let fails = 0;
  f.sent = offset;
  while (true) {
    const end = Math.min(size, offset + CHUNK_SIZE);
    const base0 = offset;
    try {
      const r = await xhr(
        "PATCH",
        `${base}/chunk?dir=${enc(dir)}&name=${enc(cur)}&id=${id}&offset=${offset}&total=${size}${mt}`,
        f.file.slice(offset, end),
        (l) => (f.sent = base0 + l),
        signal,
      );
      if (r.status === 409 && typeof r.json.offset === "number") {
        offset = r.json.offset; // the server holds a different amount: continue from there
        f.sent = offset;
        continue;
      }
      if (r.status >= 300) throw new Error(msg(r));
      fails = 0;
      if (r.json.done === true) {
        f.sent = size;
        b.parts.delete(f);
        return cur;
      }
      offset = Number(r.json.offset ?? end);
      f.sent = offset;
    } catch (e) {
      if (isAbort(e)) throw e;
      // 4xx other than the offset mismatch will not get better by trying again
      if (/^HTTP 4|exists|too large|invalid|past the declared/.test((e as Error).message) && !/network/.test((e as Error).message)) throw e;
      if (++fails > RETRIES) throw e;
      await sleep(Math.min(8000, 500 * 2 ** fails), signal);
      // resync with the server before the next try
      const s = await fetch(`${base}/status?dir=${enc(dir)}&name=${enc(cur)}&id=${id}`, { signal }).then((x) => x.json() as Promise<{ offset?: number }>).catch(() => ({}) as { offset?: number });
      if (typeof s.offset === "number") offset = s.offset;
      f.sent = offset;
    }
  }
}

async function uploadOne(b: Internal, f: UpFile, signal: AbortSignal) {
  const dir = cat(b.dir, dirname(f.rel));
  const name = basename(f.rel);
  let final: string;
  if (f.file.size >= THRESHOLD) {
    try {
      final = await putChunked(b, f, dir, name, signal);
    } catch (e) {
      if ((e as Error).message !== "unsupported") throw e;
      final = await putWhole(b, f, dir, name, signal);
    }
  } else {
    final = await putWhole(b, f, dir, name, signal);
  }
  if (final !== name) f.note = `saved as ${final}`;
}

function counts(b: UpBatch) {
  let done = 0;
  let failed = 0;
  for (const f of b.files) f.state === "done" ? done++ : f.state === "failed" && failed++;
  return { done, failed, total: b.files.length };
}

async function work(b: Internal, gen: number) {
  b.workers++;
  try {
    for (;;) {
      if (b.gen !== gen || b.state !== "running") return;
      const f = b.files.find((x) => x.state === "pending");
      if (!f) return;
      f.state = "running";
      const ctrl = new AbortController();
      b.ctrls.add(ctrl);
      publish();
      try {
        await uploadOne(b, f, ctrl.signal);
        f.state = "done";
        f.sent = f.file.size;
        f.error = undefined;
      } catch (e) {
        if (isAbort(e)) {
          f.state = "pending"; // paused or canceled: the server keeps the part, so a resume continues it
        } else {
          f.state = "failed";
          f.error = (e as Error).message;
        }
      } finally {
        b.ctrls.delete(ctrl);
      }
      publish();
    }
  } finally {
    b.workers--;
    if (b.workers === 0) settle(b);
  }
}

function settle(b: Internal) {
  if (b.state !== "running") return publish();
  if (b.files.some((f) => f.state === "pending" || f.state === "running")) return;
  const c = counts(b);
  b.state = c.failed > 0 && c.failed === c.total ? "failed" : "done";
  b.finishedAt = Date.now();
  publish();
  emitOpFinished();
}

async function start(b: Internal) {
  const gen = ++b.gen;
  b.state = "running";
  publish();
  const ctrl = new AbortController();
  b.ctrls.add(ctrl);
  try {
    // folders first, parents before children
    for (const d of b.dirs) await mkdirIgnore(b.node, cat(b.dir, d), ctrl.signal);
  } catch (e) {
    b.ctrls.delete(ctrl);
    if (isAbort(e)) return;
    for (const f of b.files) if (f.state === "pending") (f.state = "failed", (f.error = `could not create folders: ${(e as Error).message}`));
    b.state = "failed";
    b.finishedAt = Date.now();
    return publish();
  }
  b.ctrls.delete(ctrl);
  if (b.gen !== gen || b.state !== "running") return;
  for (let i = 0; i < PARALLEL; i++) void work(b, gen);
}

/** Queue files (with their relative paths) and empty folders for upload into `dir` on `node`. */
export function enqueueUpload(node: string, dir: string, picked: Picked[], emptyDirs: string[] = [], title?: string): UpBatch {
  const dirs = new Set<string>(emptyDirs);
  for (const p of picked) for (let d = dirname(p.rel); d; d = dirname(d)) dirs.add(d);
  const sorted = [...dirs].sort((a, c) => a.split("/").length - c.split("/").length || a.localeCompare(c));
  const tops = new Set(picked.map((p) => p.rel.split("/")[0]));
  const b: Internal = {
    id: `up${++seq}-${Date.now().toString(36)}`,
    node,
    dir,
    title: title ?? (picked.length === 1 && !picked[0]!.rel.includes("/") ? `Upload ${picked[0]!.rel}` : `Upload ${tops.size === 1 && sorted.length ? [...tops][0] : picked.length + " files"}${picked.length > 1 && tops.size === 1 && sorted.length ? ` (${picked.length} files)` : ""}`),
    dirs: sorted,
    files: picked.map((p) => ({ rel: p.rel, file: p.file, state: "pending" as const, sent: 0 })),
    state: "running",
    bytes: 0,
    totalBytes: picked.reduce((n, p) => n + p.file.size, 0),
    speed: 0,
    createdAt: Date.now(),
    ctrls: new Set(),
    gen: 0,
    workers: 0,
    parts: new Map(),
  };
  batches = [b, ...batches];
  publish();
  void start(b);
  ensureTicker();
  announceJob(node);
  return b;
}

export function pauseUpload(id: string) {
  const b = batches.find((x) => x.id === id);
  if (!b || b.state !== "running") return;
  b.state = "paused";
  b.speed = 0;
  for (const c of b.ctrls) c.abort();
  publish();
}
export function resumeUpload(id: string) {
  const b = batches.find((x) => x.id === id);
  if (b && b.state === "paused") void start(b);
}
export function cancelUpload(id: string) {
  const b = batches.find((x) => x.id === id);
  if (!b || (b.state !== "running" && b.state !== "paused")) return;
  b.state = "canceled";
  b.speed = 0;
  b.finishedAt = Date.now();
  b.gen++;
  for (const c of b.ctrls) c.abort();
  for (const f of b.files) if (f.state === "pending" || f.state === "running") f.state = "pending";
  // drop the server-side part files of big files that were cut short
  for (const [, p] of b.parts) void fetch(`${nodeBase(b.node)}/api/upload?dir=${enc(p.dir)}&name=${enc(p.name)}&id=${p.id}`, { method: "DELETE" }).catch(() => undefined);
  b.parts.clear();
  publish();
}
export function retryFailed(id: string) {
  const b = batches.find((x) => x.id === id);
  if (!b || b.state === "running" || b.state === "paused") return;
  let any = false;
  for (const f of b.files) if (f.state === "failed") (f.state = "pending", (f.error = undefined), (any = true));
  if (any) {
    b.finishedAt = undefined;
    void start(b);
    ensureTicker();
  }
}
export function dismissUpload(id: string) {
  const b = batches.find((x) => x.id === id);
  if (!b || b.state === "running" || b.state === "paused") return;
  batches = batches.filter((x) => x !== b);
  publish();
}

let ticker: ReturnType<typeof setInterval> | undefined;
const last = new Map<string, number>();
function ensureTicker() {
  if (ticker) return;
  ticker = setInterval(() => {
    let live = false;
    for (const b of batches) {
      const bytes = b.files.reduce((n, f) => n + (f.state === "done" ? f.file.size : f.sent), 0);
      const delta = bytes - (last.get(b.id) ?? bytes);
      last.set(b.id, bytes);
      b.bytes = bytes;
      b.speed = b.state === "running" ? b.speed * 0.5 + Math.max(0, delta) * 0.5 : 0;
      if (b.state === "running") live = true;
    }
    publish();
    if (!live) {
      clearInterval(ticker);
      ticker = undefined;
    }
  }, 1000);
}
