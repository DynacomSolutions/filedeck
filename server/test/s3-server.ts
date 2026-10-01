import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import type { AddressInfo } from "node:net";

export interface TestS3 {
  port: number;
  close(): Promise<void>;
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");

/**
 * Minimal path-style S3 over a local directory: `<root>/<bucket>/<key>` (keys ending in "/" are folders).
 * Supports ListObjectsV2 (prefix, delimiter, pagination), Get (Range), Head, Put (If-None-Match), Copy, Delete.
 * Only the access key id is checked (not the signature).
 */
export async function startS3(root: string, bucket: string, accessKeyId: string): Promise<TestS3> {
  const xml = (res: http.ServerResponse, code: number, body: string) => {
    res.writeHead(code, { "content-type": "application/xml" });
    res.end(`<?xml version="1.0" encoding="UTF-8"?>${body}`);
  };
  const err = (res: http.ServerResponse, code: number, name: string) => xml(res, code, `<Error><Code>${name}</Code><Message>x</Message></Error>`);
  const lastMod = (st: fs.Stats) => st.mtime.toISOString();

  const server = http.createServer((req, res) => {
    const auth = String(req.headers.authorization ?? "");
    if (!auth.includes(`Credential=${accessKeyId}/`)) {
      req.resume();
      return err(res, 403, "InvalidAccessKeyId");
    }
    const u = new URL(req.url ?? "/", "http://x");
    const segs = u.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    if (segs[0] !== bucket) {
      req.resume();
      return err(res, 404, "NoSuchBucket");
    }
    const key = segs.slice(1).join("/") + (u.pathname.endsWith("/") && segs.length > 1 ? "/" : "");
    const isDirKey = key.endsWith("/");
    const real = path.join(root, bucket, key);
    if (!(real === path.join(root, bucket) || real.startsWith(path.join(root, bucket) + path.sep))) return err(res, 403, "AccessDenied");
    const m = req.method ?? "";

    if (m === "GET" && segs.length === 1 && u.searchParams.get("list-type") === "2") {
      const prefix = u.searchParams.get("prefix") ?? "";
      const delim = u.searchParams.get("delimiter");
      const max = Number(u.searchParams.get("max-keys") ?? 1000);
      const after = u.searchParams.get("continuation-token") ?? "";
      // flatten the disk tree to keys
      const all: { key: string; st: fs.Stats }[] = [];
      const walk = (dir: string, rel: string) => {
        for (const n of fs.readdirSync(dir).sort()) {
          const st = fs.statSync(path.join(dir, n));
          if (n.endsWith(".s3part")) continue;
          if (st.isDirectory()) {
            all.push({ key: rel + n + "/", st });
            walk(path.join(dir, n), rel + n + "/");
          } else all.push({ key: rel + n, st });
        }
      };
      walk(path.join(root, bucket), "");
      all.sort((a, b) => (a.key < b.key ? -1 : 1));
      const contents: { key: string; st: fs.Stats }[] = [];
      const prefixes = new Set<string>();
      for (const e of all) {
        if (!e.key.startsWith(prefix)) continue;
        const rest = e.key.slice(prefix.length);
        if (delim && rest.includes(delim)) prefixes.add(prefix + rest.slice(0, rest.indexOf(delim) + 1));
        else if (e.key > after) contents.push(e);
      }
      const page = contents.slice(0, max);
      const truncated = contents.length > max;
      let body = `<ListBucketResult><Name>${bucket}</Name><Prefix>${esc(prefix)}</Prefix><KeyCount>${page.length + prefixes.size}</KeyCount><IsTruncated>${truncated}</IsTruncated>`;
      if (truncated) body += `<NextContinuationToken>${esc(page[page.length - 1]!.key)}</NextContinuationToken>`;
      for (const c of page) body += `<Contents><Key>${esc(c.key)}</Key><LastModified>${lastMod(c.st)}</LastModified><Size>${c.st.isDirectory() ? 0 : c.st.size}</Size></Contents>`;
      if (!truncated) for (const p of [...prefixes].sort()) body += `<CommonPrefixes><Prefix>${esc(p)}</Prefix></CommonPrefixes>`;
      return xml(res, 200, body + "</ListBucketResult>");
    }

    try {
      if (m === "GET" || m === "HEAD") {
        let st: fs.Stats;
        try {
          st = fs.statSync(real);
        } catch {
          return err(res, 404, m === "HEAD" ? "NotFound" : "NoSuchKey");
        }
        if (st.isDirectory() && !isDirKey) return err(res, 404, m === "HEAD" ? "NotFound" : "NoSuchKey");
        const h = { "last-modified": st.mtime.toUTCString(), "accept-ranges": "bytes", etag: '"x"' };
        const r = /^bytes=(\d+)-(\d+)$/.exec(String(req.headers.range ?? ""));
        if (r && m === "GET") {
          const [s, e] = [Number(r[1]), Math.min(Number(r[2]), st.size - 1)];
          res.writeHead(206, { ...h, "content-length": e - s + 1, "content-range": `bytes ${s}-${e}/${st.size}` });
          return fs.createReadStream(real, { start: s, end: e }).pipe(res);
        }
        res.writeHead(200, { ...h, "content-length": st.size });
        return m === "HEAD" ? res.end() : fs.createReadStream(real).pipe(res);
      }
      if (m === "PUT") {
        const copySrc = req.headers["x-amz-copy-source"];
        if (copySrc) {
          req.resume();
          const src = path.join(root, decodeURIComponent(String(copySrc).replace(/^\//, "")));
          if (!fs.existsSync(src)) return err(res, 404, "NoSuchKey");
          fs.mkdirSync(path.dirname(real), { recursive: true });
          if (fs.statSync(src).isDirectory()) fs.mkdirSync(real, { recursive: true });
          else fs.copyFileSync(src, real);
          return xml(res, 200, `<CopyObjectResult><ETag>"x"</ETag><LastModified>${new Date().toISOString()}</LastModified></CopyObjectResult>`);
        }
        if (req.headers["if-none-match"] === "*" && fs.existsSync(real)) {
          req.resume();
          return err(res, 412, "PreconditionFailed");
        }
        if (isDirKey) {
          req.resume();
          fs.mkdirSync(real, { recursive: true });
          res.writeHead(200, { etag: '"x"' });
          return res.end();
        }
        fs.mkdirSync(path.dirname(real), { recursive: true });
        const tmp = real + ".s3part";
        const out = fs.createWriteStream(tmp);
        // The SDK may send aws-chunked bodies; the tests keep to plain payloads (WHEN_REQUIRED checksums).
        req.pipe(out);
        out.on("finish", () => {
          fs.renameSync(tmp, real);
          res.writeHead(200, { etag: '"x"' });
          res.end();
        });
        return;
      }
      if (m === "DELETE") {
        try {
          const st = fs.statSync(real);
          if (st.isDirectory()) fs.rmdirSync(real);
          else fs.unlinkSync(real);
        } catch {
          /* S3 deletes are idempotent */
        }
        res.writeHead(204);
        return res.end();
      }
      return err(res, 405, "MethodNotAllowed");
    } catch {
      return err(res, 500, "InternalError");
    }
  });
  await new Promise<void>((res) => server.listen(0, "127.0.0.1", res));
  return {
    port: (server.address() as AddressInfo).port,
    close: () =>
      new Promise<void>((res) => {
        server.closeAllConnections();
        server.close(() => res());
      }),
  };
}
