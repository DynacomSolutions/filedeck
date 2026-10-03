import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseBrand, type Brand } from "./brand.ts";
import { parseReadOnly } from "./readonly.ts";
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
  /** compare index: SQLite directory (empty = in memory), inotify watch budget, concurrent directory listings; hub: session spill dir */
  indexDir: string;
  indexWatches: number;
  listConcurrency: number;
  diffDir: string;
  /** search: concurrent searches per agent, per-file and total content bytes read */
  searchConcurrency: number;
  searchMaxFileBytes: number;
  searchMaxBytes: number;
  /** thumbnails: cache dir (outside user data), cache ceiling in bytes, concurrent ffmpeg runs, binary */
  thumbDir: string;
  thumbCacheMax: number;
  thumbConcurrency: number;
  ffmpeg: string;
  /** concurrent on-the-fly media transcodes per agent */
  transcodeConcurrency: number;
  /** hub: name, logos, header links and theme key shown in the page */
  brand: Brand;
  /** agent: virtual path prefixes that are read-only */
  readOnly: string[];
  /** shared hub-to-agent secret; empty = agents are unauthenticated (NetworkPolicy only) */
  agentToken: string | undefined;
  /** hub: name -> agent base URL */
  nodes: { name: string; url: string }[];
  /** hub: network sources (SFTP, ...) declared in the chart values; credentials live in mounted Secrets */
  sources: SourceConfig[];
  sourceSecretDir: string;
  /** hub: saved-password vault. Without `vaultKey` it lives in memory only. */
  vaultFile: string;
  vaultKey: string | undefined;
  vaultTtlMs: number;
  vaultMaxMs: number;
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

/** The vault secret: `FILEDECK_VAULT_KEY`, or the contents of the file named by `FILEDECK_VAULT_KEY_FILE` (a mounted Secret). Never logged. */
function readVaultKey(env: NodeJS.ProcessEnv): string | undefined {
  if (env.FILEDECK_VAULT_KEY) return env.FILEDECK_VAULT_KEY;
  if (env.FILEDECK_VAULT_KEY_FILE) {
    try {
      return readFileSync(env.FILEDECK_VAULT_KEY_FILE, "utf8").trim() || undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
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
    indexDir: env.FILEDECK_INDEX_DIR ?? "",
    indexWatches: Number(env.FILEDECK_INDEX_WATCHES ?? 32768),
    listConcurrency: Number(env.FILEDECK_LIST_CONCURRENCY ?? 16),
    diffDir: env.FILEDECK_DIFF_DIR ?? path.join(os.tmpdir(), `filedeck-diff-${process.pid}`),
    searchConcurrency: Number(env.FILEDECK_SEARCH_CONCURRENCY ?? 2),
    searchMaxFileBytes: Number(env.FILEDECK_SEARCH_MAX_FILE ?? 8 * 1024 * 1024),
    searchMaxBytes: Number(env.FILEDECK_SEARCH_MAX_BYTES ?? 512 * 1024 * 1024),
    thumbDir: env.FILEDECK_THUMB_DIR ?? path.join(os.tmpdir(), "filedeck-thumbs"),
    thumbCacheMax: Number(env.FILEDECK_THUMB_CACHE_MAX ?? 256 * 1024 * 1024),
    thumbConcurrency: Number(env.FILEDECK_THUMB_CONCURRENCY ?? 2),
    ffmpeg: env.FILEDECK_FFMPEG ?? "ffmpeg",
    transcodeConcurrency: Number(env.FILEDECK_TRANSCODE_CONCURRENCY ?? 2),
    brand: parseBrand(env.FILEDECK_BRAND),
    readOnly: parseReadOnly(env.FILEDECK_READONLY),
    agentToken: env.FILEDECK_AGENT_TOKEN || undefined,
    nodes: parseNodes(env.NODES),
    sources: parseSources(env.FILEDECK_SOURCES),
    sourceSecretDir: env.FILEDECK_SOURCE_SECRETS ?? "/var/run/filedeck/sources",
    vaultFile: env.FILEDECK_VAULT_FILE ?? "/var/lib/filedeck-vault/vault.sqlite",
    vaultKey: readVaultKey(env),
    vaultTtlMs: Number(env.FILEDECK_VAULT_TTL_SECONDS ?? 30 * 60) * 1000,
    vaultMaxMs: Number(env.FILEDECK_VAULT_MAX_HOURS ?? 24) * 3600_000,
  };
}
