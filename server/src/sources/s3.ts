import { Readable, Transform } from "node:stream";
import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { FsError } from "../fsops.ts";
import { cleanVirtual } from "../paths.ts";
import type { Credentials, SourceBackend, SourceConfig, SourceEntry, SourceStat } from "./types.ts";

const COPY_LIMIT = 5 * 1024 ** 3; // single CopyObject limit; rename of bigger objects is refused

export interface S3Options {
  bucket?: string;
  region?: string;
  /** default true: http(s)://host/bucket/key, which every S3-compatible server accepts */
  forcePathStyle?: boolean;
}

/** Map an SDK error to an FsError without echoing server text, keys or endpoints. */
export function s3Error(e: unknown, what = "request"): FsError {
  if (e instanceof FsError) return e;
  const err = e as { name?: string; $metadata?: { httpStatusCode?: number }; code?: string };
  const status = err.$metadata?.httpStatusCode;
  switch (err.name) {
    case "NoSuchKey":
    case "NotFound":
    case "NoSuchBucket":
      return new FsError(404, "not found");
    case "AccessDenied":
      return new FsError(403, "permission denied");
    case "InvalidAccessKeyId":
    case "SignatureDoesNotMatch":
    case "CredentialsProviderError":
      return new FsError(502, "authentication failed");
    case "PreconditionFailed":
      return new FsError(409, "destination exists");
    case "EntityTooLarge":
      return new FsError(413, "too large for the server");
  }
  if (status === 404) return new FsError(404, "not found");
  if (status === 403) return new FsError(403, "permission denied");
  if (status === 401) return new FsError(502, "authentication failed");
  if (status === 412) return new FsError(409, "destination exists");
  if (status === 408 || status === 504 || err.name === "TimeoutError") return new FsError(504, "remote timed out");
  if (err.code === "ECONNREFUSED" || err.code === "ENOTFOUND" || err.code === "ECONNRESET") return new FsError(502, "connection failed");
  return new FsError(502, `remote ${what} failed`);
}

/**
 * S3-compatible source (AWS S3, MinIO, Ceph RGW, SeaweedFS, R2...). `host` is
 * `host[:port]` (https assumed) or a full URL; `options.bucket` is required and
 * `root` is a key prefix inside it. Folders are key prefixes; an empty folder
 * is a zero-byte `prefix/` marker object. S3 has no rename, so rename is copy
 * + delete (objects up to 5 GiB), and modification times are the upload time.
 * Credentials from the Secret: `accessKeyId`, `secretAccessKey`, optional `token`.
 */
export class S3Backend implements SourceBackend {
  readonly type = "s3";
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly prefix: string; // "" or "a/b/"

  constructor(cfg: SourceConfig, creds: () => Promise<Credentials>) {
    const o = (cfg.options ?? {}) as S3Options;
    if (!o.bucket || typeof o.bucket !== "string") throw new Error(`source ${cfg.name}: options.bucket is required for s3`);
    this.bucket = o.bucket;
    const parts = cleanVirtual(cfg.root || "/");
    this.prefix = parts.length ? parts.join("/") + "/" : "";
    this.client = new S3Client({
      endpoint: cfg.host.includes("://") ? cfg.host : `https://${cfg.host}`,
      region: o.region ?? "us-east-1",
      forcePathStyle: o.forcePathStyle !== false,
      // Only compute checksums when an operation requires them: custom servers often reject the SDK's default trailers.
      requestChecksumCalculation: "WHEN_REQUIRED",
      responseChecksumValidation: "WHEN_REQUIRED",
      maxAttempts: 3,
      requestHandler: { requestTimeout: 0, connectionTimeout: 10_000 } as never,
      credentials: async () => {
        const c = await creds();
        if (!c.accessKeyId || !c.secretAccessKey) throw Object.assign(new Error("missing"), { name: "CredentialsProviderError" });
        return { accessKeyId: c.accessKeyId, secretAccessKey: c.secretAccessKey, ...(c.token ? { sessionToken: c.token } : {}) };
      },
    });
  }

  private key(virtual: string): string {
    return this.prefix + cleanVirtual(virtual).join("/");
  }
  /** key of the folder prefix, always ending in "/" (or "" for the bucket root) */
  private dirKey(virtual: string): string {
    const k = this.key(virtual);
    return k === "" ? "" : k.replace(/\/*$/, "/");
  }

  private async send<T>(fn: () => Promise<T>, what: string): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      throw s3Error(e, what);
    }
  }

  async ping(): Promise<void> {
    await this.send(() => this.client.send(new ListObjectsV2Command({ Bucket: this.bucket, Prefix: this.prefix, MaxKeys: 1 })), "ping");
  }

  async list(p: string): Promise<SourceEntry[]> {
    const prefix = this.dirKey(p);
    const out: SourceEntry[] = [];
    let token: string | undefined;
    do {
      const r = await this.send(
        () => this.client.send(new ListObjectsV2Command({ Bucket: this.bucket, Prefix: prefix, Delimiter: "/", ContinuationToken: token })),
        "listing",
      );
      for (const d of r.CommonPrefixes ?? []) {
        const name = (d.Prefix ?? "").slice(prefix.length).replace(/\/$/, "");
        if (name) out.push({ name, type: "dir", size: 0, mtime: null, mode: 0o755 });
      }
      for (const f of r.Contents ?? []) {
        const name = (f.Key ?? "").slice(prefix.length);
        if (!name || name.endsWith("/")) continue; // the folder's own marker
        out.push({ name, type: "file", size: f.Size ?? 0, mtime: f.LastModified?.getTime() ?? null, mode: 0o644 });
      }
      token = r.IsTruncated ? r.NextContinuationToken : undefined;
    } while (token);
    if (out.length === 0 && p !== "/" && !(await this.stat(p))) throw new FsError(404, "not found");
    return out;
  }

  async stat(p: string): Promise<SourceStat | null> {
    if (cleanVirtual(p).length === 0) return { type: "dir", size: 0, mtime: null, mode: 0o755 };
    try {
      const h = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: this.key(p) }));
      return { type: "file", size: h.ContentLength ?? 0, mtime: h.LastModified?.getTime() ?? null, mode: 0o644 };
    } catch (e) {
      const err = s3Error(e, "stat");
      if (err.status !== 404) throw err;
    }
    const r = await this.send(() => this.client.send(new ListObjectsV2Command({ Bucket: this.bucket, Prefix: this.dirKey(p), MaxKeys: 1 })), "stat");
    return (r.KeyCount ?? r.Contents?.length ?? 0) > 0 ? { type: "dir", size: 0, mtime: null, mode: 0o755 } : null;
  }

  async read(p: string, range?: { start: number; end: number }): Promise<Readable> {
    const r = await this.send(
      () => this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: this.key(p), ...(range ? { Range: `bytes=${range.start}-${range.end}` } : {}) })),
      "read",
    );
    if (!r.Body) throw new FsError(502, "remote read failed");
    return r.Body as Readable;
  }

  async write(p: string, body: Readable, o: { overwrite: boolean; mtime?: number; size?: number }): Promise<number> {
    const key = this.key(p);
    if (!o.overwrite && (await this.stat(p))) {
      body.resume();
      throw new FsError(409, "destination exists");
    }
    let n = 0;
    const count = new Transform({
      transform(chunk: Buffer, _e, cb) {
        n += chunk.length;
        cb(null, chunk);
      },
    });
    const up = new Upload({
      client: this.client,
      params: { Bucket: this.bucket, Key: key, Body: body.pipe(count), ...(o.overwrite ? {} : { IfNoneMatch: "*" }) },
      queueSize: 3,
      partSize: 8 * 1024 * 1024,
      leavePartsOnError: false,
    });
    body.on("error", (e) => count.destroy(e));
    try {
      await up.done();
    } catch (e) {
      await up.abort().catch(() => undefined);
      throw s3Error(e, "upload");
    }
    return n;
  }

  async mkdir(p: string): Promise<void> {
    if (await this.stat(p)) throw new FsError(409, "already exists");
    await this.send(() => this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: this.dirKey(p), Body: "" })), "mkdir");
  }

  async rename(from: string, to: string, overwrite: boolean): Promise<void> {
    const src = await this.stat(from);
    if (!src) throw new FsError(404, "not found");
    const dst = await this.stat(to);
    if (dst && !overwrite) throw new FsError(409, "destination exists");
    if (src.type === "file") {
      await this.copyObject(this.key(from), this.key(to), src.size);
      await this.send(() => this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: this.key(from) })), "delete");
      return;
    }
    if (dst) throw new FsError(409, "destination exists"); // a folder never replaces another entry
    // folder: copy every key below it, then delete the originals (not atomic; a failure leaves both)
    const fromPrefix = this.dirKey(from);
    const toPrefix = this.dirKey(to);
    const keys: { key: string; size: number }[] = [];
    let token: string | undefined;
    do {
      const r = await this.send(() => this.client.send(new ListObjectsV2Command({ Bucket: this.bucket, Prefix: fromPrefix, ContinuationToken: token })), "listing");
      for (const c of r.Contents ?? []) if (c.Key) keys.push({ key: c.Key, size: c.Size ?? 0 });
      token = r.IsTruncated ? r.NextContinuationToken : undefined;
    } while (token);
    for (const k of keys) await this.copyObject(k.key, toPrefix + k.key.slice(fromPrefix.length), k.size);
    // children before their folder markers (S3 itself does not care, S3 gateways over a file system do)
    for (const k of keys.sort((a, b) => (a.key < b.key ? 1 : -1))) await this.send(() => this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: k.key })), "delete");
  }

  private async copyObject(from: string, to: string, size: number): Promise<void> {
    if (size > COPY_LIMIT) throw new FsError(413, "object too large to rename on S3");
    const src = `${this.bucket}/${from.split("/").map(encodeURIComponent).join("/")}`;
    await this.send(() => this.client.send(new CopyObjectCommand({ Bucket: this.bucket, Key: to, CopySource: src })), "copy");
  }

  async remove(p: string, isDir: boolean): Promise<void> {
    await this.send(() => this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: isDir ? this.dirKey(p) : this.key(p) })), "delete");
  }

  async close(): Promise<void> {
    this.client.destroy();
  }
}
