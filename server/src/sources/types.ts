import type { Readable } from "node:stream";

/** One entry as a network backend reports it (no symlink resolution beyond what the protocol gives). */
export interface SourceStat {
  type: "file" | "dir" | "symlink" | "other";
  size: number;
  /** milliseconds since the epoch */
  mtime: number;
  mode: number;
}
export interface SourceEntry extends SourceStat {
  name: string;
  /** for symlinks: whether the target is a directory */
  linkDir?: boolean;
}

/**
 * What a network backend (SFTP, WebDAV, SMB, S3) has to provide. Paths are the
 * same virtual, "/"-rooted, `..`-free paths the agents use; the backend maps
 * them under its configured root. Everything else the agents offer (copy,
 * move, recursive delete, walk, hash, text edit, range responses) is derived
 * from these primitives by `source-app.ts`, so a backend stays small.
 *
 * Errors are `FsError`s (404 missing, 409 exists, 403 denied, 502 remote
 * failure, 504 timeout). Messages never contain credentials or hostnames.
 */
export interface SourceBackend {
  readonly type: string;
  /** Cheap reachability + auth check (used for the online dot). Throws when down. */
  ping(): Promise<void>;
  list(path: string): Promise<SourceEntry[]>;
  /** Missing -> null. Never follows a final symlink. */
  stat(path: string): Promise<SourceStat | null>;
  /** Inclusive byte range when given. */
  read(path: string, range?: { start: number; end: number }): Promise<Readable>;
  /**
   * Create or replace one file from a stream. Without `overwrite` an existing
   * target is an error (409). Should not leave a partial file at the target
   * name when the stream fails. Returns the bytes written.
   */
  write(path: string, body: Readable, o: { overwrite: boolean; mtime?: number; /** total bytes when known (some servers refuse chunked uploads) */ size?: number }): Promise<number>;
  mkdir(path: string): Promise<void>;
  /** Rename or move one entry within the source. */
  rename(from: string, to: string, overwrite: boolean): Promise<void>;
  /** Remove one file (or one EMPTY directory). Recursion is the caller's job. */
  remove(path: string, isDir: boolean): Promise<void>;
  close(): Promise<void>;
}

/** Declarative description of one source, from the chart values (never holds secrets). */
export interface SourceConfig {
  name: string;
  type: string;
  host: string;
  root: string;
  /** name of the Kubernetes Secret mounted for this source; its files hold the credentials */
  secretRef?: string;
  options?: Record<string, unknown>;
}

/** Credentials read from the mounted Secret at connect time; never logged or returned by the API. */
export type Credentials = Record<string, string>;
