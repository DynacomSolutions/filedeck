import { Hono, type Context } from "hono";
import { createHash } from "node:crypto";
import { Readable, Transform } from "node:stream";
import path from "node:path";
import * as ops from "../fsops.ts";
import { FsError, MAX_LIST, mimeFor, parseRange, type Entry } from "../fsops.ts";
import { cleanVirtual, virtualJoin } from "../paths.ts";
import { compileGlobs } from "../glob.ts";
import { Semaphore, type WalkEntry, type WalkOpts, type WalkSummary } from "../walk.ts";
import { walkResponse } from "../diff-routes.ts";
import { IndexCache, type IdxEntry } from "../index-cache.ts";
import { THUMB_MAX_IMAGE_BYTES, thumbKind, thumbResponse, type Thumbnailer } from "../thumbs.ts";
import { SearchGate, parseSearch, searchTree } from "../search.ts";
import type { SourceBackend, SourceEntry, SourceStat } from "./types.ts";

const SAFE_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Content-Security-Policy": "sandbox; default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'",
};
const dispo = (name: string) => {
  const ascii = name.replace(/[^\x20-\x7e]|["\\]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
};
const int = (v: string | undefined, d: number, lo: number, hi: number) => {
  const n = v === undefined || v === "" ? d : Number(v);
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, Math.floor(n))) : d;
};
const norm = (p: string) => "/" + cleanVirtual(p).join("/");
const base = (p: string) => path.posix.basename(p);
const dirOf = (p: string) => path.posix.dirname(p);
/** Network mtimes are often whole seconds, so the etag is a content hash (text files are small). */
const etagOfBytes = (b: Buffer) => createHash("sha256").update(b).digest("hex").slice(0, 24);

function toEntry(dir: string, e: SourceEntry): Entry {
  return {
    name: e.name,
    path: virtualJoin(dir, e.name),
    type: e.type,
    size: e.size,
    mtime: e.mtime,
    mode: e.mode,
    ...(e.linkDir !== undefined ? { linkDir: e.linkDir } : {}),
  };
}

export interface SourceAppOptions {
  maxUpload: number;
  maxEdit: number;
  hashConcurrency: number;
  walkMaxEntries: number;
  searchConcurrency?: number;
  searchMaxFileBytes?: number;
  searchMaxBytes?: number;
  /** SQLite file for this source's compare index (listings revalidated by directory mtime, hashes by size + mtime); empty = in memory */
  indexFile?: string;
  /** image thumbnails for the SPA grid (videos need a seekable file, so they have none on sources) */
  thumbs?: Thumbnailer;
}

const DIR_STAT: SourceStat = { type: "dir", size: 0, mtime: 0, mode: 0o755 };

/**
 * Exposes one network backend with the agents' HTTP surface, so the hub can
 * serve it under /api/nodes/<name>/... and the SPA, folder diff and cross-node
 * transfer treat it like any node. No trash: removal is permanent.
 */
export function createSourceApp(name: string, backend: SourceBackend, o: SourceAppOptions) {
  const app = new Hono();
  const hashes = new Semaphore(Math.max(1, o.hashConcurrency));
  const index = new IndexCache(o.indexFile || ":memory:", {
    async statDir(p) {
      const s = p === "/" ? DIR_STAT : await backend.stat(p);
      if (!s) throw new FsError(404, "not found");
      if (s.type !== "dir") throw new FsError(400, "not a directory");
      return { ino: 0, mtime: s.mtime };
    },
    async readDir(p) {
      return (await backend.list(p))
        .filter((it) => it.name !== "." && it.name !== "..")
        .map((it): IdxEntry => ({ n: it.name, t: it.type, s: it.type === "dir" ? 0 : it.size, m: Math.floor(it.mtime), i: 0 }));
    },
  }, { ttlMs: 10 * 60_000 });

  // Anything this app writes makes the stored listings of this source untrustworthy (mtimes on network shares are coarse).
  app.use("*", async (c, next) => {
    if (c.req.method !== "GET" && c.req.method !== "HEAD") index.invalidateListings(true);
    await next();
    if (c.req.method !== "GET" && c.req.method !== "HEAD") index.invalidateListings(true);
  });

  app.onError((e, c) => {
    const { status, message } = ops.mapError(e);
    if (status === 500) console.error(`source ${name} error`, (e as Error)?.name);
    return c.json({ error: message }, status as 400);
  });

  const need = async (p: string): Promise<SourceStat> => {
    if (p === "/") return DIR_STAT;
    const s = await backend.stat(p);
    if (!s) throw new FsError(404, "not found");
    return s;
  };
  const mustDir = async (p: string) => {
    if ((await need(p)).type !== "dir") throw new FsError(400, "not a directory");
  };

  app.get("/healthz", (c) => c.text("ok"));
  app.get("/api/info", (c) => c.json({ node: name, root: "/", source: backend.type }));
  app.get("/api/mounts", (c) => c.json({ mounts: [] }));
  app.get("/api/jobs", (c) => c.json({ jobs: [] }));

  app.get("/api/fs/list", async (c) => {
    const p = norm(c.req.query("path") ?? "/");
    const hidden = c.req.query("hidden") === "1";
    const raw = await backend.list(p);
    const visible = raw.filter((e) => e.name !== "." && e.name !== ".." && !e.name.includes("/") && (hidden || !e.name.startsWith(".")));
    return c.json({ path: p, entries: visible.slice(0, MAX_LIST).map((e) => toEntry(p, e)), truncated: visible.length > MAX_LIST });
  });

  app.get("/api/fs/stat", async (c) => {
    const p = norm(c.req.query("path") ?? "/");
    const s = await need(p);
    const e: Entry = { name: p === "/" ? "" : base(p), path: p, type: s.type, size: s.size, mtime: s.mtime, mode: s.mode };
    return c.json(e);
  });

  const serve = async (c: Context, download: boolean) => {
    const p = norm(c.req.query("path") ?? "");
    const s = await need(p);
    if (s.type === "dir") throw new FsError(400, "is a directory");
    if (s.type !== "file") throw new FsError(400, "not a regular file");
    const headers: Record<string, string> = {
      ...SAFE_HEADERS,
      "Content-Type": mimeFor(p),
      "Accept-Ranges": "bytes",
      "Last-Modified": new Date(s.mtime || 0).toUTCString(),
      "Content-Disposition": download ? dispo(base(p)) : "inline",
    };
    const range = parseRange(c.req.header("range"), s.size);
    if (range === "invalid") return new Response(null, { status: 416, headers: { ...headers, "Content-Range": `bytes */${s.size}` } });
    if (c.req.method === "HEAD") return new Response(null, { status: 200, headers: { ...headers, "Content-Length": String(s.size) } });
    if (s.size === 0) return new Response(null, { status: 200, headers: { ...headers, "Content-Length": "0" } });
    const stream = await backend.read(p, range ?? undefined);
    c.req.raw.signal.addEventListener("abort", () => stream.destroy(), { once: true });
    const body = Readable.toWeb(stream) as ReadableStream;
    if (range) {
      return new Response(body, {
        status: 206,
        headers: { ...headers, "Content-Length": String(range.end - range.start + 1), "Content-Range": `bytes ${range.start}-${range.end}/${s.size}` },
      });
    }
    return new Response(body, { status: 200, headers: { ...headers, "Content-Length": String(s.size) } });
  };
  app.on(["GET", "HEAD"], "/api/fs/read", (c) => serve(c, false));
  app.on(["GET", "HEAD"], "/api/fs/download", (c) => serve(c, true));

  async function slurp(p: string, max: number): Promise<Buffer> {
    const stream = await backend.read(p);
    const chunks: Buffer[] = [];
    let n = 0;
    for await (const ch of stream as AsyncIterable<Buffer>) {
      n += ch.length;
      if (n > max) {
        stream.destroy();
        throw new FsError(413, "file too large to edit");
      }
      chunks.push(ch);
    }
    return Buffer.concat(chunks);
  }
  const assertText = (buf: Buffer) => {
    if (buf.subarray(0, 8192).includes(0)) throw new FsError(415, "binary file");
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(buf);
    } catch {
      throw new FsError(415, "file is not valid UTF-8 text");
    }
  };

  app.get("/api/fs/text", async (c) => {
    const p = norm(c.req.query("path") ?? "");
    const s = await need(p);
    if (s.type !== "file") throw new FsError(400, s.type === "dir" ? "is a directory" : "not a regular file");
    if (s.size > o.maxEdit) throw new FsError(413, "file too large to edit");
    const buf = await slurp(p, o.maxEdit);
    assertText(buf);
    return c.json({ path: p, content: buf.toString("utf8"), size: buf.length, mtime: s.mtime, etag: etagOfBytes(buf) });
  });

  app.put("/api/fs/write", async (c) => {
    const ifMatch = c.req.header("if-match");
    const create = c.req.query("create") === "1";
    if (!create && !ifMatch) throw new FsError(428, "If-Match header required");
    const p = norm(c.req.query("path") ?? "");
    if (p === "/") throw new FsError(400, "is a directory");
    const buf = Buffer.from(await c.req.arrayBuffer());
    if (buf.length > o.maxEdit) throw new FsError(413, "content too large");
    assertText(buf);
    const cur = await backend.stat(p);
    if (cur && cur.type !== "file") throw new FsError(400, cur.type === "dir" ? "is a directory" : "not a regular file");
    const have = cur ? etagOfBytes(await slurp(p, o.maxEdit)) : null;
    if (create) {
      if (cur) return c.json({ error: "file already exists", etag: have, mtime: cur.mtime }, 409);
    } else {
      if (!cur) throw new FsError(404, "not found");
      if (have !== ifMatch) return c.json({ error: "file changed on disk since it was opened", etag: have, mtime: cur.mtime }, 409);
    }
    await backend.write(p, Readable.from([buf]), { overwrite: !create, size: buf.length });
    const st = await need(p);
    return c.json({ path: p, size: st.size, mtime: st.mtime, etag: etagOfBytes(buf) });
  });

  app.put("/api/fs/upload", async (c) => {
    const body = c.req.raw.body;
    if (!body) return c.json({ error: "empty body" }, 400);
    const dir = norm(c.req.query("dir") ?? "/");
    const target = virtualJoin(dir, c.req.query("name") ?? "");
    await mustDir(dir);
    let n = 0;
    const stream = Readable.fromWeb(body as never).pipe(
      new Transform({
        transform(ch: Buffer, _e, cb) {
          n += ch.length;
          cb(n > o.maxUpload ? new FsError(413, "upload too large") : null, ch);
        },
      }),
    );
    const mt = c.req.query("mtime") ? Number(c.req.query("mtime")) : undefined;
    const len = Number(c.req.header("content-length"));
    const size = await backend.write(target, stream, {
      overwrite: c.req.query("overwrite") === "1",
      ...(mt !== undefined ? { mtime: mt } : {}),
      ...(Number.isFinite(len) && c.req.header("content-length") ? { size: len } : {}),
    });
    return c.json({ path: target, size }, 201);
  });

  // Network sources have no append-in-place, so resumable chunked uploads are an agent feature; clients fall back to a streamed PUT.
  app.all("/api/upload/*", (c) => c.json({ error: "chunked upload is not supported on network sources" }, 501));

  const json = async <T,>(c: Context): Promise<T> => {
    try {
      return (await c.req.json()) as T;
    } catch {
      throw new FsError(400, "invalid JSON body");
    }
  };
  const str = (v: unknown, what: string): string => {
    if (typeof v !== "string") throw new FsError(400, `${what} must be a string`);
    return v;
  };
  const strs = (v: unknown): string[] => {
    if (!Array.isArray(v) || v.length === 0 || v.length > 10000 || v.some((x) => typeof x !== "string")) {
      throw new FsError(400, "paths must be a non-empty array of strings");
    }
    return v as string[];
  };

  app.post("/api/fs/mkdir", async (c) => {
    const p = norm(str((await json<{ path: string }>(c)).path, "path"));
    if (p === "/") throw new FsError(409, "already exists");
    await mustDir(dirOf(p));
    await backend.mkdir(p);
    return c.json({ path: p }, 201);
  });

  const rename = async (from: string, to: string, overwrite: boolean) => {
    const a = norm(from);
    const b = norm(to);
    if (a === "/" || b === "/") throw new FsError(400, "cannot move root");
    if (a === b) return b;
    if (b.startsWith(a + "/")) throw new FsError(400, "cannot move into itself");
    await need(a);
    await mustDir(dirOf(b));
    await backend.rename(a, b, overwrite);
    return b;
  };
  app.post("/api/fs/rename", async (c) => {
    const b = await json<{ from: string; to: string; overwrite?: boolean }>(c);
    return c.json({ path: await rename(str(b.from, "from"), str(b.to, "to"), b.overwrite === true) });
  });
  app.post("/api/fs/move", async (c) => {
    const b = await json<{ from: string[]; toDir: string }>(c);
    const dir = norm(str(b.toDir, "toDir"));
    await mustDir(dir);
    const results = [];
    for (const f of strs(b.from)) results.push(await rename(f, virtualJoin(dir, base(norm(f))), false));
    return c.json({ paths: results });
  });

  async function removeTree(p: string, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw new FsError(400, "canceled");
    const s = await need(p);
    if (s.type === "dir") {
      for (const e of await backend.list(p)) if (e.name !== "." && e.name !== "..") await removeTree(virtualJoin(p, e.name), signal);
      await backend.remove(p, true);
    } else {
      await backend.remove(p, false);
    }
  }

  async function copyTree(from: string, to: string, overwrite: boolean): Promise<void> {
    const s = await need(from);
    if (s.type === "dir") {
      await backend.mkdir(to);
      for (const e of await backend.list(from)) {
        if (e.name === "." || e.name === "..") continue;
        await copyTree(virtualJoin(from, e.name), virtualJoin(to, e.name), overwrite);
      }
    } else if (s.type === "file") {
      const rs = s.size === 0 ? Readable.from([]) : await backend.read(from);
      await backend.write(to, rs, { overwrite, mtime: s.mtime, size: s.size });
    }
    // symlinks and special files are not copied
  }

  async function uniqueName(dir: string, name: string): Promise<string> {
    if (!(await backend.stat(virtualJoin(dir, name)))) return name;
    const dot = name.lastIndexOf(".");
    const [b, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
    for (let i = 1; i < 10000; i++) {
      const cand = `${b} (copy${i > 1 ? " " + i : ""})${ext}`;
      if (!(await backend.stat(virtualJoin(dir, cand)))) return cand;
    }
    throw new FsError(409, "cannot find a free name");
  }

  app.post("/api/fs/copy", async (c) => {
    const b = await json<{ from: string[]; toDir: string; overwrite?: boolean }>(c);
    const dir = norm(str(b.toDir, "toDir"));
    await mustDir(dir);
    const results = [];
    for (const f of strs(b.from)) {
      const a = norm(f);
      if (a === "/") throw new FsError(400, "cannot copy root");
      if (dir === a || dir.startsWith(a + "/")) throw new FsError(400, "cannot copy into itself");
      const src = await need(a);
      let name = base(a);
      if (b.overwrite === true) {
        const dest = virtualJoin(dir, name);
        if (dest === a) throw new FsError(400, "source and destination are the same");
        const cur = await backend.stat(dest);
        // Copy beside the destination, then swap: a failed copy never damages what is there.
        const tmp = virtualJoin(dir, `.${name}.filedeck-part-${Date.now().toString(36)}`);
        try {
          await copyTree(a, tmp, false);
          if (cur && !(src.type === "file" && cur.type === "file")) await removeTree(dest);
          await backend.rename(tmp, dest, cur?.type === "file" && src.type === "file");
        } catch (e) {
          await removeTree(tmp).catch(() => undefined);
          throw e;
        }
      } else {
        name = await uniqueName(dir, name);
        await copyTree(a, virtualJoin(dir, name), false);
      }
      results.push(virtualJoin(dir, name));
    }
    return c.json({ paths: results });
  });

  app.post("/api/fs/trash", () => {
    throw new FsError(409, "network sources have no trash; use delete");
  });
  app.post("/api/fs/delete", async (c) => {
    const b = await json<{ paths: string[] }>(c);
    for (const f of strs(b.paths)) {
      const p = norm(f);
      if (p === "/") throw new FsError(400, "cannot delete root");
      await removeTree(p, c.req.raw.signal);
    }
    return c.json({ ok: true });
  });

  app.get("/api/fs/hash", async (c) => {
    const signal = c.req.raw.signal;
    const p = norm(c.req.query("path") ?? "");
    const r = await hashes.run(async () => {
      const s = await need(p);
      if (s.type === "dir") throw new FsError(400, "is a directory");
      if (s.type !== "file") throw new FsError(400, "not a regular file");
      const got = await index.hash(p, { size: s.size, mtime: Math.floor(s.mtime), ino: 0 }, async () => {
        const h = createHash("sha256");
        if (s.size > 0) {
          const stream = await backend.read(p);
          signal.addEventListener("abort", () => stream.destroy(), { once: true });
          for await (const ch of stream as AsyncIterable<Buffer>) h.update(ch);
        }
        return h.digest("hex");
      });
      return { path: p, size: s.size, mtime: Math.floor(s.mtime), sha256: got.sha256, cached: got.cached };
    }, signal);
    return c.json(r);
  });

  async function* walk(start: string, w: WalkOpts, signal: AbortSignal): AsyncGenerator<WalkEntry[], WalkSummary> {
    await mustDir(start);
    const exclude = compileGlobs(w.exclude, w.ignoreCase);
    const include = w.include.length ? compileGlobs(w.include, w.ignoreCase) : null;
    const summary: WalkSummary = { truncated: false, depthLimited: false, errors: 0 };
    let total = 0;
    const stack: { virtual: string; rel: string; depth: number }[] = [{ virtual: start, rel: "", depth: 1 }];
    while (stack.length) {
      if (signal.aborted) throw new FsError(400, "canceled");
      const dir = stack.pop() as (typeof stack)[number];
      let items: SourceEntry[];
      try {
        items = await backend.list(dir.virtual);
      } catch {
        summary.errors++;
        continue;
      }
      items.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      const out: WalkEntry[] = [];
      const subdirs: typeof stack = [];
      for (const it of items) {
        if (it.name === "." || it.name === ".." || (!w.hidden && it.name.startsWith("."))) continue;
        const rel = dir.rel ? `${dir.rel}/${it.name}` : it.name;
        const isDir = it.type === "dir";
        if (exclude.test(rel, isDir)) continue;
        if (!isDir && include && !include.test(rel, false)) continue;
        if (total >= w.max) {
          summary.truncated = true;
          break;
        }
        total++;
        out.push({ p: rel, t: it.type, s: isDir ? 0 : it.size, m: Math.floor(it.mtime) });
        if (isDir) {
          if (dir.depth < w.depth) subdirs.push({ virtual: virtualJoin(dir.virtual, it.name), rel, depth: dir.depth + 1 });
          else summary.depthLimited = true;
        }
      }
      for (let i = 0; i < out.length; i += 500) yield out.slice(i, i + 500);
      if (summary.truncated) break;
      for (const d of subdirs.reverse()) stack.push(d);
    }
    return summary;
  }
  app.get("/api/fs/lsdir", async (c) => {
    const p = norm(c.req.query("path") ?? "/");
    const out = await index.list(p);
    return c.json({ path: p, cached: out.cached, entries: out.entries });
  });
  app.get("/api/fs/index-changes", (c) => c.json({ seq: 0, reset: false, dirs: [] }));
  app.get("/api/fs/index-stats", (c) => c.json({ enabled: index.enabled, ...index.stats }));

  app.get("/api/fs/walk", async (c) => {
    const q = c.req.query.bind(c.req);
    const opts: WalkOpts = {
      hidden: q("hidden") === "1",
      depth: int(q("depth"), 32, 1, 64),
      max: int(q("max"), 100_000, 1, o.walkMaxEntries),
      include: (c.req.queries("include") ?? []).slice(0, 100),
      exclude: (c.req.queries("exclude") ?? []).slice(0, 100),
      ignoreCase: q("ignoreCase") === "1",
    };
    return walkResponse(walk(norm(q("path") ?? "/"), opts, c.req.raw.signal));
  });

  app.get("/api/fs/thumb", async (c) => {
    const p = norm(c.req.query("path") ?? "");
    const s = await need(p);
    if (s.type !== "file") throw new FsError(400, "not a regular file");
    if (!o.thumbs || thumbKind(base(p)) !== "image") throw new FsError(415, "no thumbnail for this type");
    if (s.size > THUMB_MAX_IMAGE_BYTES) throw new FsError(413, "image too large for a thumbnail");
    const t = await o.thumbs.get(
      `src:${name}\0${p}\0${s.mtime}\0${s.size}`,
      "image",
      async () => ({ input: { stream: await backend.read(p) }, close: () => undefined }),
      c.req.raw.signal,
    );
    return thumbResponse(t);
  });

  const searches = new SearchGate(o.searchConcurrency ?? 2);
  app.get("/api/fs/search", async (c) => {
    const q = c.req.query.bind(c.req);
    const p = parseSearch(q, { searchMaxFileBytes: o.searchMaxFileBytes ?? 8 * 1024 * 1024, searchMaxBytes: o.searchMaxBytes ?? 256 * 1024 * 1024 });
    const start = norm(q("path") ?? "/");
    const signal = c.req.raw.signal;
    const w = walk(start, { hidden: p.hidden, depth: p.depth, max: Math.min(p.maxEntries, o.walkMaxEntries), include: [], exclude: [], ignoreCase: false }, signal);
    return walkResponse(searches.wrap(searchTree(w, p, (rel) => backend.read((start === "/" ? "" : start) + "/" + rel), signal)));
  });

  // Archive jobs and live change events need local disk access; the SPA gets a clear answer.
  app.all("/api/archive/*", (c) => c.json({ error: "not supported on network sources" }, 501));
  app.all("/api/jobs/*", (c) => c.json({ error: "not supported on network sources" }, 501));
  app.get("/api/events", (c) => c.json({ error: "not supported on network sources" }, 501));
  app.get("/api/fs/zip", (c) => c.json({ error: "not supported on network sources" }, 501));
  return app;
}
