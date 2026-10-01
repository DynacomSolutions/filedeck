import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import type { AddressInfo } from "node:net";

export interface TestDav {
  port: number;
  close(): Promise<void>;
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");

/** Minimal WebDAV server over a local directory (basic auth), for tests. URL prefix `/dav` maps to `root`. */
export async function startDav(root: string, user: string, password: string): Promise<TestDav> {
  const want = "Basic " + Buffer.from(`${user}:${password}`).toString("base64");
  const toDisk = (url: string) => {
    const p = decodeURIComponent(new URL(url, "http://x").pathname);
    if (!p.startsWith("/dav")) return null;
    const rel = path.posix.normalize(p.slice(4) || "/");
    const real = path.join(root, rel);
    return real === root || real.startsWith(root + path.sep) ? { real, rel } : null;
  };
  const entry = (href: string, st: fs.Stats) =>
    `<d:response><d:href>${esc(href)}</d:href><d:propstat><d:prop>` +
    (st.isDirectory() ? "<d:resourcetype><d:collection/></d:resourcetype>" : `<d:resourcetype/><d:getcontentlength>${st.size}</d:getcontentlength>`) +
    `<d:getlastmodified>${st.mtime.toUTCString()}</d:getlastmodified></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`;

  const server = http.createServer((req, res) => {
    const end = (code: number, body = "", headers: Record<string, string> = {}) => {
      res.writeHead(code, headers);
      res.end(body);
    };
    if (req.headers.authorization !== want) return end(401, "", { "www-authenticate": 'Basic realm="t"' });
    const t = toDisk(req.url ?? "");
    if (!t) return end(403);
    const { real } = t;
    const m = req.method ?? "";
    try {
      if (m === "PROPFIND") {
        let st: fs.Stats;
        try {
          st = fs.statSync(real);
        } catch {
          return end(404);
        }
        const base = (decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname)).replace(/\/+$/, "");
        const enc = (p: string) => p.split("/").map(encodeURIComponent).join("/");
        let body = `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:">` + entry(enc(base) + (st.isDirectory() ? "/" : ""), st);
        if (st.isDirectory() && req.headers.depth !== "0") {
          for (const n of fs.readdirSync(real)) {
            const cs = fs.statSync(path.join(real, n));
            body += entry(enc(`${base}/${n}`) + (cs.isDirectory() ? "/" : ""), cs);
          }
        }
        return end(207, body + "</d:multistatus>", { "content-type": "application/xml" });
      }
      if (m === "GET" || m === "HEAD") {
        let st: fs.Stats;
        try {
          st = fs.statSync(real);
        } catch {
          return end(404);
        }
        if (st.isDirectory()) return end(405);
        const r = /^bytes=(\d+)-(\d+)$/.exec(String(req.headers.range ?? ""));
        if (r && process.env.TEST_DAV_IGNORE_RANGE !== "1") {
          const [s, e] = [Number(r[1]), Math.min(Number(r[2]), st.size - 1)];
          res.writeHead(206, { "content-length": e - s + 1, "content-range": `bytes ${s}-${e}/${st.size}` });
          return fs.createReadStream(real, { start: s, end: e }).pipe(res);
        }
        res.writeHead(200, { "content-length": st.size });
        return m === "HEAD" ? res.end() : fs.createReadStream(real).pipe(res);
      }
      if (m === "PUT") {
        if (req.headers["transfer-encoding"] === "chunked") return end(411);
        if (req.headers["if-none-match"] === "*" && fs.existsSync(real)) {
          req.resume();
          return end(412);
        }
        if (!fs.existsSync(path.dirname(real))) {
          req.resume();
          return end(409);
        }
        const tmp = real + ".davpart";
        const out = fs.createWriteStream(tmp);
        req.pipe(out);
        out.on("finish", () => {
          fs.renameSync(tmp, real);
          const mt = Number(req.headers["x-oc-mtime"]);
          if (mt) fs.utimesSync(real, mt, mt);
          end(fs.existsSync(real) ? 201 : 204);
        });
        return;
      }
      if (m === "MKCOL") {
        if (fs.existsSync(real)) return end(405);
        if (!fs.existsSync(path.dirname(real))) return end(409);
        fs.mkdirSync(real);
        return end(201);
      }
      if (m === "DELETE") {
        if (!fs.existsSync(real)) return end(404);
        fs.rmSync(real, { recursive: true });
        return end(204);
      }
      if (m === "MOVE") {
        const dest = toDisk(String(req.headers.destination ?? ""));
        if (!dest) return end(400);
        const existed = fs.existsSync(dest.real);
        if (existed && req.headers.overwrite === "F") return end(412);
        if (!fs.existsSync(path.dirname(dest.real))) return end(409);
        if (existed) fs.rmSync(dest.real, { recursive: true });
        fs.renameSync(real, dest.real);
        return end(existed ? 204 : 201);
      }
      return end(405);
    } catch {
      return end(500);
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
