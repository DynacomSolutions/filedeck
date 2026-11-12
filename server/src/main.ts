import type { Server } from "node:http";
import { serve } from "@hono/node-server";
import { createAgent } from "./agent.ts";
import { loadConfig } from "./config.ts";
import { initSandbox } from "./sandbox.ts";
import { createHub } from "./hub.ts";
import { SERVER_KEEP_ALIVE_MS } from "./agent-fetch.ts";
import { installShutdown } from "./shutdown.ts";

const cfg = loadConfig();
if (cfg.mode === "agent") void initSandbox(); // says once at start-up when helper programs are not confined by the kernel
const app = cfg.mode === "hub" ? createHub(cfg) : createAgent(cfg);
const server = serve({ fetch: app.fetch, port: cfg.port }, (i) => {
  console.log(`filedeck ${cfg.mode} listening on :${i.port}` + (cfg.mode === "agent" ? ` root=${cfg.root} node=${cfg.node}` : ` nodes=${cfg.nodes.map((n) => n.name).join(",")}`));
  (app as { startWatcher?: () => void }).startWatcher?.();
});
(server as Server).requestTimeout = 0; // long uploads/downloads; the ingress sets its own limits
// an idle connection outlives the 30 s the hub's client keeps one in its pool, so the server is never the side that closes it first
(server as Server).keepAliveTimeout = SERVER_KEEP_ALIVE_MS;
(server as Server).headersTimeout = SERVER_KEEP_ALIVE_MS + 5_000;
const stop = installShutdown(server as Server, () => (app as { close?: () => Promise<void> }).close?.(), { onSignal: () => (app as { leave?: () => Promise<void> }).leave?.() });
for (const sig of ["SIGTERM", "SIGINT"] as const) process.on(sig, stop);
