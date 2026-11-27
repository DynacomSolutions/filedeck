import { readFileSync } from "node:fs";
import type { Server } from "node:http";
import type { Config } from "../config.ts";
import type { Accounts } from "../auth/store.ts";
import { makeHubCaller } from "./hub-call.ts";
import { CoreModule } from "./core.ts";
import type { McpModule } from "./events.ts";
import { GrantStore } from "./grants.ts";
import { McpMetrics } from "./metrics.ts";
import { McpHttp } from "./server.ts";

export { McpHttp } from "./server.ts";
export type { McpModule, McpEventSink, McpUpdate, McpRelease, McpEvent, McpSession } from "./events.ts";
export { readTool } from "./tool.ts";
export { CONTRACT } from "./core.ts";
export { GrantStore, Scope } from "./grants.ts";
export { McpMetrics } from "./metrics.ts";

/** What the MCP server needs of the hub. */
export interface McpHub {
  fetch: (req: Request) => Response | Promise<Response>;
  auth?: { accounts: Accounts };
  addMetrics(lines: () => string[]): void;
}

export interface McpOptions {
  /** more modules, added without a change to the core (for example disk verification) */
  modules?: (metrics: McpMetrics) => McpModule[];
  log?: (msg: string) => void;
  idleMs?: number;
  keepAliveMs?: number;
  /** whether the hub's own listener answers (see McpHttpOptions.hubHealthy) */
  hubHealthy?: () => Promise<boolean>;
  /** how often the grant files are read again, in ms (default 2000) */
  grantsPollMs?: number;
  /** how often the TLS files are read again, in ms (default 5000) */
  tlsReloadMs?: number;
}

const serverVersion = (): string => {
  try {
    return (JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version?: string }).version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
};

/**
 * Makes the MCP server of a hub (not listening yet). Returns undefined, and says why in the log, when the settings do not allow it to run:
 * - no port: it is off;
 * - no grants file: nothing could ever be allowed in, so there is no listener;
 * - no TLS certificate: it refuses to serve plain HTTP, unless FILEDECK_MCP_ALLOW_PLAINTEXT=1 (tests only).
 */
export async function createMcp(cfg: Config, hub: McpHub, o: McpOptions = {}): Promise<McpHttp | undefined> {
  if (cfg.mode !== "hub" || cfg.mcpPort === undefined) return undefined;
  const log = o.log ?? ((m: string) => console.error(m));
  if (!cfg.mcpGrantsFile) {
    log("FILEDECK_MCP_PORT is set but FILEDECK_MCP_GRANTS_FILE is not: the MCP server is not started");
    return undefined;
  }
  let tls: { cert: string; key: string; reloadMs?: number } | undefined;
  if (cfg.mcpTlsCert && cfg.mcpTlsKey) {
    try {
      readFileSync(cfg.mcpTlsCert);
      readFileSync(cfg.mcpTlsKey);
    } catch (e) {
      log(`the MCP server is not started: its TLS files cannot be read (${(e as Error).message})`);
      return undefined;
    }
    tls = { cert: cfg.mcpTlsCert, key: cfg.mcpTlsKey, reloadMs: o.tlsReloadMs };
  } else if (!cfg.mcpAllowPlaintext) {
    log("FILEDECK_MCP_PORT is set but FILEDECK_MCP_TLS_CERT and FILEDECK_MCP_TLS_KEY are not: the MCP server is not started (it never serves plain HTTP)");
    return undefined;
  }
  const grants = new GrantStore({ file: cfg.mcpGrantsFile, pollMs: o.grantsPollMs, log });
  if (!(await grants.reload())) {
    log("the MCP server is not started: its grants file cannot be used");
    return undefined;
  }
  grants.start();
  const metrics = new McpMetrics();
  const callerFor = (account: string | undefined) => makeHubCaller({ cfg, fetch: (req) => hub.fetch(req), accounts: hub.auth?.accounts, account });
  const core = new CoreModule({ nodes: cfg.nodes.map((n) => n.name), pollMs: cfg.mcpPollMs });
  const http = new McpHttp({
    grants,
    callerFor,
    signIn: cfg.auth,
    defaultAccount: cfg.mcpAccount,
    tls,
    modules: [core, ...(o.modules?.(metrics) ?? [])],
    metrics,
    allowedHosts: cfg.allowedHosts,
    serverVersion: serverVersion(),
    hubHealthy: o.hubHealthy,
    idleMs: o.idleMs,
    keepAliveMs: o.keepAliveMs,
    log,
  });
  metrics.gauges.watches = () => core.running;
  hub.addMetrics(() => metrics.lines());
  return http;
}

/** Makes the server and starts it listening on the configured port. */
export async function startMcp(cfg: Config, hub: McpHub, o: McpOptions = {}): Promise<McpHttp | undefined> {
  // the hub's own listener, asked on loopback: the probes of the MCP listener fail when it does not answer
  const loopback = !cfg.host || cfg.host === "0.0.0.0" || cfg.host === "::" ? "127.0.0.1" : cfg.host.includes(":") ? `[${cfg.host}]` : cfg.host;
  const hubHealthy = async () => (await fetch(`http://${loopback}:${cfg.port}/healthz`, { signal: AbortSignal.timeout(2000) })).ok;
  const http = await createMcp(cfg, hub, { hubHealthy, ...o });
  if (!http) return undefined;
  http.server.on("error", (e) => {
    console.error(`FILEDECK_MCP_PORT: ${(e as Error).message}`);
    process.exit(2);
  });
  http.server.listen(cfg.mcpPort, cfg.host, () => console.log(`filedeck mcp listening on :${cfg.mcpPort}/mcp (${cfg.mcpTlsCert ? "https" : "plain http"})`));
  return http;
}

export type { Server };
