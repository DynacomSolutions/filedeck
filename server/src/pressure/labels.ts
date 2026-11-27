import fs from "node:fs";
import type { Pod } from "./types.ts";

/** What a Kubernetes cgroup path says about its pod: the pod's uid (with dashes), and the container id when the path goes down to a container. */
export function parseKubeCgroup(cg: string): { uid: string; containerId?: string } | undefined {
  // systemd driver: /kubepods.slice/kubepods-burstable.slice/kubepods-burstable-pod<uid with underscores>.slice/cri-containerd-<id>.scope
  const sd = /\/kubepods(?:-[a-z]+)?-pod([0-9a-f]{8}(?:[_-][0-9a-f]{4}){3}[_-][0-9a-f]{12})\.slice(?:\/(?:[a-z-]+-)?([0-9a-f]{64})(?:\.scope)?)?(?:\/|$)/.exec(cg);
  if (sd) return { uid: (sd[1] as string).replace(/_/g, "-"), ...(sd[2] ? { containerId: sd[2] } : {}) };
  // cgroupfs driver: /kubepods/burstable/pod<uid>/<id>
  const fsd = /\/kubepods\/(?:[a-z]+\/)?pod([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\/([0-9a-f]{64}))?(?:\/|$)/.exec(cg);
  if (fsd) return { uid: fsd[1] as string, ...(fsd[2] ? { containerId: fsd[2] } : {}) };
  return undefined;
}

const UNIT = /\.(service|scope|slice|mount|socket|timer|path|automount|swap|target)$/;

/** The systemd unit a cgroup path ends in (`backup.service`), with systemd's `\xNN` escapes undone, or undefined. */
export function parseUnit(cg: string): string | undefined {
  const last = cg.split("/").filter(Boolean).pop();
  if (!last || !UNIT.test(last)) return undefined;
  return last.replace(/\\x([0-9a-f]{2})/gi, (_, h: string) => String.fromCharCode(parseInt(h, 16)));
}

interface PodEntry {
  namespace: string;
  name: string;
  uid: string;
  containers: string[];
}

export interface PodIndexOptions {
  /** the host's root as this process sees it (FILEDECK_ROOT) */
  hostRoot: string;
  now?: () => number;
  /** index lifetime (default 30 s) */
  maxAgeMs?: number;
  /** an unknown pod uid may start a new read at most this often (default 5 s) */
  unknownMs?: number;
}

/**
 * Pod names from the folder names under /var/log/pods (`<namespace>_<name>_<uid>/<container>`) and the container ids from the
 * links under /var/log/containers (`<name>_<namespace>_<container>-<id>.log`). Names only: no log file is opened and no API is called.
 */
export class PodIndex {
  private pods = new Map<string, PodEntry>();
  private containers = new Map<string, string>();
  private at = 0;
  private triedUnknown = 0;
  private readonly o: Required<PodIndexOptions>;

  constructor(opts: PodIndexOptions) {
    this.o = { now: Date.now, maxAgeMs: 30_000, unknownMs: 5000, ...opts };
  }

  private join(p: string): string {
    return this.o.hostRoot === "/" ? p : this.o.hostRoot + p;
  }

  refresh(): void {
    const pods = new Map<string, PodEntry>();
    try {
      for (const d of fs.readdirSync(this.join("/var/log/pods"), { withFileTypes: true })) {
        if (!d.isDirectory()) continue;
        const m = /^([^_]+)_([^_]+)_([0-9a-f-]{36})$/.exec(d.name);
        if (!m) continue;
        let containers: string[] = [];
        try {
          containers = fs.readdirSync(this.join(`/var/log/pods/${d.name}`), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
        } catch {
          /* unreadable */
        }
        pods.set(m[3] as string, { namespace: m[1] as string, name: m[2] as string, uid: m[3] as string, containers });
      }
    } catch {
      /* no pod logs on this machine */
    }
    const containers = new Map<string, string>();
    try {
      for (const f of fs.readdirSync(this.join("/var/log/containers"))) {
        const m = /^[^_]+_[^_]+_(.+)-([0-9a-f]{64})\.log$/.exec(f);
        if (m) containers.set(m[2] as string, m[1] as string);
      }
    } catch {
      /* none */
    }
    this.pods = pods;
    this.containers = containers;
    this.at = this.o.now();
  }

  lookup(uid: string, containerId?: string): Pod | undefined {
    const now = this.o.now();
    if (now - this.at > this.o.maxAgeMs) this.refresh();
    let p = this.pods.get(uid);
    if ((!p || (containerId && !this.containers.has(containerId))) && now - this.triedUnknown >= this.o.unknownMs && now - this.at >= this.o.unknownMs) {
      this.triedUnknown = now;
      this.refresh();
      p = this.pods.get(uid);
    }
    if (!p) return undefined;
    // a pod-level cgroup (no container id) names no container; a container id is looked up, else the pod's only container is it
    const c = containerId ? (this.containers.get(containerId) ?? (p.containers.length === 1 ? p.containers[0] : undefined)) : undefined;
    return { namespace: p.namespace, name: p.name, uid: p.uid, ...(c ? { container: c } : {}) };
  }

  get size(): number {
    return this.pods.size;
  }
}

export interface LabelRule {
  match: string;
  label: string;
  link?: string;
}

interface CompiledRule {
  re: RegExp;
  label: string;
  link?: string;
}

/**
 * An operator's label rules (FILEDECK_PRESSURE_LABELS): a JSON list of `{ "match": "<regex on the cgroup path>", "label": "<template>", "link": "<URL template>" }`.
 * In a template, `{1}` is the first capture group, `{name}` a named one, `{0}` the whole match. The first rule that matches wins.
 * A link is kept only when it starts with `https://`, `http://` or `/`; captures in it are URL-encoded.
 */
export class LabelRules {
  private rules: CompiledRule[] = [];

  constructor(json: string | undefined, log: (s: string) => void = () => undefined) {
    if (!json?.trim()) return;
    let list: unknown;
    try {
      list = JSON.parse(json);
    } catch (e) {
      log(`FILEDECK_PRESSURE_LABELS ignored: not JSON (${(e as Error).message})`);
      return;
    }
    if (!Array.isArray(list)) {
      log("FILEDECK_PRESSURE_LABELS ignored: it must be a JSON list");
      return;
    }
    for (const r of list as Partial<LabelRule>[]) {
      if (typeof r?.match !== "string" || typeof r.label !== "string" || (r.link !== undefined && typeof r.link !== "string")) {
        log("FILEDECK_PRESSURE_LABELS: a rule needs a string match and label (and an optional string link); it was skipped");
        continue;
      }
      try {
        this.rules.push({ re: new RegExp(r.match), label: r.label, ...(r.link ? { link: r.link } : {}) });
      } catch (e) {
        log(`FILEDECK_PRESSURE_LABELS: a rule was skipped (${(e as Error).message})`);
      }
    }
  }

  get size(): number {
    return this.rules.length;
  }

  apply(cg: string): { label: string; link?: string } | undefined {
    if (!this.rules.length) return undefined;
    const s = cg.slice(0, 1024);
    for (const r of this.rules) {
      const m = r.re.exec(s);
      if (!m) continue;
      const fill = (t: string, enc: boolean) =>
        t.replace(/\{(\w+)\}/g, (_, k: string) => {
          const v = /^\d+$/.test(k) ? m[Number(k)] : m.groups?.[k];
          return v === undefined ? "" : enc ? encodeURIComponent(v) : v;
        });
      const label = fill(r.label, false).slice(0, 200);
      const link = r.link ? fill(r.link, true) : undefined;
      return { label, ...(link && /^(https?:\/\/|\/)/.test(link) ? { link } : {}) };
    }
    return undefined;
  }
}
