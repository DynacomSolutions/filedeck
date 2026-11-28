import fs from "node:fs";
import https from "node:https";
import { Deadline } from "./deadline.ts";

/** What the size gauges need to know of one pod of this node. */
export interface PodInfo {
  uid: string;
  namespace: string;
  name: string;
  /** container ids (runtime prefix removed) of the init, normal and ephemeral containers that the pod status names */
  containerIds: string[];
  /** the volumes that kubelet counts as pod ephemeral storage (see `localEphemeralVolumes`) */
  volumes: { plugin: string; name: string }[];
}

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === "object" ? (v as Obj) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string => (typeof v === "string" ? v : "");

/**
 * Kubelet counts these pod volumes as local ephemeral storage (`IsLocalEphemeralVolume`): a git repo volume, an emptyDir whose medium is not memory, and a
 * config map. Secret, projected and downward API volumes are not counted. Memory emptyDirs sit on tmpfs, which the size store never enters.
 */
export function localEphemeralVolumes(spec: Obj): { plugin: string; name: string }[] {
  const out: { plugin: string; name: string }[] = [];
  for (const raw of arr(spec.volumes)) {
    const v = obj(raw);
    const name = str(v.name);
    if (!name) continue;
    if (v.gitRepo) out.push({ plugin: "kubernetes.io~git-repo", name });
    else if (v.emptyDir && str(obj(v.emptyDir).medium) !== "Memory") out.push({ plugin: "kubernetes.io~empty-dir", name });
    else if (v.configMap) out.push({ plugin: "kubernetes.io~configmap", name });
  }
  return out;
}

export function toPodInfo(raw: unknown): PodInfo | null {
  const o = obj(raw);
  const meta = obj(o.metadata);
  const uid = str(meta.uid);
  if (!uid) return null;
  const status = obj(o.status);
  const ids: string[] = [];
  for (const key of ["initContainerStatuses", "containerStatuses", "ephemeralContainerStatuses"])
    for (const s of arr(status[key])) {
      const id = str(obj(s).containerID);
      const at = id.indexOf("://");
      if (id && at >= 0 && id.length > at + 3) ids.push(id.slice(at + 3));
    }
  return { uid, namespace: str(meta.namespace), name: str(meta.name), containerIds: ids, volumes: localEphemeralVolumes(obj(o.spec)) };
}

/** The pods of this node, kept current by list and watch events. */
export class PodTable {
  private pods = new Map<string, PodInfo>();
  events = 0;

  replace(items: unknown[]) {
    this.pods = new Map();
    for (const i of items) {
      const p = toPodInfo(i);
      if (p) this.pods.set(p.uid, p);
    }
  }

  /** One watch event: ADDED and MODIFIED store the pod, DELETED removes it. A replaced pod (same name, new uid) is a new row. */
  apply(type: string, raw: unknown) {
    const p = toPodInfo(raw);
    if (!p) return;
    this.events++;
    if (type === "DELETED") this.pods.delete(p.uid);
    else if (type === "ADDED" || type === "MODIFIED") this.pods.set(p.uid, p);
  }

  list(): PodInfo[] {
    return [...this.pods.values()];
  }
}

/** One GET of the Kubernetes API: the body as chunks. A non-200 answer throws an error with `status`. */
export type PodOpener = (path: string, signal: AbortSignal) => Promise<AsyncIterable<Uint8Array>>;

export class ApiStatusError extends Error {
  constructor(readonly status: number) {
    super(`kubernetes API answered ${status}`);
  }
}

/** Newline separated JSON objects from a body stream (a watch). */
export async function* jsonLines(body: AsyncIterable<Uint8Array>): AsyncGenerator<unknown> {
  let rest = "";
  const dec = new TextDecoder();
  for await (const chunk of body) {
    rest += dec.decode(chunk, { stream: true });
    let at: number;
    while ((at = rest.indexOf("\n")) >= 0) {
      const line = rest.slice(0, at).trim();
      rest = rest.slice(at + 1);
      if (line) yield JSON.parse(line);
    }
  }
  rest += dec.decode();
  if (rest.trim()) yield JSON.parse(rest);
}

const text = async (body: AsyncIterable<Uint8Array>) => {
  const dec = new TextDecoder();
  let s = "";
  for await (const c of body) s += dec.decode(c, { stream: true });
  return s + dec.decode();
};

export interface PodWatchOptions {
  node: string;
  open: PodOpener;
  log?: (s: string) => void;
  /** first and largest wait before a failed list or watch is tried again (ms); the wait is one one-shot timer, there is no other timer */
  retryMs?: number;
  retryMaxMs?: number;
}

/**
 * A list and watch of the pods with `spec.nodeName` of this node. Events change the table; nothing is polled. A watch that ends is opened again at once with the
 * last resource version, a lost version (410) lists again, and a failure waits one backoff step (one one-shot timer) before it tries again.
 */
export class PodWatch {
  readonly table = new PodTable();
  synced = false;
  restarts = 0;
  private ac = new AbortController();
  private wait: Deadline;
  private delay: number;
  private stopped = false;
  private version = "";

  constructor(private readonly o: PodWatchOptions) {
    this.delay = o.retryMs ?? 1000;
    this.wait = new Deadline(() => void this.run());
  }

  start() {
    if (!this.stopped) void this.run();
  }

  close() {
    this.stopped = true;
    this.wait.clear();
    this.ac.abort();
  }

  private query() {
    return `fieldSelector=${encodeURIComponent(`spec.nodeName=${this.o.node}`)}`;
  }

  private async run() {
    if (this.stopped) return;
    try {
      if (!this.version) {
        const list = JSON.parse(await text(await this.o.open(`/api/v1/pods?${this.query()}`, this.ac.signal))) as Obj;
        this.table.replace(arr(list.items));
        this.version = str(obj(list.metadata).resourceVersion);
        this.synced = true;
      }
      const body = await this.o.open(`/api/v1/pods?${this.query()}&watch=1&allowWatchBookmarks=true&resourceVersion=${encodeURIComponent(this.version)}`, this.ac.signal);
      const opened = Date.now();
      for await (const raw of jsonLines(body)) {
        const ev = obj(raw);
        const type = str(ev.type);
        if (type === "ERROR") throw new ApiStatusError(Number(obj(ev.object).code) || 500);
        const rv = str(obj(obj(ev.object).metadata).resourceVersion);
        if (rv) this.version = rv;
        if (type !== "BOOKMARK") this.table.apply(type, ev.object);
      }
      if (this.stopped) return;
      // the server ended the watch: open it again at the last version. A watch that lived a while starts again at once; one that ended at once waits a backoff step.
      if (Date.now() - opened >= 1000) {
        this.delay = this.o.retryMs ?? 1000;
        void this.run();
      } else {
        this.wait.set(Date.now() + this.delay);
        this.delay = Math.min(this.delay * 2, this.o.retryMaxMs ?? 30_000);
      }
    } catch (e) {
      if (this.stopped) return;
      this.restarts++;
      if (e instanceof ApiStatusError && e.status === 410) {
        this.version = "";
        this.synced = false;
      }
      this.o.log?.(`pod watch: ${(e as Error).message}; trying again in ${this.delay} ms`);
      this.wait.set(Date.now() + this.delay);
      this.delay = Math.min(this.delay * 2, this.o.retryMaxMs ?? 30_000);
    }
  }
}

/** The in-cluster opener: the service account token and CA are read for each request, so a rotated token is used at once. */
export function inClusterOpener(env: NodeJS.ProcessEnv = process.env): PodOpener | null {
  const host = env.KUBERNETES_SERVICE_HOST;
  if (!host) return null;
  const port = Number(env.KUBERNETES_SERVICE_PORT ?? 443);
  const dir = env.FILEDECK_K8S_SA_DIR || "/var/run/secrets/kubernetes.io/serviceaccount";
  return (p, signal) =>
    new Promise((resolve, reject) => {
      let token: string, ca: Buffer;
      try {
        token = fs.readFileSync(`${dir}/token`, "utf8").trim();
        ca = fs.readFileSync(`${dir}/ca.crt`);
      } catch (e) {
        return reject(e);
      }
      const req = https.request({ host, port, path: p, ca, headers: { authorization: `Bearer ${token}`, accept: "application/json" }, signal }, (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new ApiStatusError(res.statusCode ?? 0));
        }
        resolve(res);
      });
      req.on("error", reject);
      req.end();
    });
}
