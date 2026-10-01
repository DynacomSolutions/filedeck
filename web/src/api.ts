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
}
export interface NodeInfo {
  name: string;
  online: boolean;
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

export const api = {
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
  nodes: () => fetch("/api/nodes").then((r) => j<{ nodes: NodeInfo[] }>(r)),
  mounts: (node: string) => fetch(`${nodeBase(node)}/api/mounts`).then((r) => j<{ mounts: Mount[] }>(r)),
  list: (node: string, path: string, hidden: boolean) =>
    fetch(`${nodeBase(node)}/api/fs/list?path=${enc(path)}${hidden ? "&hidden=1" : ""}`).then((r) =>
      j<{ path: string; entries: Entry[]; truncated: boolean }>(r),
    ),
  mkdir: (node: string, path: string) => post(node, "mkdir", { path }),
  rename: (node: string, from: string, to: string) => post(node, "rename", { from, to }),
  move: (node: string, from: string[], toDir: string) => post(node, "move", { from, toDir }),
  copy: (node: string, from: string[], toDir: string) => post(node, "copy", { from, toDir }),
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
  transfer: (src: { node: string; path: string }, dst: { node: string; dir: string }, op: "copy" | "move") =>
    fetch("/api/transfer", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ src, dst, op }),
    }).then((r) => j<unknown>(r)),
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
