import type { Server } from "node:http";
import { serve } from "@hono/node-server";
import { createAgent } from "./agent.ts";
import { loadConfig } from "./config.ts";
import { createHub } from "./hub.ts";

const cfg = loadConfig();
const app = cfg.mode === "hub" ? createHub(cfg) : createAgent(cfg);
const server = serve({ fetch: app.fetch, port: cfg.port }, (i) => {
  console.log(`filedeck ${cfg.mode} listening on :${i.port}` + (cfg.mode === "agent" ? ` root=${cfg.root} node=${cfg.node}` : ` nodes=${cfg.nodes.map((n) => n.name).join(",")}`));
});
(server as Server).requestTimeout = 0; // long uploads/downloads; the ingress sets its own limits
(server as Server).headersTimeout = 30_000;
for (const sig of ["SIGTERM", "SIGINT"] as const) process.on(sig, () => {
  void ((app as { close?: () => Promise<void> }).close?.() ?? Promise.resolve()).finally(() => server.close(() => process.exit(0)));
});
