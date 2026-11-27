import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createServer as createTlsServer, type Server as TlsServer } from "node:https";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { ErrorCode, McpError, isInitializeRequest, SubscribeRequestSchema, UnsubscribeRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { matchesHostList } from "../request-guard.ts";
import type { HubCaller } from "./hub-call.ts";
import { ToolError } from "./hub-call.ts";
import { CONTRACT, LIST_URI, eventIdOf, type McpEventSink, type McpModule, type McpRelease, type McpSession, type McpUpdate } from "./events.ts";
import { Scope, type Grant, type GrantStore } from "./grants.ts";

import { McpMetrics } from "./metrics.ts";

/**
 * The MCP listener: MCP 2025-06-18 and later, streamable HTTP, on a port of its own. Paths:
 *   /mcp           the MCP endpoint (bearer token)
 *   /mcp/healthz   liveness: 200 while this listener accepts requests (also while draining)
 *   /mcp/readyz    readiness: 200 while it takes new sessions, 503 from the start of a drain
 * One session has one `McpServer`. Subscriptions are per session and end with it.
 */

export const MCP_PATH = "/mcp";
const MAX_BODY = 4 * 1024 * 1024;
const MAX_SUBSCRIPTIONS = 256;
const MAX_SESSIONS = 256;
/** Sessions of one grant, when the options give no other number (FILEDECK_MCP_SESSIONS_PER_GRANT). */
export const SESSIONS_PER_GRANT = 32;
/** A stream with more than this many bytes queued is a client that does not read: its session ends. */
const MAX_BACKLOG = 1024 * 1024;

export interface McpHttpOptions {
  grants: GrantStore;
  /** the caller for an account (sign-in on) or for the open hub (undefined) */
  callerFor: (account: string | undefined) => HubCaller;
  /** sign-in is on: a grant then needs an account */
  signIn: boolean;
  /** the account of a grant that names none (FILEDECK_MCP_ACCOUNT) */
  defaultAccount?: string;
  /** serve HTTPS with these PEM files, and read them again when they change */
  tls?: { cert: string; key: string; reloadMs?: number };
  modules: McpModule[];
  metrics: McpMetrics;
  /** Host values the listener serves (FILEDECK_MCP_ALLOWED_HOSTS); empty = any */
  allowedHosts: string[];
  /** most open sessions of one grant (default 32); a new session beyond it ends the oldest idle session of the grant */
  sessionsPerGrant?: number;
  /**
   * bytes queued on one event stream before its session ends, and on one answer to a POST before its connection is cut (default 1 MiB): a client
   * that does not read. A test sets it.
   */
  maxBacklog?: number;
  /** most open sessions in all (default 256); a test sets it */
  maxSessions?: number;
  serverVersion: string;
  /** Whether the hub's own listener answers; liveness and readiness need it too (main.ts asks /healthz on loopback). Default: always true. */
  hubHealthy?: () => Promise<boolean>;
  /** a session with no request and no open stream for this long is closed */
  idleMs?: number;
  /** keep-alive comment on an open stream, in ms */
  keepAliveMs?: number;
  log?: (msg: string) => void;
}

interface Session {
  id: string;
  grantId: string;
  grantFingerprint: string;
  audience: string;
  info: McpSession;
  mcp: McpServer;
  transport: StreamableHTTPServerTransport;
  subs: Map<string, McpRelease>;
  /** releases of the list interest, set when the session opens: every session gets list_changed */
  listRelease?: McpRelease;
  lastSeen: number;
  /** open event streams (GET) */
  streams: number;
  /** the responses of those streams, the oldest first: what is queued on them is what a slow client has not read */
  streamRes: Set<ServerResponse>;
  /** notices that the server had no open stream for since the last notice that it wrote */
  missed: number;
  /** the requests of POSTs that the server has not answered yet, by JSON-RPC id: the call function ends the work of its POST */
  calls: Map<string | number, () => void>;
  closed: boolean;
}

/** The ids of the requests in a POST body (a message with a method and an id; a notification has no id). */
function requestIds(body: unknown): (string | number)[] {
  const out: (string | number)[] = [];
  for (const m of Array.isArray(body) ? body : [body]) {
    if (m && typeof m === "object" && "method" in m && "id" in m && (typeof m.id === "string" || typeof m.id === "number")) out.push(m.id);
  }
  return out;
}

export class McpHttp {
  readonly server: Server | TlsServer;
  private readonly sessions = new Map<string, Session>();
  private readonly callers = new Map<string, HubCaller>();
  /** the id and the notice count of each event stream (a GET response) */
  private readonly streams = new WeakMap<ServerResponse, { id: string; seq: number }>();
  private readonly sweep: NodeJS.Timeout;
  private tlsTimer?: NodeJS.Timeout;
  private inflight = 0;
  private idleWaiters: (() => void)[] = [];
  private drainStarted?: Promise<void>;

  constructor(private readonly o: McpHttpOptions) {
    const count = (f: (s: Session) => number) => () => {
      const m = new Map<string, number>();
      for (const s of this.sessions.values()) m.set(s.grantId, (m.get(s.grantId) ?? 0) + f(s));
      return m;
    };
    o.metrics.gauges = {
      sessions: count(() => 1),
      subscriptions: count((s) => s.subs.size),
      inflight: () => this.inflight,
      draining: () => this.draining,
      watches: o.metrics.gauges.watches,
      grants: () => o.grants.grants.map((g) => g.id),
    };
    const sink: McpEventSink = { updated: (u) => this.deliver(u), listChanged: (c) => this.deliverListChanged(c) };
    for (const m of o.modules) m.start(sink);
    o.grants.onRevoked((ids) => {
      for (const s of [...this.sessions.values()]) if (ids.includes(s.grantId)) void this.closeSession(s, "revoked");
    });
    const handler = (req: IncomingMessage, res: ServerResponse) => void this.handle(req, res);
    this.server = o.tls ? this.tlsServer(o.tls, handler) : createServer(handler);
    this.server.requestTimeout = 0;
    const idleMs = o.idleMs ?? 15 * 60_000;
    this.sweep = setInterval(() => {
      const t = Date.now();
      for (const s of [...this.sessions.values()]) if (s.streams === 0 && t - s.lastSeen > idleMs) void this.closeSession(s, "idle");
    }, Math.min(60_000, Math.max(1000, idleMs / 4)));
    this.sweep.unref();
  }

  /** The HTTPS server. The certificate and key are read again every few seconds, and a changed pair is used for new connections (a renewal needs no restart). */
  private tlsServer(tls: { cert: string; key: string; reloadMs?: number }, handler: (req: IncomingMessage, res: ServerResponse) => void): TlsServer {
    let cert = readFileSync(tls.cert);
    let key = readFileSync(tls.key);
    const server = createTlsServer({ cert, key, minVersion: "TLSv1.2" }, handler);
    this.tlsTimer = setInterval(() => {
      void (async () => {
        try {
          const [c, k] = await Promise.all([readFile(tls.cert), readFile(tls.key)]);
          if (c.equals(cert) && k.equals(key)) return;
          server.setSecureContext({ cert: c, key: k, minVersion: "TLSv1.2" });
          cert = c;
          key = k;
          this.o.log?.("mcp: the TLS certificate was read again");
        } catch (e) {
          this.o.log?.(`mcp: the TLS certificate was not reloaded: ${(e as Error).message}`);
        }
      })();
    }, tls.reloadMs ?? 5000);
    this.tlsTimer.unref();
    return server;
  }

  get draining(): boolean {
    return this.drainStarted !== undefined;
  }

  get sessionCount(): number {
    return this.sessions.size;
  }

  get subscriptionCount(): number {
    return [...this.sessions.values()].reduce((n, s) => n + s.subs.size, 0);
  }

  // ---- notifications ----

  /**
   * A client that does not read its stream: what is queued on it passes the limit, so its session ends (the client connects again and reads a baseline).
   */
  private slow(s: Session): boolean {
    const limit = this.o.maxBacklog ?? MAX_BACKLOG;
    for (const res of s.streamRes) {
      if (res.writableLength <= limit) continue;
      this.o.log?.(`mcp: the session of grant ${s.grantId} ends: its stream holds ${res.writableLength} bytes that the client has not read`);
      this.o.metrics.error(s.grantId, "notify");
      void this.closeSession(s, "error");
      return true;
    }
    return false;
  }

  /**
   * The stream fields of the next notice of a session: the id of the open event stream, and the number of this notice on it (1 for the first). With
   * no open stream the notice cannot be written (the transport has none to write to): it is counted, and the next notice that is written says how
   * many were lost (`missed`). The client reads these fields to see a gap (docs/mcp.md).
   */
  private stamp(s: Session): { streamId: string; seq: number; missed?: number } | undefined {
    for (const res of s.streamRes) {
      if (res.destroyed || res.writableEnded) continue;
      const st = this.streams.get(res);
      if (!st) continue;
      const out = { streamId: st.id, seq: ++st.seq, ...(s.missed ? { missed: s.missed } : {}) };
      s.missed = 0;
      return out;
    }
    s.missed++;
    return undefined;
  }

  /**
   * `_meta` of one notice. `eventId` is the same for the same audience, URI and revision (see `eventIdOf`), and is at the top of `_meta` and in
   * `_meta.filedeck`. One change that touches several resources gives one notice for each, with its own id and a shared `changeId`.
   */
  private meta(s: Session, audience: string | undefined, uri: string, revision: number, changeId: string | undefined) {
    const stream = this.stamp(s);
    if (!stream) return undefined;
    const eventId = eventIdOf(audience, uri, revision);
    return { eventId, filedeck: { eventId, revision, uri, ...(changeId ? { changeId } : {}), ...stream } };
  }

  private deliver(u: McpUpdate): void {
    for (const s of [...this.sessions.values()]) {
      if (!s.subs.has(u.uri) || s.closed || (u.audience !== undefined && u.audience !== s.audience) || this.slow(s)) continue;
      const meta = this.meta(s, u.audience, u.uri, u.revision, u.changeId);
      if (!meta) continue;
      this.o.metrics.notification(s.grantId, "resource_updated");
      s.mcp.server.sendResourceUpdated({ uri: u.uri, _meta: meta }).catch(() => this.o.metrics.error(s.grantId, "notify"));
    }
  }

  private deliverListChanged(c: { revision: number; audience?: string; changeId?: string; allows?: (session: McpSession) => boolean }): void {
    for (const s of [...this.sessions.values()]) {
      if (!s.listRelease || s.closed || (c.audience !== undefined && c.audience !== s.audience) || (c.allows && !c.allows(s.info)) || this.slow(s)) continue;
      const meta = this.meta(s, c.audience, LIST_URI, c.revision, c.changeId);
      if (!meta) continue;
      this.o.metrics.notification(s.grantId, "list_changed");
      s.mcp.server.notification({ method: "notifications/resources/list_changed", params: { _meta: meta } }).catch(() => this.o.metrics.error(s.grantId, "notify"));
    }
  }

  // ---- sessions ----

  private callerFor(audience: string): HubCaller {
    let c = this.callers.get(audience);
    if (!c) this.callers.set(audience, (c = this.o.callerFor(this.o.signIn ? audience : undefined)));
    return c;
  }

  /** The account a grant reads as: with sign-in off none (the empty audience). */
  private audienceOf(g: Grant): string {
    return this.o.signIn ? g.account ?? this.o.defaultAccount ?? "" : "";
  }

  private newSession(g: Grant): Session {
    const o = this.o;
    const audience = this.audienceOf(g);
    const info: McpSession = { grant: g.id, audience, scope: new Scope(g), call: this.callerFor(audience), metrics: o.metrics };
    const mcp = new McpServer(
      { name: "filedeck", title: "FileDeck", version: o.serverVersion },
      {
        capabilities: { resources: { subscribe: true, listChanged: true }, tools: {} },
        instructions:
          `FileDeck contract ${CONTRACT} (docs/mcp.md). Read-only tools and filedeck:// resources for nodes, scans, jobs and change events. ` +
          "Subscribe to a resource to get notifications/resources/updated, then read it: every body has `revision` and `updatedAt`. " +
          "Every notification has _meta.eventId (the same value is in _meta.filedeck.eventId): drop one that you already saw. " +
          "_meta.filedeck.streamId and .seq number the notices of one event stream: a new streamId, a seq that is not the last one plus 1, or `missed` is a gap. " +
          "The server keeps no history and cannot resume a stream (Last-Event-ID is ignored): " +
          "after a gap or a reconnect, subscribe again and read each resource (a baseline read) and compare revisions. A baseline read is not an event.",
      },
    );
    for (const m of o.modules) m.register(mcp, info);
    const session: Session = { id: "", grantId: g.id, grantFingerprint: g.fingerprint, audience, info, mcp, transport: undefined as never, subs: new Map(), lastSeen: Date.now(), streams: 0, streamRes: new Set(), missed: 0, calls: new Map(), closed: false };
    session.transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        session.id = id;
        this.sessions.set(id, session);
        o.metrics.sessionOpened(g.id);
        // the grant may have been removed or changed since the request was checked: such a session ends at once
        if (o.grants.grants.find((x) => x.id === g.id)?.fingerprint !== g.fingerprint) void this.closeSession(session, "revoked");
        // every session gets list_changed from here on (not only after its first resources/list): the modules start the watches that it needs
        else session.listRelease = this.followLists(info);
      },
      keepAliveMs: o.keepAliveMs ?? 15_000,
    });
    session.transport.onclose = () => void this.closeSession(session, "client");
    // the server has done the work of a request when it sends the answer; what is left is delivery to the client (see `route`)
    const send = session.transport.send.bind(session.transport);
    session.transport.send = async (msg, options) => {
      try {
        return await send(msg, options);
      } finally {
        if ("id" in msg && msg.id !== undefined && ("result" in msg || "error" in msg)) session.calls.get(msg.id)?.();
      }
    };
    mcp.server.setRequestHandler(SubscribeRequestSchema, async (req) => {
      const uri = req.params.uri;
      if (session.subs.has(uri)) return {};
      if (!info.scope.allowsResource(uri)) throw new McpError(ErrorCode.InvalidParams, `forbidden: ${uri} is outside the grant`);
      if (session.subs.size >= MAX_SUBSCRIPTIONS) throw new McpError(ErrorCode.InvalidParams, `at most ${MAX_SUBSCRIPTIONS} subscriptions for each session`);
      let release: McpRelease | null = null;
      try {
        for (const m of o.modules) if ((release = await m.follow(uri, info))) break;
      } catch (e) {
        throw new McpError(ErrorCode.InvalidParams, e instanceof ToolError ? e.message : `cannot subscribe to ${uri}`);
      }
      if (!release) throw new McpError(ErrorCode.InvalidParams, `unknown resource: ${uri}`);
      if (session.closed || session.subs.has(uri)) {
        release();
        return {};
      }
      session.subs.set(uri, release);
      return {};
    });
    mcp.server.setRequestHandler(UnsubscribeRequestSchema, async (req) => {
      session.subs.get(req.params.uri)?.();
      session.subs.delete(req.params.uri);
      return {};
    });
    return session;
  }

  private async closeSession(s: Session, reason: "client" | "idle" | "drain" | "revoked" | "error" | "evicted"): Promise<void> {
    if (s.closed) return;
    s.closed = true;
    if (s.id) this.sessions.delete(s.id);
    for (const r of s.subs.values()) r();
    s.subs.clear();
    s.listRelease?.();
    s.listRelease = undefined;
    this.o.metrics.sessionClosed(s.grantId, reason);
    s.transport.onclose = undefined;
    await s.mcp.close().catch(() => undefined);
  }

  /** The interest of a session in the list of resources: the modules keep the watches that the list needs, and `list_changed` reaches the session. */
  private followLists(info: McpSession): McpRelease {
    const releases = this.o.modules.map((m) => m.followList(info));
    return () => releases.forEach((r) => r());
  }

  // ---- HTTP ----

  private async hubUp(): Promise<boolean> {
    try {
      return (await this.o.hubHealthy?.()) ?? true;
    } catch {
      return false;
    }
  }

  private reply(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
    if (res.headersSent) return;
    const text = typeof body === "string" ? body : JSON.stringify(body);
    res.writeHead(status, { "content-type": typeof body === "string" ? "text/plain; charset=utf-8" : "application/json", "cache-control": "no-store", ...headers });
    res.end(text);
  }

  private rpcError(res: ServerResponse, status: number, code: number, message: string, headers: Record<string, string> = {}): void {
    this.reply(res, status, { jsonrpc: "2.0", error: { code, message }, id: null }, headers);
  }

  /** The grant whose token the request carries. */
  private grantOf(req: IncomingMessage): Grant | undefined {
    const m = /^bearer +(.+)$/i.exec(req.headers.authorization ?? "");
    return m ? this.o.grants.match(m[1]!.trim()) : undefined;
  }

  private async readBody(req: IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = [];
    let n = 0;
    for await (const c of req) {
      n += (c as Buffer).length;
      if (n > MAX_BODY) throw new RangeError("body too large");
      chunks.push(c as Buffer);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const { metrics } = this.o;
    let grant: Grant | undefined;
    const gid = () => grant?.id ?? "none";
    try {
      const path = (req.url ?? "/").split("?")[0]!;
      // Probes first: no token, no data. Liveness answers whenever this listener answers; readiness fails from the start of a drain.
      if (path === `${MCP_PATH}/healthz`) return (await this.hubUp()) ? this.reply(res, 200, "ok") : this.reply(res, 503, "hub listener does not answer");
      if (path === `${MCP_PATH}/readyz`) {
        if (this.draining) return this.reply(res, 503, "draining");
        return (await this.hubUp()) ? this.reply(res, 200, "ready") : this.reply(res, 503, "hub listener does not answer");
      }
      if (path !== MCP_PATH && path !== `${MCP_PATH}/`) {
        metrics.request(gid(), "not_found");
        return this.reply(res, 404, { error: "not found" });
      }
      const host = (req.headers.host ?? "").toLowerCase();
      if (this.o.allowedHosts.length && !matchesHostList(host, this.o.allowedHosts)) {
        metrics.request(gid(), "bad_host");
        metrics.error(gid(), "protocol");
        return this.reply(res, 421, { error: "unknown host" });
      }
      // a browser page must not drive this listener (DNS rebinding): an Origin header is allowed only when it names this host
      const origin = req.headers.origin;
      if (origin !== undefined && (() => { try { return new URL(origin).host.toLowerCase() !== host; } catch { return true; } })()) {
        metrics.request(gid(), "bad_origin");
        metrics.error(gid(), "protocol");
        return this.reply(res, 403, { error: "origin not allowed" });
      }
      grant = this.grantOf(req);
      if (!grant) {
        metrics.request(gid(), "unauthorized");
        metrics.error(gid(), "auth");
        return this.reply(res, 401, { error: "unauthorized" }, { "www-authenticate": 'Bearer realm="filedeck-mcp"' });
      }
      // sign-in on: the grant reads as an account, and a grant without one is refused
      const id = this.o.signIn ? this.callerFor(this.audienceOf(grant)).identity() : undefined;
      if (id && "error" in id) {
        metrics.request(gid(), "forbidden");
        metrics.error(gid(), "auth");
        return this.reply(res, 403, { error: `forbidden: ${id.error}` });
      }
      await this.route(req, res, grant);
    } catch (e) {
      metrics.error(gid(), "internal");
      metrics.request(gid(), "error");
      this.o.log?.(`mcp: ${(e as Error).message}`);
      if (!res.headersSent) this.rpcError(res, 500, ErrorCode.InternalError, "internal error");
      else res.destroy();
    }
  }

  private async route(req: IncomingMessage, res: ServerResponse, grant: Grant): Promise<void> {
    const { metrics } = this.o;
    const gid = grant.id;
    const method = req.method ?? "GET";
    const sid = req.headers["mcp-session-id"];
    if (method !== "POST" && method !== "GET" && method !== "DELETE") {
      metrics.request(gid, "bad_method");
      return this.reply(res, 405, { error: "method not allowed" }, { allow: "GET, POST, DELETE" });
    }
    let body: unknown;
    if (method === "POST") {
      try {
        body = await this.readBody(req);
      } catch (e) {
        metrics.request(gid, "bad_body");
        metrics.error(gid, "protocol");
        return e instanceof RangeError ? this.rpcError(res, 413, ErrorCode.InvalidRequest, "request body too large") : this.rpcError(res, 400, ErrorCode.ParseError, "parse error");
      }
    }
    let session: Session | undefined;
    if (typeof sid === "string") {
      session = this.sessions.get(sid);
      if (!session) {
        metrics.request(gid, "unknown_session");
        return this.rpcError(res, 404, ErrorCode.InvalidRequest, "session not found");
      }
      // a session belongs to the grant that opened it, as that grant was when it opened it
      if (session.grantId !== grant.id || session.grantFingerprint !== grant.fingerprint) {
        metrics.request(gid, "wrong_grant");
        metrics.error(gid, "auth");
        return this.rpcError(res, 403, ErrorCode.InvalidRequest, "the session belongs to another grant");
      }
    } else if (method === "POST" && isInitializeRequest(body)) {
      if (this.draining) {
        metrics.request(gid, "draining");
        return this.rpcError(res, 503, ErrorCode.InternalError, "the server is shutting down", { "retry-after": "1" });
      }
      // one grant may not fill the hub: at its own limit, the new session takes the place of one session of that grant. The session that goes is one with no
      // open event stream (a client that follows keeps its stream open), and among those the one with the oldest last request; with every stream open, the
      // one with the oldest last request. This comes before the check of the total, so a grant at its limit is never refused because the hub is full.
      const own = [...this.sessions.values()].filter((x) => x.grantId === grant!.id && !x.closed);
      if (own.length >= (this.o.sessionsPerGrant ?? SESSIONS_PER_GRANT)) {
        const rank = (x: Session) => (x.streams > 0 ? 1 : 0);
        const victim = own.reduce((a, b) => (rank(b) < rank(a) || (rank(b) === rank(a) && b.lastSeen < a.lastSeen) ? b : a));
        await this.closeSession(victim, "evicted");
      }
      if (this.sessions.size >= (this.o.maxSessions ?? MAX_SESSIONS)) {
        metrics.request(gid, "busy");
        return this.rpcError(res, 503, ErrorCode.InternalError, "too many sessions", { "retry-after": "5" });
      }
      session = this.newSession(grant);
      await session.mcp.connect(session.transport);
    } else {
      metrics.request(gid, "no_session");
      metrics.error(gid, "protocol");
      return this.rpcError(res, 400, ErrorCode.InvalidRequest, "the Mcp-Session-Id header is missing or the first request is not initialize");
    }
    if (this.draining && method !== "DELETE") {
      // a drain finishes the calls in flight and takes no new request; a notification or a response to the server may still pass
      const batch = Array.isArray(body) ? body : [body];
      const isNew = method === "GET" || batch.some((m) => m && typeof m === "object" && "method" in m && "id" in m);
      if (isNew && !(batch.length === 1 && isInitializeRequest(batch[0]))) {
        metrics.request(gid, "draining");
        return this.rpcError(res, 503, ErrorCode.InternalError, "the server is shutting down", { "retry-after": "1" });
      }
    }
    session.lastSeen = Date.now();
    metrics.request(gid, "ok");
    const s = session;
    const track = method === "POST";
    if (track) this.inflight++;
    // The work of a POST is over when the server has sent the answer to each request in it (or at once, when it holds none). What is left is delivery:
    // a client that does not read must not keep a drain open. A drain waits for work, never for a client.
    let worked = false;
    const endWork = () => {
      if (worked) return;
      worked = true;
      if (track && --this.inflight === 0) for (const w of this.idleWaiters.splice(0)) w();
    };
    const ids = track ? requestIds(body) : [];
    if (track && ids.length === 0) endWork();
    let waiting = ids.length;
    for (const id of ids) {
      const call = () => {
        if (s.calls.get(id) !== call) return;
        s.calls.delete(id);
        if (--waiting <= 0) endWork();
      };
      s.calls.set(id, call);
    }
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      endWork();
      for (const id of ids) s.calls.delete(id);
      if (method === "GET") s.streams--;
      s.lastSeen = Date.now();
    };
    if (method === "GET") {
      s.streams++;
      s.streamRes.add(res);
      this.streams.set(res, { id: randomBytes(4).toString("hex"), seq: 0 });
      res.once("close", () => s.streamRes.delete(res));
    } else if (track) this.limitBacklog(res, s);
    res.once("close", finish);
    try {
      await s.transport.handleRequest(req, res, body);
    } finally {
      if (res.writableEnded || res.destroyed) finish();
    }
  }

  /** The answer to a POST goes to a client that does not read it: the bytes that wait in the hub pass the limit, so the connection is cut (the client asks again). */
  private limitBacklog(res: ServerResponse, s: Session): void {
    const limit = this.o.maxBacklog ?? MAX_BACKLOG;
    const write = res.write.bind(res);
    res.write = ((...args: unknown[]) => {
      const ok = (write as (...a: unknown[]) => boolean)(...args);
      if (res.writableLength > limit && !res.destroyed) {
        this.o.log?.(`mcp: an answer to grant ${s.grantId} is cut: it holds ${res.writableLength} bytes that the client has not read`);
        this.o.metrics.error(s.grantId, "slow");
        res.destroy();
      }
      return ok;
    }) as typeof res.write;
  }

  // ---- stop ----

  /**
   * Starts a drain and returns when it is done. Readiness fails from the start, and every new session and every new request gets 503 with
   * `Retry-After`. The drain waits until the server has answered every call in flight (the work), then closes every session and its streams. It does
   * not wait for a client to read an answer: a client that stopped reading must not keep the hub from its clean-up, so the drain ends and `stop()`
   * cuts that connection. It has no timer and no time limit: the grace period of the pod is the only limit, and it ends the process. A second call
   * joins the first. It does not close the listener: the caller does (`server.close()`, see main.ts), so a new connection is refused and a request on
   * a connection that is still open gets the 503.
   */
  drain(): Promise<void> {
    this.drainStarted ??= (async () => {
      if (this.inflight > 0) await new Promise<void>((r) => this.idleWaiters.push(r));
      await Promise.all([...this.sessions.values()].map((s) => this.closeSession(s, "drain")));
      this.server.closeIdleConnections();
    })();
    return this.drainStarted;
  }

  /** Stops the modules and the sweep, and ends every session without waiting for calls in flight. Call after `drain` (or on its own in tests). */
  async stop(): Promise<void> {
    clearInterval(this.sweep);
    clearInterval(this.tlsTimer);
    this.o.grants.stop();
    this.drainStarted ??= Promise.resolve();
    await Promise.all([...this.sessions.values()].map((s) => this.closeSession(s, "drain")));
    await Promise.all(this.o.modules.map((m) => m.stop()));
    this.server.closeAllConnections();
  }
}
