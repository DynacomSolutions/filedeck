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

export const api = {
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
