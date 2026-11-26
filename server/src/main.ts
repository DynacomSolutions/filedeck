import type { Server } from "node:http";
import { serve } from "@hono/node-server";
import { createAgent } from "./agent.ts";
import { loadConfig, tailscaleStartup } from "./config.ts";
import { initSandbox } from "./sandbox.ts";
import { noReplaceWarning } from "./noreplace.ts";
import { selfCheckTools } from "./archive.ts";
import { createHub, tailnetListener } from "./hub.ts";
import { SERVER_KEEP_ALIVE_MS } from "./agent-fetch.ts";
import { installShutdown } from "./shutdown.ts";

const cfg = loadConfig();
if (cfg.auth && !cfg.agentToken) {
  console.error("FILEDECK_AUTH=on needs FILEDECK_AGENT_TOKEN");
  process.exit(2);
}
const tailscale = tailscaleStartup(cfg);
for (const l of tailscale.lines) console.log(l);
if (tailscale.stop) {
  console.error(tailscale.stop);
  process.exit(2);
}
if (cfg.mode === "agent") void initSandbox().then(() => selfCheckTools()); // says once at start-up when helper programs are not confined by the kernel
if (cfg.mode === "agent") void noReplaceWarning().then((w) => w && console.warn(w)); // says once at start-up when the rename helper is missing
const app = cfg.mode === "hub" ? createHub(cfg) : createAgent(cfg);
const server = serve({ fetch: app.fetch, hostname: cfg.host, port: cfg.port }, (i) => {
  console.log(`filedeck ${cfg.mode} listening on :${i.port}` + (cfg.mode === "agent" ? ` root=${cfg.root} node=${cfg.node}` : ` nodes=${cfg.nodes.map((n) => n.name).join(",")}`));
  (app as { startWatcher?: () => void }).startWatcher?.();
});
(server as Server).requestTimeout = 0; // long uploads/downloads; the ingress sets its own limits
// an idle connection outlives the 30 s the hub's client keeps one in its pool, so the server is never the side that closes it first; the header timeout stays above it
// (Node's rule). docs/configuration.md: "Connection timeouts".
(server as Server).keepAliveTimeout = SERVER_KEEP_ALIVE_MS;
(server as Server).headersTimeout = SERVER_KEEP_ALIVE_MS + 5_000;
// the identity listener (FILEDECK_TAILSCALE_LISTEN): marked before it listens, so no connection of it is unmarked
const identity = cfg.mode === "hub" && cfg.tailscaleListen ? tailnetListener(app as never, cfg.tailscaleListen) : undefined;
if (identity) {
  identity.requestTimeout = 0;
  identity.keepAliveTimeout = SERVER_KEEP_ALIVE_MS;
  identity.headersTimeout = SERVER_KEEP_ALIVE_MS + 5_000;
  identity.on("error", (e) => {
    console.error(`FILEDECK_TAILSCALE_LISTEN: ${e.message}`);
    process.exit(2);
  });
}
const stop = installShutdown(identity ? [server as Server, identity] : (server as Server), () => (app as { close?: () => Promise<void> }).close?.(), { onSignal: () => (app as { leave?: () => Promise<void> }).leave?.() });
for (const sig of ["SIGTERM", "SIGINT"] as const) process.on(sig, stop);
