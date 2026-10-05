import { Readable, Transform } from "node:stream";
import { XMLParser } from "fast-xml-parser";
import { FsError } from "../fsops.ts";
import { cleanVirtual } from "../paths.ts";
import type { Credentials, SourceBackend, SourceConfig, SourceEntry, SourceStat } from "./types.ts";

const TIMEOUT_MS = 30_000;
const PROPFIND = `<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/><d:getcontentlength/><d:getlastmodified/></d:prop></d:propfind>`;
const parser = new XMLParser({ removeNSPrefix: true, ignoreAttributes: true, parseTagValue: false });

const arr = <T,>(v: T | T[] | undefined): T[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);

/** Map an HTTP status from the server to an FsError without echoing server text. */
export function davError(status: number, what = "request"): FsError {
  if (status === 401) return new FsError(502, "authentication failed");
  if (status === 403) return new FsError(403, "permission denied");
  if (status === 404 || status === 410) return new FsError(404, "not found");
  if (status === 405 || status === 409 || status === 412) return new FsError(409, "already exists or parent missing");
  if (status === 413) return new FsError(413, "too large for the server");
  if (status === 507) return new FsError(507, "no space left on server");
  if (status === 408 || status === 504) return new FsError(504, "remote timed out");
  return new FsError(502, `remote ${what} failed (${status})`);
}

/**
 * WebDAV source (Nextcloud, ownCloud, nginx/Apache dav, rclone serve webdav...).
 * `host` is `host[:port]` (https assumed) or a full URL; `root` is the path of
 * the collection shown as "/". Auth from the Secret: `username` + `password`
 * (basic) or `token` (bearer). PROPFIND is parsed with fast-xml-parser.
 */
export class WebdavBackend implements SourceBackend {
  readonly type = "webdav";
  private readonly origin: string;
  private readonly basePath: string;

  constructor(
    cfg: SourceConfig,
    private readonly creds: () => Promise<Credentials>,
  ) {
    const h = cfg.host.includes("://") ? cfg.host : `https://${cfg.host}`;
    const u = new URL(h);
    this.origin = u.origin;
    const root = cleanVirtual(cfg.root || "/");
    const base = cleanVirtual(u.pathname);
    this.basePath = "/" + [...base, ...root].join("/");
  }

  private url(virtual: string): string {
    const parts = cleanVirtual(virtual);
    const p = (this.basePath === "/" ? "" : this.basePath) + (parts.length ? "/" + parts.map(encodeURIComponent).join("/") : "/");
    return this.origin + p;
  }

  private async req(method: string, url: string, init: { headers?: Record<string, string>; body?: BodyInit | null; signal?: AbortSignal; duplex?: boolean } = {}): Promise<Response> {
    const c = await this.creds();
    const headers: Record<string, string> = { ...init.headers };
    if (c.token) headers.authorization = `Bearer ${c.token}`;
    else if (c.username) headers.authorization = "Basic " + Buffer.from(`${c.username}:${c.password ?? ""}`).toString("base64");
    else throw new FsError(502, "source credentials are missing");
    const signal = init.signal ?? AbortSignal.timeout(TIMEOUT_MS);
    try {
      return await fetch(url, { method, headers, body: init.body ?? null, signal, redirect: "manual", ...(init.duplex ? { duplex: "half" } : {}) } as RequestInit);
    } catch (e) {
      if ((e as Error).name === "TimeoutError") throw new FsError(504, "remote timed out");
      throw new FsError(502, "connection failed");
    }
  }

  private async propfind(virtual: string, depth: 0 | 1): Promise<{ href: string; entry: SourceEntry }[] | null> {
    const r = await this.req("PROPFIND", this.url(virtual), { headers: { depth: String(depth), "content-type": "application/xml" }, body: PROPFIND });
    if (r.status === 404) return null;
    if (r.status !== 207 && r.status !== 200) throw davError(r.status, "listing");
    const doc = parser.parse(await r.text()) as { multistatus?: { response?: unknown } };
    const out: { href: string; entry: SourceEntry }[] = [];
    for (const resp of arr(doc.multistatus?.response as Record<string, unknown> | Record<string, unknown>[] | undefined)) {
      const href = decodeURIComponent(String(resp.href ?? "")).replace(/^https?:\/\/[^/]+/, "");
      // the first propstat with a 2xx status holds the values
      const ps = arr(resp.propstat as Record<string, unknown> | Record<string, unknown>[] | undefined).find((p) => /\s2\d\d\s/.test(String(p.status ?? "")) || p.status === undefined) ?? {};
      const prop = (ps.prop ?? {}) as Record<string, unknown>;
      const isDir = prop.resourcetype !== undefined && typeof prop.resourcetype === "object" && prop.resourcetype !== null && "collection" in (prop.resourcetype as object);
      const mt = prop.getlastmodified ? Date.parse(String(prop.getlastmodified)) : 0;
      out.push({
        href,
        entry: {
          name: "",
          type: isDir ? "dir" : "file",
          size: isDir ? 0 : Number(prop.getcontentlength ?? 0) || 0,
          mtime: Number.isFinite(mt) ? mt : null,
          mode: isDir ? 0o755 : 0o644,
        },
      });
    }
    return out;
  }

  async ping(): Promise<void> {
    const r = await this.propfind("/", 0);
    if (!r) throw new FsError(404, "not found");
  }

  async list(p: string): Promise<SourceEntry[]> {
    const all = await this.propfind(p, 1);
    if (!all) throw new FsError(404, "not found");
    const self = this.url(p).slice(this.origin.length).replace(/\/+$/, "");
    const out: SourceEntry[] = [];
    let sawSelfDir = false;
    for (const { href, entry } of all) {
      const clean = href.replace(/\/+$/, "");
      if (clean === decodeURIComponent(self)) {
        sawSelfDir = entry.type === "dir";
        continue;
      }
      const name = clean.slice(clean.lastIndexOf("/") + 1);
      if (!name) continue;
      out.push({ ...entry, name });
    }
    if (!sawSelfDir && all.length === 1) throw new FsError(400, "not a directory");
    return out;
  }

  async stat(p: string): Promise<SourceStat | null> {
    const r = await this.propfind(p, 0);
    if (!r || !r[0]) return null;
    const { name: _n, ...s } = r[0].entry;
    return s;
  }

  async read(p: string, range?: { start: number; end: number }): Promise<Readable> {
    const r = await this.req("GET", this.url(p), { signal: AbortSignal.timeout(TIMEOUT_MS * 120), headers: range ? { range: `bytes=${range.start}-${range.end}` } : {} });
    if (!r.ok || !r.body) throw davError(r.status, "read");
    let stream = Readable.fromWeb(r.body as never);
    if (range && r.status === 200) {
      // The server ignored Range: skip to the start and stop at the end ourselves.
      let pos = 0;
      stream = stream.pipe(
        new Transform({
          transform(chunk: Buffer, _e, cb) {
            const from = Math.max(0, range.start - pos);
            const to = Math.min(chunk.length, range.end + 1 - pos);
            pos += chunk.length;
            if (to > from) this.push(chunk.subarray(from, to));
            if (pos > range.end) this.push(null);
            cb();
          },
        }),
      );
    }
    return stream;
  }

  async write(p: string, body: Readable, o: { overwrite: boolean; mtime?: number; size?: number }): Promise<number> {
    let n = 0;
    const count = new Transform({
      transform(chunk: Buffer, _e, cb) {
        n += chunk.length;
        cb(null, chunk);
      },
    });
    const headers: Record<string, string> = { "content-type": "application/octet-stream" };
    if (!o.overwrite) headers["if-none-match"] = "*";
    if (o.size !== undefined) headers["content-length"] = String(o.size);
    if (o.mtime && o.mtime > 0) headers["x-oc-mtime"] = String(Math.floor(o.mtime / 1000)); // Nextcloud/ownCloud
    let r: Response;
    try {
      r = await this.req("PUT", this.url(p), { headers, body: Readable.toWeb(body.pipe(count)) as unknown as BodyInit, duplex: true, signal: AbortSignal.timeout(TIMEOUT_MS * 240) });
    } catch (e) {
      body.destroy();
      throw e;
    }
    if (r.status === 412 || (r.status === 405 && !o.overwrite)) throw new FsError(409, "destination exists");
    if (!r.ok) throw davError(r.status, "upload");
    return n;
  }

  async mkdir(p: string): Promise<void> {
    const r = await this.req("MKCOL", this.url(p));
    if (r.status === 405) throw new FsError(409, "already exists");
    if (!r.ok) throw davError(r.status, "mkdir");
  }

  async rename(from: string, to: string, overwrite: boolean): Promise<void> {
    const r = await this.req("MOVE", this.url(from), { headers: { destination: this.url(to), overwrite: overwrite ? "T" : "F" } });
    if (r.status === 412) throw new FsError(409, "destination exists");
    if (!r.ok) throw davError(r.status, "move");
  }

  async remove(p: string, _isDir: boolean): Promise<void> {
    const r = await this.req("DELETE", this.url(p));
    if (!r.ok) throw davError(r.status, "delete");
  }

  async close(): Promise<void> {}
}
