import { Hono } from "hono";
import { serve } from "@hono/node-server";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ResourceListChangedNotificationSchema, ResourceUpdatedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { createHub } from "../src/hub.ts";
import { loadConfig } from "../src/config.ts";
import { createMcp, type McpOptions } from "../src/mcp/index.ts";

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export const until = async (f: () => boolean, ms = 8000) => {
  for (const t0 = Date.now(); !f() && Date.now() - t0 < ms; ) await sleep(10);
  if (!f()) throw new Error("condition not met in time");
};

export interface FakeJob { id: string; kind: string; title: string; state: string; origin: string; progress: { entries: number }; createdAt: number; finishedAt?: number; error?: string; result?: unknown }

/** An agent whose state a test changes by hand: jobs, node status, stored sizes and a change journal. */
export function fakeAgent() {
  const state = {
    jobs: [] as FakeJob[],
    scannedAt: 1000 as number | null,
    watcherRunning: true,
    stored: new Set(["/data"]),
    changes: [] as Record<string, unknown>[],
    hits: new Map<string, number>(),
    delay: new Map<string, number>(),
    /** paths that answer 500 */
    fail: new Set<string>(),
  };
  const app = new Hono();
  app.use("*", async (c, next) => {
    const p = new URL(c.req.url).pathname;
    state.hits.set(p, (state.hits.get(p) ?? 0) + 1);
    const d = state.delay.get(p);
    if (d) await sleep(d);
    if (state.fail.has(p)) return c.json({ error: "broken" }, 500);
    await next();
  });
  app.get("/healthz", (c) => c.text("ok"));
  app.get("/api/jobs", (c) => c.json({ jobs: state.jobs }));
  app.get("/api/jobs/:id", (c) => {
    const j = state.jobs.find((x) => x.id === c.req.param("id"));
    return j ? c.json(j) : c.json({ error: "not found" }, 404);
  });
  app.get("/api/node-status", (c) =>
    c.json({
      sampledAt: Date.now(),
      sizeStore: { available: true, damaged: false },
      roots: [{ path: "/", scannedAt: state.scannedAt, fullScan: state.scannedAt !== null, state: state.scannedAt ? "current" : "missing" }],
      watcher: { kind: "fanotify", running: state.watcherRunning, ready: true, mounts: 1, watched: 1, covered: 1, unsupported: 0, aliases: 0, unwatched: 0, excluded: 0, backlog: 0, lostEvents: 0, unresolved: 0, unwatchedPaths: [], coverage: [] },
      journal: { serving: true, epoch: "e1", oldestCursor: "n:e1:1", newestCursor: `n:e1:${state.changes.length}`, oldestAgeMs: Date.now() % 1000, bytes: Date.now() % 100000, subscribers: { socket: 0, http: 0, internal: 0 }, lagMs: 0, overflows: 0, dropped: 0 },
    }),
  );
  app.get("/api/du", (c) => {
    const path = c.req.query("path") ?? "/";
    if (!state.stored.has(path)) return c.body(null, 204);
    return c.json({ path, entries: [{ path, type: "dir", bytes: 100, diskBytes: 4096, scannedAt: 1000 }, { path: path + "/a", type: "dir", bytes: 60, diskBytes: 4096 }], cached: true, truncated: false, watched: true });
  });
  app.get("/api/fs/list", (c) => c.json({ path: c.req.query("path") ?? "/", entries: [{ name: "a", path: "/data/a", type: "dir", size: 0, mtime: 1, mode: 493 }, { name: "b.txt", path: "/data/b.txt", type: "file", size: 5, mtime: 1, mode: 420 }], truncated: false }));
  app.get("/api/fs/stat", (c) => (c.req.query("path") === "/missing" ? c.json({ error: "not found" }, 404) : c.json({ name: "b.txt", path: c.req.query("path"), type: "file", size: 5, mtime: 1, mode: 420 })));
  app.get("/api/groups", (c) => c.json({ drives: [], labels: [] }));
  app.get("/api/v1/changes", (c) => {
    const since = c.req.query("since");
    const from = since ? Number(since.split(":")[2]) : 0;
    const enc = new TextEncoder();
    const lines = state.changes.filter((e) => Number(String(e.cursor).split(":")[2]) > from);
    const body = new ReadableStream<Uint8Array>({
      start(ctl) {
        for (const l of lines) ctl.enqueue(enc.encode(JSON.stringify(l) + "\n"));
        c.req.raw.signal.addEventListener("abort", () => { try { ctl.close(); } catch { /* closed */ } });
      },
    });
    return new Response(body, { headers: { "content-type": "application/x-ndjson" } });
  });
  return { app, state };
}

export interface GrantDef {
  id: string;
  token: string;
  resources: string[];
  tools: string[];
  account?: string;
}

export const ALL_TOKEN = "mcp-token-" + "z".repeat(30);
export const everything = (over: Partial<GrantDef> = {}): GrantDef => ({ id: "all", token: ALL_TOKEN, resources: ["filedeck://"], tools: ["*"], ...over });

/** A self-signed certificate for 127.0.0.1, made with openssl in `dir`. */
export function makeCert(dir: string, name = "tls"): { cert: string; key: string } {
  const cert = path.join(dir, `${name}.crt`);
  const key = path.join(dir, `${name}.key`);
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert, "-days", "2", "-subj", "/CN=localhost", "-addext", "subjectAltName=IP:127.0.0.1"], { stdio: "ignore" });
  return { cert, key };
}

export interface Boot {
  agent: ReturnType<typeof fakeAgent>;
  hub: ReturnType<typeof createHub>;
  mcp: NonNullable<Awaited<ReturnType<typeof createMcp>>>;
  url: string;
  /** the token of the first grant */
  token: string;
  /** a private folder for this boot: grants, tokens and certificates */
  dir: string;
  /** writes the grants file and the token files again (the hub reads them again by itself) */
  setGrants(defs: GrantDef[]): void;
  tls?: { cert: string; key: string };
  /** a connected client with notification counters */
  connect(o?: { token?: string }): Promise<Conn>;
  close(): Promise<void>;
}
export interface Conn {
  client: Client;
  updated: { uri: string; _meta?: { filedeck?: { eventId: string; revision: number; uri: string } } }[];
  listChanged: { n: number; metas: unknown[] };
  transport: StreamableHTTPClientTransport;
  close(): Promise<void>;
}

export async function boot(o: { agentUrl?: string; auth?: boolean; account?: string; admin?: boolean; grants?: GrantDef[]; tls?: boolean; env?: Record<string, string>; mcp?: McpOptions } = {}): Promise<Boot> {
  const agent = fakeAgent();
  const agentServer = o.agentUrl ? undefined : await new Promise<ReturnType<typeof serve>>((res) => {
    const s = serve({ fetch: agent.app.fetch, port: 0, hostname: "127.0.0.1" }, () => res(s));
  });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "filedeck-mcp-"));
  const grantsFile = path.join(dir, "grants.json");
  const setGrants = (defs: GrantDef[]) => {
    const list = defs.map((d) => {
      const tokenFile = path.join(dir, `token-${d.id}`);
      fs.writeFileSync(tokenFile, d.token + "\n");
      return { id: d.id, tokenFile, resources: d.resources, tools: d.tools, ...(d.account ? { account: d.account } : {}) };
    });
    fs.writeFileSync(grantsFile + ".tmp", JSON.stringify(list));
    fs.renameSync(grantsFile + ".tmp", grantsFile);
  };
  const defs = o.grants ?? [everything()];
  setGrants(defs);
  const tls = o.tls ? makeCert(dir) : undefined;
  const base = loadConfig({
    FILEDECK_MODE: "hub",
    FILEDECK_STATIC: "/nonexistent",
    NODES: `n=${o.agentUrl ?? `http://127.0.0.1:${(agentServer!.address() as AddressInfo).port}`}`,
    FILEDECK_MCP_PORT: "9092",
    FILEDECK_MCP_GRANTS_FILE: grantsFile,
    ...(tls ? { FILEDECK_MCP_TLS_CERT: tls.cert, FILEDECK_MCP_TLS_KEY: tls.key } : { FILEDECK_MCP_ALLOW_PLAINTEXT: "1" }),
    ...(o.auth ? { FILEDECK_AUTH: "on", FILEDECK_AGENT_TOKEN: "agent-secret" } : {}),
    ...(o.account ? { FILEDECK_MCP_ACCOUNT: o.account } : {}),
    ...o.env,
  } as never);
  const cfg = { ...base, mcpPollMs: 100 };
  const hub = createHub(cfg);
  if (o.auth) {
    const names = new Set([o.account, ...defs.map((d) => d.account)].filter((n): n is string => !!n && n !== "root"));
    for (const name of names) hub.auth!.accounts.create({ name, password: "pw-long-enough-1", admin: o.admin ?? true, nodes: { n: { runAs: "svc", grants: [{ path: "/", write: false }] } } });
  }
  const mcp = (await createMcp(cfg, hub as never, { log: () => undefined, keepAliveMs: 0, grantsPollMs: 50, tlsReloadMs: 100, ...o.mcp }))!;
  await new Promise<void>((r) => mcp.server.listen(0, "127.0.0.1", r));
  const url = `${tls ? "https" : "http"}://127.0.0.1:${(mcp.server.address() as AddressInfo).port}`;
  const conns: Conn[] = [];
  const b: Boot = {
    agent, hub, mcp, url, dir, setGrants, tls, token: defs[0]?.token ?? ALL_TOKEN,
    async connect(c = {}) {
      const client = new Client({ name: "test", version: "1" });
      const transport = new StreamableHTTPClientTransport(new URL(url + "/mcp"), { requestInit: { headers: { authorization: `Bearer ${c.token ?? b.token}` } } });
      // a clean goodbye ends the session on the server (DELETE); closing the client alone leaves it to the idle sweep
      const conn: Conn = { client, transport, updated: [], listChanged: { n: 0, metas: [] }, close: async () => { await transport.terminateSession().catch(() => undefined); await client.close(); } };
      client.setNotificationHandler(ResourceUpdatedNotificationSchema, (n) => void conn.updated.push(n.params as never));
      client.setNotificationHandler(ResourceListChangedNotificationSchema, (n) => {
        conn.listChanged.metas.push((n.params as { _meta?: unknown } | undefined)?._meta);
        conn.listChanged.n++;
      });
      await client.connect(transport);
      conns.push(conn);
      return conn;
    },
    async close() {
      for (const c of conns) await c.close().catch(() => undefined);
      await mcp.stop();
      mcp.server.closeAllConnections();
      await new Promise<void>((r) => mcp.server.close(() => r()));
      await hub.close();
      agentServer?.close();
      (agentServer as unknown as { closeAllConnections?(): void } | undefined)?.closeAllConnections?.();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
  return b;
}

export const job = (id: string, kind: string, state: string, extra: Partial<FakeJob> = {}): FakeJob => ({ id, kind, title: `${kind} ${id}`, state, origin: "cli", progress: { entries: 1 }, createdAt: Date.now(), ...extra });
export const bodyOf = (r: { contents: unknown[] }) => JSON.parse(String((r.contents[0] as { text?: unknown }).text)) as Record<string, any>;
