import { ResourceTemplate, type McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import type { McpEvent, McpEventSink, McpModule, McpRelease, McpSession } from "./events.ts";
import type { McpMetrics } from "./metrics.ts";
import { failure, ToolError, type HubCaller } from "./hub-call.ts";
import { readTool } from "./tool.ts";
import { RevisionBook } from "./revisions.ts";
import { rootsDigest, SCAN_KINDS, SourceWatch, statusDigest, summarise, TERMINAL, type JobSummary, type StatusView, type WatchEvent } from "./watch.ts";

/**
 * The core module: the read-only tools and the `filedeck://` resources of nodes, scans, jobs, status, storage groups and change events, and the
 * shared watches that turn agent state changes into notifications. Resource URIs:
 *
 *   filedeck://nodes                      the nodes and whether each answers
 *   filedeck://nodes/{node}/status        the node status (watcher, journal, size store, scanned roots)
 *   filedeck://nodes/{node}/scans         the scan jobs of the node and its scanned roots
 *   filedeck://nodes/{node}/jobs          every job of the node
 *   filedeck://hub/jobs                   the hub's own operations (copy, move, trash, sync)
 *   filedeck://jobs/{id}                  one job
 */

export const HUB_KEY = "hub";
export const URI = {
  nodes: "filedeck://nodes",
  hubJobs: "filedeck://hub/jobs",
  status: (node: string) => `filedeck://nodes/${encodeURIComponent(node)}/status`,
  scans: (node: string) => `filedeck://nodes/${encodeURIComponent(node)}/scans`,
  jobs: (node: string) => `filedeck://nodes/${encodeURIComponent(node)}/jobs`,
  job: (id: string) => `filedeck://jobs/${encodeURIComponent(id)}`,
} as const;

const NODE_URI = /^filedeck:\/\/nodes\/([^/]+)\/(status|scans|jobs)$/;
const JOB_URI = /^filedeck:\/\/jobs\/([^/]+)$/;
const MAX_LISTED_JOBS = 200;

export interface CoreOptions {
  nodes: readonly string[];
  pollMs: number;
}

interface AudienceOptions extends CoreOptions {
  call: HubCaller;
  audience: string;
  metrics: McpMetrics;
  sink: () => McpEventSink | undefined;
}

/** The stable content of a resource, as a string: a read and a notification make the same string for the same state, so they give the same revision. */
const jobKey = (jobs: Iterable<JobSummary>) => JSON.stringify([...jobs].map((j) => [j.id, j.state]).sort());
const nodesKey = (nodes: { name: string; online: boolean }[]) => JSON.stringify(nodes.map((n) => [n.name, n.online]));
const scansKey = (state: string, view: StatusView | undefined, scans: Iterable<JobSummary>) => JSON.stringify([state, view ? rootsDigest(view) : "", jobKey(scans)]);
const jobOneKey = (j: JobSummary) => JSON.stringify([j.state, j.error ?? null]);
/** A virtual resource for the revision of `resources/list` (it has no body). */
export const LIST_URI = "filedeck://resources";

const denied = (what: string) => new McpError(ErrorCode.InvalidParams, `forbidden: ${what} is outside the grant`);

const record = z.record(z.unknown());
const job = z.object({
  id: z.string(), kind: z.string(), title: z.string(), state: z.string(), node: z.string().describe("the node that runs the job, or `hub` for a hub operation"),
  origin: z.string().optional(), createdAt: z.number().optional(), startedAt: z.number().optional(), finishedAt: z.number().optional(), error: z.string().optional(), progress: z.unknown().optional(),
}).passthrough();
/** Version of the published contract (docs/mcp.md). It rises when a field or a URI changes in a way that can break a client. */
export const CONTRACT = 1;

/** The core of one audience (an account, or the open hub): its own watches, revisions and tools. */
class AudienceCore {
  private readonly watches = new Map<string, SourceWatch>();
  private readonly o: AudienceOptions;
  private readonly book = new RevisionBook();

  constructor(o: AudienceOptions) {
    this.o = o;
    for (const node of o.nodes) this.watches.set(node, this.makeWatch(node, node, `/api/nodes/${encodeURIComponent(node)}/api/jobs`, node));
    this.watches.set(HUB_KEY, this.makeWatch(HUB_KEY, HUB_KEY, "/api/ops/jobs", undefined));
  }

  /** Sources with a running loop (a gauge). */
  get running(): number {
    return [...this.watches.values()].filter((w) => w.running).length;
  }

  private makeWatch(key: string, name: string, jobsPath: string, statusNode: string | undefined): SourceWatch {
    return new SourceWatch({ key, statusNode, jobsPath, call: this.o.call, pollMs: this.o.pollMs, metrics: this.o.metrics, emit: (events) => this.translate(name, events) });
  }

  async stop(): Promise<void> {
    await Promise.all([...this.watches.values()].map((w) => w.stop()));
  }

  // ---- events ----

  /** The updates one poll of a source causes. Updates of the same resource in one poll are sent as one notification. */
  private translate(key: string, events: WatchEvent[]): void {
    const sink = this.o.sink();
    if (!sink) return;
    const hub = key === HUB_KEY;
    const batch = new Map<string, McpEvent[]>();
    const add = (uri: string, e: McpEvent) => {
      const list = batch.get(uri);
      if (list) list.push(e);
      else batch.set(uri, [e]);
    };
    let listChanged = false;
    const listUri = hub ? URI.hubJobs : URI.jobs(key);
    for (const ev of events) {
      if (ev.kind === "job.created" || ev.kind === "job.state" || ev.kind === "job.removed") {
        const j = ev.job;
        const base = { node: key, jobId: j.id, jobKind: j.kind, state: j.state };
        const named: McpEvent = { kind: ev.kind, ...base, ...(ev.kind === "job.state" ? { previous: ev.previous } : {}), ...(j.error ? { error: j.error } : {}) };
        add(URI.job(j.id), named);
        add(listUri, named);
        if (ev.kind !== "job.state") listChanged = true;
        if (!hub && SCAN_KINDS.has(j.kind)) {
          const ended = TERMINAL.has(j.state);
          if (ev.kind === "job.created") add(URI.scans(key), { kind: "scan.started", ...base });
          if (ended && ev.kind !== "job.removed") add(URI.scans(key), { kind: "scan.finished", ...base, outcome: j.state, ...(j.error ? { error: j.error } : {}) });
          else if (ev.kind === "job.state") add(URI.scans(key), { kind: "scan.state", ...base, previous: ev.previous });
        }
      } else if (ev.kind === "reachable") {
        add(URI.nodes, { kind: "node.reachable", node: key, reachable: ev.reachable });
        add(URI.status(key), { kind: "node.reachable", node: key, reachable: ev.reachable });
      } else {
        add(URI.status(key), { kind: "node.status", node: key, state: ev.status.state });
        if (ev.stateChanged) add(URI.nodes, { kind: "node.state", node: key, state: ev.status.state });
        if (ev.rootsChanged) add(URI.scans(key), { kind: "scan.roots", node: key });
      }
    }
    const audience = this.o.audience;
    for (const [uri, list] of batch) sink.updated({ uri, revision: this.revisionOf(uri), events: list, audience });
    if (listChanged) sink.listChanged({ revision: this.revisionOf(LIST_URI), audience });
  }

  // ---- interest ----

  /** The sources a session may see: the nodes of its grant, and the hub's operations when the grant names them. */
  private allowed(s: McpSession): string[] {
    return [...this.o.nodes.filter((n) => s.scope.allowsNode(n)), ...(s.scope.allowsHubJobs ? [HUB_KEY] : [])];
  }

  followList(s: McpSession): McpRelease {
    const releases = this.allowed(s).map((k) => this.watches.get(k)!.acquire());
    return () => releases.forEach((r) => r());
  }

  /** The stable content of a resource now, from what the watches know. Undefined while a watch has not answered yet. */
  private snapKey(uri: string): string | undefined {
    if (uri === URI.nodes) {
      const reach = this.o.nodes.map((n) => this.watches.get(n)!.snapshot.reachable);
      return reach.includes(undefined) ? undefined : nodesKey(this.o.nodes.map((name, i) => ({ name, online: reach[i] === true })));
    }
    if (uri === LIST_URI) return jobKey([...this.watches.values()].flatMap((w) => [...(w.snapshot.jobs?.values() ?? [])]));
    if (uri === URI.hubJobs) {
      const j = this.watches.get(HUB_KEY)!.snapshot.jobs;
      return j && jobKey(j.values());
    }
    const n = NODE_URI.exec(uri);
    if (n) {
      const snap = this.watches.get(decodeURIComponent(n[1]!))?.snapshot;
      if (!snap?.jobs) return undefined;
      if (n[2] === "jobs") return jobKey(snap.jobs.values());
      if (!snap.status) return undefined;
      if (n[2] === "status") return statusDigest(snap.status);
      return scansKey(snap.status.state, snap.status, [...snap.jobs.values()].filter((j) => SCAN_KINDS.has(j.kind)));
    }
    const j = JOB_URI.exec(uri);
    if (j) {
      const id = decodeURIComponent(j[1]!);
      for (const w of this.watches.values()) {
        const hit = w.snapshot.jobs?.get(id);
        if (hit) return jobOneKey(hit);
      }
      return "gone";
    }
    return undefined;
  }

  /** The revision of a resource after a change: stamped from the watches' state, as a read stamps it from its own. */
  private revisionOf(uri: string): number {
    const key = this.snapKey(uri);
    return key === undefined ? this.book.stamp(uri, this.book.keyOf(uri) ?? "unknown").revision : this.book.stamp(uri, key).revision;
  }

  async follow(uri: string, _s?: McpSession): Promise<McpRelease | null> {
    let watches: SourceWatch[];
    if (uri === URI.nodes) watches = this.o.nodes.map((n) => this.watches.get(n)!);
    else if (uri === URI.hubJobs) watches = [this.watches.get(HUB_KEY)!];
    else {
      const n = NODE_URI.exec(uri);
      const j = JOB_URI.exec(uri);
      if (n) {
        const node = decodeURIComponent(n[1]!);
        const w = this.watches.get(node);
        if (!w || node === HUB_KEY) throw new ToolError(`unknown node: ${node}`);
        watches = [w];
      } else if (j) {
        const found = await this.findJob(decodeURIComponent(j[1]!));
        if (!found) throw new ToolError(`unknown job: ${decodeURIComponent(j[1]!)}`);
        watches = [this.watches.get(found.node)!];
      } else return null;
    }
    const releases = watches.map((w) => w.acquire());
    await Promise.all(watches.map((w) => w.ready()));
    return () => releases.forEach((r) => r());
  }

  // ---- reads ----

  /** A job by id: from the running watches first, else asked of every source. */
  async findJob(id: string, only?: string, signal?: AbortSignal): Promise<JobSummary | undefined> {
    const keys = only ? [only] : [...this.watches.keys()];
    for (const k of keys) {
      const hit = this.watches.get(k)?.snapshot.jobs?.get(id);
      if (hit) return hit;
    }
    for (const k of keys) {
      const path = k === HUB_KEY ? `/api/ops/jobs/${encodeURIComponent(id)}` : `/api/nodes/${encodeURIComponent(k)}/api/jobs/${encodeURIComponent(id)}`;
      const r = await this.o.call.json(path, signal).catch(() => undefined);
      if (r?.status === 200 && r.body && typeof r.body === "object") {
        const s = summarise(k, r.body as Record<string, unknown>);
        if (s) return s;
      }
    }
    return undefined;
  }

  private async nodeJobs(node: string, signal?: AbortSignal): Promise<JobSummary[]> {
    const path = node === HUB_KEY ? "/api/ops/jobs" : `/api/nodes/${encodeURIComponent(node)}/api/jobs`;
    const r = await this.o.call.json(path, signal);
    if (r.status !== 200) throw failure(`jobs of ${node}`, r.status, r.body);
    const list = (r.body as { jobs?: unknown[] } | undefined)?.jobs;
    return (Array.isArray(list) ? list : []).flatMap((j) => (j && typeof j === "object" ? [summarise(node, j as Record<string, unknown>)] : [])).filter((j): j is JobSummary => !!j);
  }

  private knownNode(node: string): string {
    if (!this.o.nodes.includes(node)) throw new ToolError(`unknown node: ${node}`);
    return node;
  }

  private async status(node: string | undefined, signal?: AbortSignal): Promise<StatusView[]> {
    if (node !== undefined) this.knownNode(node);
    const r = await this.o.call.json(`/api/status${node ? `?node=${encodeURIComponent(node)}` : ""}`, signal);
    if (r.status !== 200) throw failure("node status", r.status, r.body);
    return ((r.body as { nodes?: StatusView[] }).nodes ?? []) as StatusView[];
  }

  private async scansOf(node: string, signal?: AbortSignal): Promise<{ key: string; body: { node: string; state: string; roots: unknown[]; scans: JobSummary[] } }> {
    // node status is for administrators when sign-in is on: for another account the roots are left out and the state says so
    const [status] = await this.status(node, signal).catch((e: unknown) => (e instanceof ToolError && /^forbidden/.test(e.message) ? [{ node, state: "forbidden" as const, reason: "The account may not read node status." }] : Promise.reject(e)));
    const jobs = (await this.nodeJobs(node, signal).catch(() => [] as JobSummary[])).filter((j) => SCAN_KINDS.has(j.kind));
    const state = status?.state ?? "unavailable";
    return { key: scansKey(state, status, jobs), body: { node, state, roots: status?.state === "available" ? status.status.roots : [], scans: jobs } };
  }

  /** A resource body: the contract, the URI, the revision and the data. `key` is the stable content that decides a new revision. */
  private body(uri: string, key: string, data: Record<string, unknown>) {
    return { contract: CONTRACT, uri, ...this.book.stamp(uri, key), ...data };
  }

  private resource(uri: string, key: string, data: Record<string, unknown>) {
    return { contents: [{ uri, mimeType: "application/json", text: JSON.stringify(this.body(uri, key, data)) }] };
  }

  // ---- tools and resources ----

  register(server: McpServer, session: McpSession): void {
    const { call } = this.o;
    const ctx = session;
    const scope = session.scope;
    const nodeOk = (node: string): string => {
      this.knownNode(node);
      if (!scope.allowsNode(node)) throw new ToolError(`forbidden: node ${node} is outside the grant`);
      return node;
    };
    const names = (node: string | undefined): string[] => (node !== undefined ? [nodeOk(node)] : this.o.nodes.filter((n) => scope.allowsNode(n)));
    const nodeArg = z.string().min(1).describe("node name (see filedeck_nodes)");
    const pathArg = z.string().min(1).describe("absolute path on the node, for example /srv");

    readTool(server, ctx, "filedeck_nodes", {
      title: "List nodes",
      description: "Lists the nodes and network sources the account may use, and whether each answers.",
      input: {},
      output: { nodes: z.array(record), sources: z.array(record) },
    }, async (_a, signal) => {
      const r = await call.json("/api/nodes", signal);
      if (r.status !== 200) throw failure("nodes", r.status, r.body);
      const b = r.body as { nodes?: { name: string }[]; sources?: unknown[] };
      // a grant sees the nodes it names; the network sources only when it names the node list itself
      return { nodes: (b.nodes ?? []).filter((n) => scope.allowsNode(n.name)), sources: scope.allowsResource(URI.nodes) ? b.sources ?? [] : [] };
    });

    readTool(server, ctx, "filedeck_du", {
      title: "Folder sizes from stored scans",
      description: "Sizes of a folder and the folders below it, as `filedeck du` shows them. Answers only from stored scans: it never starts a scan. `stored` is false when the folder has no stored size.",
      input: { node: nodeArg, path: pathArg, depth: z.number().int().min(0).max(64).default(1).describe("levels below the folder"), all: z.boolean().default(false).describe("also list files") },
      output: { node: z.string(), path: z.string(), stored: z.boolean(), entries: z.array(record), cached: z.boolean().optional(), truncated: z.boolean().optional(), watched: z.boolean().optional(), stale: z.boolean().optional(), partial: z.boolean().optional(), error: z.string().optional() },
    }, async (a, signal) => {
      nodeOk(a.node);
      const q = new URLSearchParams({ path: a.path, depth: String(a.depth), cachedOnly: "1", ...(a.all ? { all: "1" } : {}) });
      const r = await call.json(`/api/nodes/${encodeURIComponent(a.node)}/api/du?${q}`, signal);
      if (r.status === 204) return { node: a.node, path: a.path, stored: false, entries: [] };
      if (r.status !== 200) throw failure(`${a.node}:${a.path}`, r.status, r.body);
      return { node: a.node, stored: true, ...(r.body as Record<string, unknown>) };
    });

    readTool(server, ctx, "filedeck_list", {
      title: "List a folder",
      description: "Lists the entries of a folder, folders first.",
      input: { node: nodeArg, path: pathArg, hidden: z.boolean().default(false).describe("also list names that start with a dot"), limit: z.number().int().min(1).max(5000).default(500) },
      output: { node: z.string(), path: z.string(), entries: z.array(record), total: z.number(), truncated: z.boolean() },
    }, async (a, signal) => {
      nodeOk(a.node);
      const q = new URLSearchParams({ path: a.path, ...(a.hidden ? { hidden: "1" } : {}) });
      const r = await call.json(`/api/nodes/${encodeURIComponent(a.node)}/api/fs/list?${q}`, signal);
      if (r.status !== 200) throw failure(`${a.node}:${a.path}`, r.status, r.body);
      const b = r.body as { path: string; entries: Record<string, unknown>[]; truncated?: boolean };
      return { node: a.node, path: b.path, entries: b.entries.slice(0, a.limit), total: b.entries.length, truncated: b.entries.length > a.limit || b.truncated === true };
    });

    readTool(server, ctx, "filedeck_stat", {
      title: "Stat a path",
      description: "Gives the type, size, modification time and mode of one path.",
      input: { node: nodeArg, path: pathArg },
      output: { node: z.string(), entry: record },
    }, async (a, signal) => {
      nodeOk(a.node);
      const r = await call.json(`/api/nodes/${encodeURIComponent(a.node)}/api/fs/stat?${new URLSearchParams({ path: a.path })}`, signal);
      if (r.status !== 200) throw failure(`${a.node}:${a.path}`, r.status, r.body);
      return { node: a.node, entry: r.body as Record<string, unknown> };
    });

    const rootsShape = z.array(record);
    readTool(server, ctx, "filedeck_scan_status", {
      title: "Scan status",
      description: "For each node: the scanned roots (when each was scanned and whether the stored sizes are current) and the scan jobs now or lately. `state` is available, unsupported, unavailable or forbidden; the roots need an administrator account when sign-in is on, and then `state` is forbidden and `roots` is empty.",
      input: { node: z.string().optional().describe("one node; all nodes when left out") },
      output: { nodes: z.array(z.object({ node: z.string(), state: z.string(), roots: rootsShape, scans: z.array(job) })) },
    }, async (a, signal) => {
      return { nodes: (await Promise.all(names(a.node).map((n) => this.scansOf(n, signal)))).map((x) => x.body) };
    });

    readTool(server, ctx, "filedeck_node_status", {
      title: "Node status",
      description: "The status of each node: size store, change watcher, event journal and scanned roots. `state` is available, unsupported or unavailable. Needs an administrator account when sign-in is on.",
      input: { node: z.string().optional().describe("one node; all nodes when left out") },
      output: { nodes: z.array(record) },
    }, async (a, signal) => {
      const list = names(a.node);
      const all = list.length === this.o.nodes.length && a.node === undefined;
      const views = all ? await this.status(undefined, signal) : (await Promise.all(list.map((n) => this.status(n, signal)))).flat();
      return { nodes: views as unknown as Record<string, unknown>[] };
    });

    const jobFilter = { node: z.string().optional().describe("a node, or `hub` for hub operations; all when left out"), state: z.string().optional().describe("for example running or done"), kind: z.string().optional().describe("for example size, du, compress") };
    readTool(server, ctx, "filedeck_jobs_list", {
      title: "List jobs",
      description: "Jobs of the nodes and of the hub's own operations that the account can see, newest first. The job result is not included.",
      input: { ...jobFilter, limit: z.number().int().min(1).max(1000).default(100) },
      output: { jobs: z.array(job), total: z.number(), truncated: z.boolean(), unavailable: z.array(z.string()) },
    }, async (a, signal) => {
      if (a.node === HUB_KEY && !scope.allowsHubJobs) throw new ToolError("forbidden: the hub's operations are outside the grant");
      const keys = a.node ? [a.node === HUB_KEY ? HUB_KEY : nodeOk(a.node)] : [...names(undefined), ...(scope.allowsHubJobs ? [HUB_KEY] : [])];
      const unavailable: string[] = [];
      const lists = await Promise.all(keys.map((k) => this.nodeJobs(k, signal).catch(() => (unavailable.push(k), [] as JobSummary[]))));
      if (a.node && unavailable.length) throw new ToolError(`unavailable: jobs of ${a.node}`);
      const all = lists.flat().filter((j) => (!a.state || j.state === a.state) && (!a.kind || j.kind === a.kind)).sort((x, y) => (y.createdAt ?? 0) - (x.createdAt ?? 0));
      return { jobs: all.slice(0, a.limit), total: all.length, truncated: all.length > a.limit, unavailable };
    });

    readTool(server, ctx, "filedeck_job_get", {
      title: "Get a job",
      description: "One job by id: state, progress and error. The job result is not included.",
      input: { id: z.string().min(1), node: z.string().optional().describe("the node, or `hub`; found by asking every source when left out") },
      output: { job },
    }, async (a, signal) => {
      if (a.node !== undefined && a.node !== HUB_KEY) nodeOk(a.node);
      const j = await this.findJob(a.id, a.node, signal);
      // a job of a source that the grant does not name is reported as not found
      if (!j || (j.node === HUB_KEY ? !scope.allowsHubJobs : !scope.allowsNode(j.node))) throw new ToolError(`not found: job ${a.id}`);
      return { job: j as unknown as Record<string, unknown> };
    });

    readTool(server, ctx, "filedeck_storage_groups", {
      title: "Storage groups",
      description: "Grouped storage totals (drives and labels) of the nodes. Needs the sign-in account to be an administrator when sign-in is on.",
      input: { node: z.string().optional().describe("one node; all nodes when left out") },
      output: { groups: record },
    }, async (a, signal) => {
      if (a.node) nodeOk(a.node);
      else if (names(undefined).length !== this.o.nodes.length) throw new ToolError("forbidden: this grant names some nodes only: give a node");
      const r = await call.json(`/api/groups${a.node ? `?node=${encodeURIComponent(a.node)}` : ""}`, signal);
      if (r.status !== 200) throw failure("storage groups", r.status, r.body);
      return { groups: r.body as Record<string, unknown> };
    });

    readTool(server, ctx, "filedeck_change_events", {
      title: "Recent change events",
      description:
        "Reads change events of one node from its journal (docs/change-events.md). Give `since` (a cursor from an earlier answer) to continue. Without it the read starts at the oldest event the journal keeps. " +
        "It ends at `limit` events, after `idleMs` with no event, or after `maxMs`. `nextCursor` is the place to continue from. Needs an administrator account when sign-in is on.",
      input: {
        node: nodeArg,
        since: z.string().optional().describe("cursor <node>:<epoch>:<seq>"),
        kind: z.array(z.enum(["create", "delete", "modify", "close_write", "attrib", "move"])).optional(),
        prefix: z.array(z.string()).optional().describe("absolute path prefixes"),
        glob: z.array(z.string()).optional(),
        type: z.enum(["file", "dir"]).optional(),
        label: z.array(z.string()).optional().describe("key:value"),
        limit: z.number().int().min(1).max(1000).default(100),
        idleMs: z.number().int().min(50).max(5000).default(750),
        maxMs: z.number().int().min(100).max(20_000).default(5000),
      },
      output: { node: z.string(), events: z.array(record), count: z.number(), nextCursor: z.string().optional(), needsRescan: z.boolean().describe("true when the answer holds a reset or overflow event: scan what you follow again"), ended: z.enum(["limit", "idle", "timeout", "lagged", "closed"]) },
    }, async (a, signal) => {
      nodeOk(a.node);
      let since = a.since;
      if (!since) {
        const [st] = await this.status(a.node, signal);
        // `since` is exclusive: the place just before the oldest event makes the read start at that event
        const oldest = st?.state === "available" ? /^(.*:)(\d+)$/.exec(st.status.journal.oldestCursor ?? "") : null;
        if (oldest) since = `${oldest[1]}${Math.max(0, Number(oldest[2]) - 1)}`;
      }
      const q = new URLSearchParams();
      for (const k of ["kind", "prefix", "glob", "label"] as const) for (const v of a[k] ?? []) q.append(k, v);
      if (a.type) q.set("type", a.type);
      if (since) q.set("since", since);
      const stop = new AbortController();
      const res = await call.stream(`/api/nodes/${encodeURIComponent(a.node)}/api/v1/changes?${q}`, AbortSignal.any([signal, stop.signal]));
      if (res.status !== 200) {
        await res.body?.cancel().catch(() => undefined);
        throw failure(`change events of ${a.node}`, res.status, undefined);
      }
      const events: Record<string, unknown>[] = [];
      let nextCursor = since;
      let ended: "limit" | "idle" | "timeout" | "lagged" | "closed" = "closed";
      let needsRescan = false;
      const reader = res.body!.getReader();
      const dec = new TextDecoder();
      let buf = "";
      const deadline = Date.now() + a.maxMs;
      try {
        read: for (;;) {
          const wait = Math.min(a.idleMs, deadline - Date.now());
          if (wait <= 0) {
            ended = "timeout";
            break;
          }
          const got = await Promise.race([reader.read(), new Promise<"idle">((r) => setTimeout(() => r("idle"), wait).unref())]);
          if (got === "idle") {
            ended = Date.now() >= deadline ? "timeout" : "idle";
            break;
          }
          if (got.done) break;
          buf += dec.decode(got.value, { stream: true });
          for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
            const line = buf.slice(0, i);
            buf = buf.slice(i + 1);
            if (!line) continue;
            let ev: Record<string, unknown>;
            try {
              ev = JSON.parse(line) as Record<string, unknown>;
            } catch {
              continue;
            }
            if (typeof ev.cursor === "string") nextCursor = ev.cursor;
            if (ev.kind === "ping" || ev.kind === "ready") continue;
            if (ev.kind === "reset" || ev.kind === "overflow") needsRescan = true;
            events.push(ev);
            if (ev.kind === "lagged") {
              ended = "lagged"; // too slow: the stream ends, and `cursor` is the place to continue from
              break read;
            }
            if (events.length >= a.limit) {
              ended = "limit";
              break read;
            }
          }
        }
      } finally {
        stop.abort();
        await reader.cancel().catch(() => undefined);
      }
      return { node: a.node, events, count: events.length, ...(nextCursor ? { nextCursor } : {}), needsRescan, ended };
    });

    // ---- resources ----
    // A resource outside the grant is not registered (a template that no URI of the grant can match), and a read of a URI outside it is refused.
    const guard = (uri: string) => {
      if (!scope.allowsResource(uri)) throw denied(uri);
    };
    const nodeList = (what: string, make: (n: string) => string) => async () => ({
      resources: this.o.nodes.map((n) => ({ uri: make(n), name: `${n} ${what}`, mimeType: "application/json" })).filter((r) => scope.allowsResource(r.uri)),
    });
    const complete = { node: async (v: string) => this.o.nodes.filter((n) => n.startsWith(v) && scope.allowsNode(n)) };
    const nodeOfUri = (v: string | string[] | undefined) => this.knownNode(decodeURIComponent(String(v)));
    const template = (pattern: string, list: ResourceTemplate extends never ? never : ConstructorParameters<typeof ResourceTemplate>[1]) => new ResourceTemplate(pattern, list);

    if (scope.allowsResource(URI.nodes))
      server.registerResource("nodes", URI.nodes, { title: "Nodes", description: "The nodes and network sources, and whether each answers.", mimeType: "application/json" }, async (uri, extra) => {
        guard(uri.href);
        const r = await call.json("/api/nodes", extra.signal);
        if (r.status !== 200) throw failure("nodes", r.status, r.body);
        const b = r.body as { nodes?: { name: string; online: boolean }[]; sources?: unknown[] };
        return this.resource(uri.href, nodesKey(b.nodes ?? []), { nodes: b.nodes ?? [], sources: b.sources ?? [] });
      });
    if (scope.allowsHubJobs)
      server.registerResource("hub-jobs", URI.hubJobs, { title: "Hub operations", description: "The hub's own jobs: copy, move, trash and sync.", mimeType: "application/json" }, async (uri, extra) => {
        guard(uri.href);
        const jobs = await this.nodeJobs(HUB_KEY, extra.signal);
        return this.resource(uri.href, jobKey(jobs), { node: HUB_KEY, jobs });
      });
    if (scope.allowsTemplate("filedeck://nodes/{node}/status"))
      server.registerResource("node-status", template("filedeck://nodes/{node}/status", { list: nodeList("status", URI.status), complete }), { title: "Node status", mimeType: "application/json" }, async (uri, v, extra) => {
        guard(uri.href);
        const [st] = await this.status(nodeOfUri(v.node), extra.signal);
        return this.resource(uri.href, st ? statusDigest(st) : "none", { ...(st as unknown as Record<string, unknown>) });
      });
    if (scope.allowsTemplate("filedeck://nodes/{node}/scans"))
      server.registerResource("node-scans", template("filedeck://nodes/{node}/scans", { list: nodeList("scans", URI.scans), complete }), { title: "Node scans", mimeType: "application/json" }, async (uri, v, extra) => {
        guard(uri.href);
        const scans = await this.scansOf(nodeOfUri(v.node), extra.signal);
        return this.resource(uri.href, scans.key, scans.body);
      });
    if (scope.allowsTemplate("filedeck://nodes/{node}/jobs"))
      server.registerResource("node-jobs", template("filedeck://nodes/{node}/jobs", { list: nodeList("jobs", URI.jobs), complete }), { title: "Node jobs", mimeType: "application/json" }, async (uri, v, extra) => {
        guard(uri.href);
        const node = nodeOfUri(v.node);
        const jobs = await this.nodeJobs(node, extra.signal);
        return this.resource(uri.href, jobKey(jobs), { node, jobs });
      });
    if (scope.allowsTemplate("filedeck://jobs/{id}"))
      server.registerResource("job", template("filedeck://jobs/{id}", {
        list: async () => {
          // the first listing of a session starts the watches (server.ts); it waits here for their first answer
          const mine = this.allowed(session).map((k) => this.watches.get(k)!);
          await Promise.all(mine.map((w) => w.ready(5000)));
          const jobs = mine.flatMap((w) => [...(w.snapshot.jobs?.values() ?? [])]).filter((j) => scope.allowsResource(URI.job(j.id))).slice(0, MAX_LISTED_JOBS);
          return { resources: jobs.map((j) => ({ uri: URI.job(j.id), name: `${j.title} (${j.node})`, mimeType: "application/json" })) };
        },
      }), { title: "Job", mimeType: "application/json" }, async (uri, v, extra) => {
        guard(uri.href);
        const id = decodeURIComponent(String(v.id));
        const j = await this.findJob(id, undefined, extra.signal);
        if (!j || (j.node === HUB_KEY ? !scope.allowsHubJobs : !scope.allowsNode(j.node))) throw new ToolError(`not found: job ${id}`);
        return this.resource(uri.href, jobOneKey(j), { job: j });
      });
  }
}

/**
 * The core module: the read-only tools and the `filedeck://` resources of nodes, scans, jobs, status, storage groups and change events, and the
 * shared watches that turn agent state changes into notifications. Everything is kept for each audience (an account, or the open hub), because
 * what an account may read differs from one account to the next. Sessions of one audience share one watch for each node.
 */
export class CoreModule implements McpModule {
  readonly name = "core";
  private sink?: McpEventSink;
  private readonly audiences = new Map<string, AudienceCore>();

  constructor(private readonly o: CoreOptions) {}

  private of(s: McpSession): AudienceCore {
    let a = this.audiences.get(s.audience);
    if (!a) this.audiences.set(s.audience, (a = new AudienceCore({ ...this.o, call: s.call, audience: s.audience, metrics: s.metrics, sink: () => this.sink })));
    return a;
  }

  /** Sources with a running loop (a gauge). */
  get running(): number {
    return [...this.audiences.values()].reduce((n, a) => n + a.running, 0);
  }

  start(sink: McpEventSink): void {
    this.sink = sink;
  }

  register(server: McpServer, s: McpSession): void {
    this.of(s).register(server, s);
  }

  follow(uri: string, s: McpSession): Promise<McpRelease | null> {
    return this.of(s).follow(uri, s);
  }

  followList(s: McpSession): McpRelease {
    return this.of(s).followList(s);
  }

  async stop(): Promise<void> {
    await Promise.all([...this.audiences.values()].map((a) => a.stop()));
  }
}
