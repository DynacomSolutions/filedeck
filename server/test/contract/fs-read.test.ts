import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { contractTest } from "./agent-under-test.ts";
import { getJson, withAgent } from "./fs-fixture.ts";

// The HTTP form of the read parts of test/paths.test.ts (`parseRange`) and the headers of `/api/fs/read` and `/api/fs/download`.
const setup = (root: string) => {
  fs.mkdirSync(path.join(root, "d"));
  fs.writeFileSync(path.join(root, "d/digits.txt"), "0123456789".repeat(10)); // 100 bytes
  fs.writeFileSync(path.join(root, "d/p.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  fs.writeFileSync(path.join(root, "d/page.html"), "<b>x</b>");
  fs.writeFileSync(path.join(root, "d/data.bin"), Buffer.from([1, 0, 2, 3]));
  fs.writeFileSync(path.join(root, "d/empty.txt"), "");
  fs.writeFileSync(path.join(root, 'd/qu"ote.txt'), "q");
  fs.writeFileSync(path.join(root, "d/é ü.txt"), "u");
  fs.writeFileSync(path.join(root, "d/noext"), "n");
  // fixed mtime, so a header can be compared
  fs.utimesSync(path.join(root, "d/digits.txt"), new Date("2024-03-05T06:07:08.900Z"), new Date("2024-03-05T06:07:08.900Z"));
};

contractTest("read: a whole file, the headers of a safe inline answer", () =>
  withAgent({ setup, prefix: "fd-read-" }, async (app) => {
    const r = await app.request("/api/fs/read?path=/d/digits.txt");
    assert.equal(r.status, 200);
    assert.equal((await r.text()).length, 100);
    assert.equal(r.headers.get("content-type"), "text/plain");
    assert.equal(r.headers.get("content-length"), "100");
    assert.equal(r.headers.get("accept-ranges"), "bytes");
    assert.equal(r.headers.get("last-modified"), "Tue, 05 Mar 2024 06:07:08 GMT");
    assert.equal(r.headers.get("content-disposition"), "inline");
    assert.equal(r.headers.get("x-content-type-options"), "nosniff");
    assert.match(r.headers.get("content-security-policy") ?? "", /^sandbox; default-src 'none'/);
  }),
);

contractTest("content types: images and PDF keep theirs, pages are served as plain text, the rest is a byte stream", () =>
  withAgent({ setup, prefix: "fd-read-" }, async (app) => {
    const type = async (p: string) => (await app.request(`/api/fs/read?path=/d/${p}`)).headers.get("content-type");
    assert.equal(await type("p.png"), "image/png");
    assert.equal(await type("page.html"), "text/plain");
    assert.equal(await type("data.bin"), "application/octet-stream");
    assert.equal(await type("noext"), "application/octet-stream");
  }),
);

contractTest("download: the name is sent in two forms", () =>
  withAgent({ setup, prefix: "fd-read-" }, async (app) => {
    const d = async (p: string) => (await app.request(`/api/fs/download?path=${encodeURIComponent(p)}`)).headers.get("content-disposition");
    assert.equal(await d("/d/digits.txt"), `attachment; filename="digits.txt"; filename*=UTF-8''digits.txt`);
    assert.equal(await d('/d/qu"ote.txt'), `attachment; filename="qu_ote.txt"; filename*=UTF-8''qu%22ote.txt`);
    assert.equal(await d("/d/é ü.txt"), `attachment; filename="_ _.txt"; filename*=UTF-8''%C3%A9%20%C3%BC.txt`);
    const r = await app.request("/api/fs/download?path=/d/digits.txt");
    assert.equal(r.headers.get("content-type"), "text/plain");
    assert.equal((await r.text()).length, 100);
  }),
);

contractTest("ranges: the same cases as parseRange", () =>
  withAgent({ setup, prefix: "fd-read-" }, async (app) => {
    const get = (range?: string) => app.request("/api/fs/read?path=/d/digits.txt", range === undefined ? undefined : { headers: { range } });
    const ok = async (range: string, start: number, end: number) => {
      const r = await get(range);
      assert.equal(r.status, 206, range);
      assert.equal(r.headers.get("content-range"), `bytes ${start}-${end}/100`, range);
      assert.equal(r.headers.get("content-length"), String(end - start + 1), range);
      const body = await r.text();
      assert.equal(body, "0123456789".repeat(10).slice(start, end + 1), range);
    };
    await ok("bytes=0-9", 0, 9);
    await ok("bytes=90-", 90, 99);
    await ok("bytes=-10", 90, 99);
    await ok("bytes=0-999", 0, 99);
    await ok("bytes=5-5", 5, 5);
    await ok("bytes=-1000", 0, 99);
    for (const bad of ["bytes=100-", "nonsense", "bytes=-0", "bytes=-", "bytes=5-2", "bytes=0-1,5-6", "items=0-1"]) {
      const r = await get(bad);
      assert.equal(r.status, 416, bad);
      assert.equal(r.headers.get("content-range"), "bytes */100", bad);
      assert.equal(await r.text(), "", bad);
    }
    assert.equal((await get()).status, 200);
  }),
);

contractTest("HEAD answers the headers of GET with no body, and a bad range is still 416", () =>
  withAgent({ setup, prefix: "fd-read-" }, async (app) => {
    for (const route of ["read", "download"]) {
      const h = await app.request(`/api/fs/${route}?path=/d/digits.txt`, { method: "HEAD" });
      assert.equal(h.status, 200, route);
      assert.equal(h.headers.get("content-length"), "100", route);
      assert.equal(h.headers.get("accept-ranges"), "bytes", route);
      assert.equal(await h.text(), "", route);
      const bad = await app.request(`/api/fs/${route}?path=/d/digits.txt`, { method: "HEAD", headers: { range: "bytes=500-" } });
      assert.equal(bad.status, 416, route);
    }
    assert.equal((await app.request("/api/fs/read?path=/d/nope", { method: "HEAD" })).status, 404);
  }),
);

contractTest("an empty file reads as empty, and no range can be met", () =>
  withAgent({ setup, prefix: "fd-read-" }, async (app) => {
    const r = await app.request("/api/fs/read?path=/d/empty.txt");
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("content-length"), "0");
    assert.equal(await r.text(), "");
    assert.equal((await app.request("/api/fs/read?path=/d/empty.txt", { headers: { range: "bytes=0-0" } })).status, 416);
  }),
);

contractTest("read: a folder is 400, a missing file is 404, and a FIFO does not hang the call", () =>
  withAgent({ setup, prefix: "fd-read-" }, async (app, root) => {
    const dir = await getJson(app, "/api/fs/read?path=/d");
    assert.deepEqual([dir.status, dir.body], [400, { error: "is a directory" }]);
    assert.deepEqual((await getJson(app, "/api/fs/read")).body, { error: "is a directory" }, "no path is the root");
    assert.equal((await getJson(app, "/api/fs/read?path=/d/nope")).status, 404);
    execFileSync("mkfifo", [path.join(root, "d/pipe")]);
    const fifo = await getJson(app, "/api/fs/read?path=/d/pipe");
    assert.deepEqual([fifo.status, fifo.body], [400, { error: "not a regular file" }]);
    assert.equal((await getJson(app, "/api/fs/text?path=/d/pipe")).status, 400);
    const st = await getJson(app, "/api/fs/stat?path=/d/pipe");
    assert.equal(st.body.type, "other");
  }),
);

contractTest("stat: the fields of an entry match the file system", () =>
  withAgent({ setup, prefix: "fd-read-" }, async (app, root) => {
    for (const [p, type] of [["/d/digits.txt", "file"], ["/d", "dir"]] as const) {
      const real = fs.lstatSync(path.join(root, p));
      const s = await getJson(app, `/api/fs/stat?path=${encodeURIComponent(p)}`);
      assert.equal(s.status, 200, p);
      assert.deepEqual(s.body, { name: path.basename(p), path: p, type, size: real.size, mtime: real.mtimeMs, mode: real.mode & 0o7777 }, p);
    }
    const r = await getJson(app, "/api/fs/stat?path=/");
    assert.equal(r.body.path, "/");
    assert.equal(r.body.type, "dir");
  }),
);

contractTest("text: the file, its size, mtime and etag", () =>
  withAgent({ setup, prefix: "fd-read-" }, async (app, root) => {
    fs.writeFileSync(path.join(root, "d/note.txt"), "héllo\nwörld\n");
    const real = fs.statSync(path.join(root, "d/note.txt"));
    const t = await getJson(app, "/api/fs/text?path=/d/note.txt");
    assert.equal(t.status, 200);
    assert.deepEqual(Object.keys(t.body), ["path", "content", "size", "mtime", "etag"]);
    assert.deepEqual(t.body, { path: "/d/note.txt", content: "héllo\nwörld\n", size: Buffer.byteLength("héllo\nwörld\n"), mtime: real.mtimeMs, etag: `${real.mtimeMs}-${real.size}-${real.ino}` });
    assert.equal((await getJson(app, "/api/fs/text?path=/d/empty.txt")).body.content, "");
  }),
);

contractTest("text: a binary file is 415, bad UTF-8 is 415, a folder is 400, a missing file is 404", () =>
  withAgent({ setup, prefix: "fd-read-" }, async (app, root) => {
    fs.writeFileSync(path.join(root, "d/bad.txt"), Buffer.from([0x61, 0xff, 0xfe, 0x62]));
    const bin = await getJson(app, "/api/fs/text?path=/d/data.bin");
    assert.deepEqual([bin.status, bin.body], [415, { error: "binary file" }]);
    const bad = await getJson(app, "/api/fs/text?path=/d/bad.txt");
    assert.deepEqual([bad.status, bad.body], [415, { error: "file is not valid UTF-8 text" }]);
    assert.deepEqual((await getJson(app, "/api/fs/text?path=/d")).body, { error: "is a directory" });
    assert.equal((await getJson(app, "/api/fs/text?path=/d/nope")).status, 404);
    assert.deepEqual((await getJson(app, "/api/fs/text")).body, { error: "is a directory" }, "no path is the root");
  }),
);

contractTest("text: a file over the edit limit is 413", () =>
  withAgent({ setup, prefix: "fd-read-", env: { FILEDECK_MAX_EDIT: "50" } }, async (app) => {
    const big = await getJson(app, "/api/fs/text?path=/d/digits.txt");
    assert.deepEqual([big.status, big.body], [413, { error: "file too large to edit" }]);
    assert.equal((await getJson(app, "/api/fs/text?path=/d/noext")).status, 200);
  }),
);
