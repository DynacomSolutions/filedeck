/**
 * Golden answers for the file routes. `fs-golden-capture.ts` records them from the TS agent (spawn mode);
 * `fs-golden.test.ts` checks that any agent gives the same answers. The golden file is `server/test/contract/golden/fs.json`.
 *
 * What differs by file system or by run is normalised: `mtime`, `etag`, the size of a folder, the mode of a link, and the order of
 * the plain list (the TS agent gives the order of the directory, the Rust agent the default order; the streamed list is compared as it is).
 */
import fs from "node:fs";
import path from "node:path";
import type { AgentUnderTest } from "./agent-under-test.ts";

export const GOLDEN_FILE = path.resolve(import.meta.dirname, "golden/fs.json");

const MTIME = new Date("2024-03-05T06:07:08.000Z");

export function buildFixture(root: string): void {
  const w = (p: string, data: string | Buffer, mode = 0o644) => {
    const f = path.join(root, p);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, data);
    fs.chmodSync(f, mode);
    fs.utimesSync(f, MTIME, MTIME);
  };
  w("docs/readme.txt", "hello\n");
  w("docs/notes.md", "# notes\nline two\n");
  w("docs/data.bin", Buffer.from([0, 1, 2, 255]), 0o600);
  w("docs/é ü.txt", "u");
  w("docs/sub/inner.txt", "inner");
  w("docs/.hidden", "h");
  w("docs/.filedeck-trash/x", "reserved");
  w("docs/.filedeck-work-abc/y", "reserved");
  w("docs/digits.txt", "0123456789".repeat(10));
  for (const n of ["f1", "f2", "f10", "f02", "Bb", "aa", "cc", "Dd", "_u", "-d", "9z", "z9"]) w(`nat/${n}`, n);
  fs.mkdirSync(path.join(root, "nat/d2"));
  fs.mkdirSync(path.join(root, "nat/d10"));
  fs.mkdirSync(path.join(root, "nat/D1"));
  fs.symlinkSync("readme.txt", path.join(root, "docs/link"));
  fs.symlinkSync("sub", path.join(root, "docs/dirlink"));
  fs.symlinkSync("missing", path.join(root, "docs/broken"));
  fs.symlinkSync("/docs/notes.md", path.join(root, "docs/abslink"));
  fs.symlinkSync("../../../../../../etc/passwd", path.join(root, "docs/escape"));
  fs.symlinkSync("loop-b", path.join(root, "docs/loop-a"));
  fs.symlinkSync("loop-a", path.join(root, "docs/loop-b"));
  for (const d of ["docs", "docs/sub", "docs/.filedeck-trash", "docs/.filedeck-work-abc", "nat", "nat/d2", "nat/d10", "nat/D1"]) {
    fs.chmodSync(path.join(root, d), 0o755);
    fs.utimesSync(path.join(root, d), MTIME, MTIME);
  }
  fs.chmodSync(root, 0o755);
}

export interface Recorded {
  status: number;
  headers: Record<string, string>;
  body: unknown;
}

const KEEP = ["content-type", "content-length", "content-disposition", "content-range", "accept-ranges", "last-modified", "x-content-type-options", "content-security-policy", "cache-control"];

function clean(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(clean);
  if (v && typeof v === "object") {
    const o = { ...(v as Record<string, unknown>) };
    if ("etag" in o) o.etag = "<etag>";
    if ("mtime" in o) o.mtime = 0;
    if ("type" in o && "name" in o && "size" in o) {
      if (o.type === "dir") o.size = 0;
      if (o.type === "symlink") o.mode = 0;
    }
    for (const k of Object.keys(o)) o[k] = clean(o[k]);
    return o;
  }
  return v;
}

/** the plain list: the order is the directory's own in the TS agent, so sort it */
function sortPlain(v: unknown): unknown {
  const o = v as { entries?: { name: string }[] };
  if (o && Array.isArray(o.entries)) o.entries = [...o.entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return v;
}

export async function record(app: AgentUnderTest, url: string, init?: RequestInit, plainList = false): Promise<Recorded> {
  const r = await app.request(url, init);
  const type = r.headers.get("content-type") ?? "";
  const buf = Buffer.from(await r.arrayBuffer());
  const headers: Record<string, string> = {};
  for (const k of KEEP) {
    if (k === "content-length" && type.startsWith("application/json")) continue; // the length of a JSON body depends on the numbers in it
    const v = r.headers.get(k);
    if (k === "content-length" && v === "0") continue; // an empty body: whether the length is sent is up to the server
    if (v !== null) headers[k] = v;
  }
  let body: unknown;
  if (type.startsWith("application/json")) body = clean(JSON.parse(buf.toString()));
  else if (type.startsWith("application/x-ndjson")) body = buf.toString().split("\n").filter(Boolean).map((l) => clean(JSON.parse(l)));
  else body = buf.toString("base64");
  if (plainList) body = sortPlain(body);
  return { status: r.status, headers, body };
}

/** every request of the golden set, by name */
export const REQUESTS: Record<string, { url: string; init?: RequestInit; plainList?: boolean }> = {
  "list docs": { url: "/api/fs/list?path=/docs", plainList: true },
  "list docs hidden": { url: "/api/fs/list?path=/docs&hidden=1", plainList: true },
  "list docs stream": { url: "/api/fs/list?path=/docs&stream=1" },
  "list docs stream hidden": { url: "/api/fs/list?path=/docs&hidden=1&stream=1" },
  "list nat stream": { url: "/api/fs/list?path=/nat&hidden=1&stream=1" },
  "list nat": { url: "/api/fs/list?path=/nat", plainList: true },
  "list root": { url: "/api/fs/list", plainList: true },
  "list via link": { url: "/api/fs/list?path=/docs/dirlink" },
  "list file": { url: "/api/fs/list?path=/docs/readme.txt" },
  "list missing": { url: "/api/fs/list?path=/nope" },
  "list stream missing": { url: "/api/fs/list?path=/nope&stream=1" },
  "list dotdot": { url: "/api/fs/list?path=/docs/../.." },
  "list reserved": { url: "/api/fs/list?path=/docs/.filedeck-trash" },
  "stat file": { url: "/api/fs/stat?path=/docs/readme.txt" },
  "stat dir": { url: "/api/fs/stat?path=/docs/sub" },
  "stat link": { url: "/api/fs/stat?path=/docs/link" },
  "stat dirlink": { url: "/api/fs/stat?path=/docs/dirlink" },
  "stat broken": { url: "/api/fs/stat?path=/docs/broken" },
  "stat abslink": { url: "/api/fs/stat?path=/docs/abslink" },
  "stat escape link": { url: "/api/fs/stat?path=/docs/escape" },
  "stat loop": { url: "/api/fs/stat?path=/docs/loop-a" },
  "stat through escape": { url: "/api/fs/stat?path=/docs/escape/x" },
  "stat missing": { url: "/api/fs/stat?path=/docs/missing" },
  "stat reserved": { url: "/api/fs/stat?path=/docs/.filedeck-work-abc" },
  "stat unicode": { url: `/api/fs/stat?path=${encodeURIComponent("/docs/é ü.txt")}` },
  "read file": { url: "/api/fs/read?path=/docs/readme.txt" },
  "read binary": { url: "/api/fs/read?path=/docs/data.bin" },
  "read via link": { url: "/api/fs/read?path=/docs/link" },
  "read via abslink": { url: "/api/fs/read?path=/docs/abslink" },
  "read through escape": { url: "/api/fs/read?path=/docs/escape" },
  "read loop": { url: "/api/fs/read?path=/docs/loop-a" },
  "read dir": { url: "/api/fs/read?path=/docs" },
  "read reserved": { url: "/api/fs/read?path=/docs/.filedeck-trash/x" },
  "read range": { url: "/api/fs/read?path=/docs/digits.txt", init: { headers: { range: "bytes=10-19" } } },
  "read suffix range": { url: "/api/fs/read?path=/docs/digits.txt", init: { headers: { range: "bytes=-5" } } },
  "read open range": { url: "/api/fs/read?path=/docs/digits.txt", init: { headers: { range: "bytes=95-" } } },
  "read bad range": { url: "/api/fs/read?path=/docs/digits.txt", init: { headers: { range: "bytes=100-" } } },
  "read head": { url: "/api/fs/read?path=/docs/readme.txt", init: { method: "HEAD" } },
  "download file": { url: "/api/fs/download?path=/docs/readme.txt" },
  "download unicode": { url: `/api/fs/download?path=${encodeURIComponent("/docs/é ü.txt")}` },
  "download range": { url: "/api/fs/download?path=/docs/digits.txt", init: { headers: { range: "bytes=0-4" } } },
  "download head": { url: "/api/fs/download?path=/docs/readme.txt", init: { method: "HEAD" } },
  "text file": { url: "/api/fs/text?path=/docs/notes.md" },
  "text binary": { url: "/api/fs/text?path=/docs/data.bin" },
  "text dir": { url: "/api/fs/text?path=/docs" },
  "text missing": { url: "/api/fs/text?path=/docs/missing" },
  "text through link": { url: "/api/fs/text?path=/docs/link" },
  "unauthorised": { url: "/api/fs/stat?path=/" },
};

export async function exercise(app: AgentUnderTest): Promise<Record<string, Recorded>> {
  const out: Record<string, Recorded> = {};
  for (const [name, r] of Object.entries(REQUESTS)) {
    if (name === "unauthorised") {
      const x = await app.anon(r.url);
      out[name] = { status: x.status, headers: { "content-type": x.headers.get("content-type") ?? "" }, body: await x.json() };
      continue;
    }
    out[name] = await record(app, r.url, r.init, r.plainList);
  }
  return out;
}
