import { parseSources } from "./sources/registry.ts";
import type { SourceConfig } from "./sources/types.ts";

export interface Config {
  mode: "agent" | "hub";
  port: number;
  root: string;
  node: string;
  procMounts: string;
  maxUpload: number;
  /** Largest text file the editor will open or save (bytes) */
  maxEdit: number;
  staticDir: string;
  /** archive extraction/compression caps and background-job concurrency */
  archiveMaxEntries: number;
  archiveMaxBytes: number;
  jobConcurrency: number;
  /** folder diff: agent-side concurrent hash streams and walk entry ceiling */
  hashConcurrency: number;
  walkMaxEntries: number;
  /** search: concurrent searches per agent, per-file and total content bytes read */
  searchConcurrency: number;
  searchMaxFileBytes: number;
  searchMaxBytes: number;
  /** hub: name -> agent base URL */
  nodes: { name: string; url: string }[];
  /** hub: network sources (SFTP, ...) declared in the chart values; credentials live in mounted Secrets */
  sources: SourceConfig[];
  sourceSecretDir: string;
}

/** NODES="node-a=http://filedeck-agent-node-a:8080,node-b=http://..." */
export function parseNodes(s: string | undefined) {
  return (s ?? "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean)
    .map((x) => {
      const i = x.indexOf("=");
      if (i < 1) throw new Error(`bad NODES entry: ${x}`);
      return { name: x.slice(0, i), url: x.slice(i + 1).replace(/\/$/, "") };
    });
}

export function loadConfig(env = process.env): Config {
  const mode = env.FILEDECK_MODE === "hub" ? "hub" : "agent";
  const root = (env.FILEDECK_ROOT ?? "/host").replace(/\/+$/, "") || "/";
  return {
    mode,
    port: Number(env.PORT ?? 8080),
    root,
    node: env.FILEDECK_NODE ?? "local",
    procMounts: env.FILEDECK_PROC_MOUNTS ?? `${root === "/" ? "" : root}/proc/mounts`,
    maxUpload: Number(env.FILEDECK_MAX_UPLOAD ?? 1024 ** 4),
    maxEdit: Number(env.FILEDECK_MAX_EDIT ?? 5 * 1024 * 1024),
    staticDir: env.FILEDECK_STATIC ?? "/app/web",
    archiveMaxEntries: Number(env.FILEDECK_ARCHIVE_MAX_ENTRIES ?? 1_000_000),
    archiveMaxBytes: Number(env.FILEDECK_ARCHIVE_MAX_BYTES ?? 1024 ** 4),
    jobConcurrency: Number(env.FILEDECK_JOB_CONCURRENCY ?? 2),
    hashConcurrency: Number(env.FILEDECK_HASH_CONCURRENCY ?? 4),
    walkMaxEntries: Number(env.FILEDECK_WALK_MAX_ENTRIES ?? 500_000),
    searchConcurrency: Number(env.FILEDECK_SEARCH_CONCURRENCY ?? 2),
    searchMaxFileBytes: Number(env.FILEDECK_SEARCH_MAX_FILE ?? 8 * 1024 * 1024),
    searchMaxBytes: Number(env.FILEDECK_SEARCH_MAX_BYTES ?? 512 * 1024 * 1024),
    nodes: parseNodes(env.NODES),
    sources: parseSources(env.FILEDECK_SOURCES),
    sourceSecretDir: env.FILEDECK_SOURCE_SECRETS ?? "/var/run/filedeck/sources",
  };
}
