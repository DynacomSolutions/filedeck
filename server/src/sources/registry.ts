import fs from "node:fs/promises";
import path from "node:path";
import type { Config } from "../config.ts";
import { SftpBackend } from "./sftp.ts";
import { WebdavBackend } from "./webdav.ts";
import { S3Backend } from "./s3.ts";
import { SmbBackend } from "./smb.ts";
import type { Credentials, SourceBackend, SourceConfig } from "./types.ts";

const NAME = /^[a-z0-9][a-z0-9-]{0,31}$/;
/** Files in a source's Secret that are credentials; each becomes a key of Credentials. */
const CRED_FILES = ["username", "password", "privateKey", "passphrase", "accessKeyId", "secretAccessKey", "domain", "token"];
/** Single-line values lose a trailing newline (secrets created from files often carry one); keys keep theirs. */
const MULTILINE = new Set(["privateKey"]);

export function parseSources(raw: string | undefined): SourceConfig[] {
  if (!raw || !raw.trim()) return [];
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    throw new Error("FILEDECK_SOURCES is not valid JSON");
  }
  if (!Array.isArray(v)) throw new Error("FILEDECK_SOURCES must be a JSON array");
  const seen = new Set<string>();
  return v.map((x, i) => {
    const o = x as Partial<SourceConfig> | null;
    if (!o || typeof o.name !== "string" || !NAME.test(o.name)) throw new Error(`source #${i}: name must match ${NAME}`);
    if (seen.has(o.name)) throw new Error(`duplicate source name ${o.name}`);
    seen.add(o.name);
    if (typeof o.type !== "string" || typeof o.host !== "string" || !o.host) throw new Error(`source ${o.name}: type and host are required`);
    if (o.root !== undefined && (typeof o.root !== "string" || !o.root.startsWith("/"))) throw new Error(`source ${o.name}: root must be an absolute path`);
    if (o.secretRef !== undefined && (typeof o.secretRef !== "string" || !/^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$/.test(o.secretRef))) {
      throw new Error(`source ${o.name}: secretRef must be a Secret name`);
    }
    return { name: o.name, type: o.type, host: o.host, root: o.root ?? "/", ...(o.secretRef ? { secretRef: o.secretRef } : {}), options: o.options ?? {} };
  });
}

/** Reads the credential files the chart mounts at <dir>/<source>/ (a Secret volume); re-read on every connect. */
export function credentialLoader(dir: string, name: string): () => Promise<Credentials> {
  return async () => {
    const out: Credentials = {};
    for (const f of CRED_FILES) {
      try {
        const t = await fs.readFile(path.join(dir, name, f), "utf8");
        out[f] = MULTILINE.has(f) ? t : t.replace(/\r?\n$/, "");
      } catch {
        /* key not present in the Secret */
      }
    }
    return out;
  };
}

export function createBackend(sc: SourceConfig, creds: () => Promise<Credentials>): SourceBackend {
  switch (sc.type) {
    case "sftp":
      return new SftpBackend(sc, creds);
    case "webdav":
      return new WebdavBackend(sc, creds);
    case "s3":
      return new S3Backend(sc, creds);
    case "smb":
      return new SmbBackend(sc, creds);
    default:
      throw new Error(`source ${sc.name}: unsupported type ${JSON.stringify(sc.type)}`);
  }
}

export interface SourceEntryInfo {
  config: SourceConfig;
  backend: SourceBackend;
}

export function buildSources(cfg: Pick<Config, "sources" | "sourceSecretDir">): Map<string, SourceEntryInfo> {
  const m = new Map<string, SourceEntryInfo>();
  for (const sc of cfg.sources) m.set(sc.name, { config: sc, backend: createBackend(sc, credentialLoader(cfg.sourceSecretDir, sc.name)) });
  return m;
}
