import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { contractTest } from "./agent-under-test.ts";
import { getJson, q, withAgent } from "./fs-fixture.ts";

// The HTTP form of test/paths.test.ts: what a client path may reach. The link tests of test/symlinks.test.ts are in fs-symlinks.test.ts.
const setup = (root: string, outside: string) => {
  fs.mkdirSync(path.join(root, "a/b"), { recursive: true });
  fs.writeFileSync(path.join(root, "a/file.txt"), "hello world");
  fs.symlinkSync(outside, path.join(root, "abs-out")); // absolute link to a folder outside
  fs.symlinkSync("../../../outside", path.join(root, "a/b/rel-out")); // climbs above the root
  fs.symlinkSync("../".repeat(40) + outside.slice(1), path.join(root, "a/b/deep-out")); // climbs far above the root, then names the outside folder
  fs.symlinkSync("file.txt", path.join(root, "a/inner"));
  fs.symlinkSync("loop2", path.join(root, "loop1"));
  fs.symlinkSync("loop1", path.join(root, "loop2"));
};

contractTest("plain paths resolve under the root", () =>
  withAgent({ setup, prefix: "fd-paths-" }, async (app) => {
    for (const p of ["/a/file.txt", "a//./file.txt", "/a/./file.txt", "//a/file.txt"]) {
      const r = await app.request(`/api/fs/read?path=${q(p)}`);
      assert.equal(r.status, 200, p);
      assert.equal(await r.text(), "hello world", p);
    }
    for (const p of ["/", "", "//", "/."]) {
      const l = await getJson(app, `/api/fs/list?path=${q(p)}`);
      assert.equal(l.status, 200, `list ${p}`);
      assert.equal(l.body.path, "/", `list ${p}`);
    }
    assert.equal((await getJson(app, "/api/fs/list")).body.path, "/", "path defaults to the root");
    const l = await getJson(app, "/api/fs/list?path=a//./b/");
    assert.equal(l.body.path, "/a/b", "the answer names the canonical path");
    assert.deepEqual(l.body.entries.map((e: { path: string }) => e.path).sort(), ["/a/b/deep-out", "/a/b/rel-out"]);
    const s = await getJson(app, "/api/fs/stat?path=/a/file.txt");
    assert.deepEqual({ name: s.body.name, path: s.body.path, type: s.body.type, size: s.body.size }, { name: "file.txt", path: "/a/file.txt", type: "file", size: 11 });
  }),
);

contractTest("'..' segments are refused with 400, never clamped", () =>
  withAgent({ setup, prefix: "fd-paths-" }, async (app) => {
    for (const p of ["/..", "/a/../../etc/passwd", "../x", "/a/b/../..", "/a/..", "/a/file.txt/.."]) {
      for (const route of ["list", "stat", "read", "download", "text"]) {
        const r = await getJson(app, `/api/fs/${route}?path=${q(p)}`);
        assert.equal(r.status, 400, `${route} ${p}`);
        assert.match(r.body.error, /'\.\.' segments are not allowed/, `${route} ${p}`);
      }
    }
  }),
);

contractTest("NUL bytes and oversized paths are refused with 400", () =>
  withAgent({ setup, prefix: "fd-paths-" }, async (app) => {
    for (const route of ["list", "stat", "read", "text"]) {
      assert.equal((await getJson(app, `/api/fs/${route}?path=/a%00b`)).status, 400, route);
      const long = await getJson(app, `/api/fs/${route}?path=/${"a".repeat(5000)}`);
      assert.equal(long.status, 400, route);
      assert.equal(long.body.error, "path too long", route);
    }
  }),
);

contractTest("an absolute link to the outside is re-based under the root: the outside folder cannot be read", () =>
  withAgent({ setup, prefix: "fd-paths-" }, async (app, _root, outside) => {
    const r = await app.request("/api/fs/read?path=/abs-out/secret");
    assert.equal(r.status, 404);
    assert.doesNotMatch(await r.text(), /top secret/);
    assert.equal((await getJson(app, "/api/fs/list?path=/abs-out")).status, 404);
    assert.equal((await getJson(app, "/api/fs/text?path=/abs-out/secret")).status, 404);
    assert.equal(fs.readFileSync(path.join(outside, "secret"), "utf8"), "top secret");
  }),
);

contractTest("a relative link that climbs above the root is clamped for reads, and stat refuses it", () =>
  withAgent({ setup, prefix: "fd-paths-" }, async (app) => {
    for (const link of ["/a/b/rel-out/secret", "/a/b/deep-out/secret"]) {
      for (const route of ["read", "download", "text"]) {
        const r = await app.request(`/api/fs/${route}?path=${q(link)}`);
        assert.equal(r.status, 404, `${route} ${link}`);
        assert.doesNotMatch(await r.text(), /top secret/, `${route} ${link}`);
      }
      const s = await getJson(app, `/api/fs/stat?path=${q(link)}`);
      assert.equal(s.status, 403, link);
      assert.match(s.body.error, /escapes root/, link);
    }
  }),
);

contractTest("stat does not follow the final link; it reports the link itself", () =>
  withAgent({ setup, prefix: "fd-paths-" }, async (app, _root, outside) => {
    const abs = await getJson(app, "/api/fs/stat?path=/abs-out");
    assert.equal(abs.status, 200);
    assert.equal(abs.body.type, "symlink");
    assert.equal(abs.body.target, outside);
    assert.equal(abs.body.broken, true, "inside the root the target does not exist");
    const inner = await getJson(app, "/api/fs/stat?path=/a/inner");
    assert.equal(inner.body.type, "symlink");
    assert.equal(inner.body.target, "file.txt");
    assert.equal(inner.body.linkDir, false);
    assert.equal(inner.body.broken, undefined);
    // reading it follows it
    assert.equal(await (await app.request("/api/fs/read?path=/a/inner")).text(), "hello world");
  }),
);

contractTest("symlink loops: reads fail with 400, the entry is a link that is not broken and not a folder", () =>
  withAgent({ setup, prefix: "fd-paths-" }, async (app) => {
    for (const p of ["/loop1/x", "/loop1"]) {
      const r = await getJson(app, `/api/fs/read?path=${q(p)}`);
      assert.equal(r.status, 400, p);
      assert.match(r.body.error, /too many symbolic links/, p);
    }
    const s = await getJson(app, "/api/fs/stat?path=/loop1");
    assert.equal(s.status, 200);
    assert.equal(s.body.type, "symlink");
    assert.equal(s.body.target, "loop2");
    assert.equal(s.body.linkDir, false);
    assert.equal(s.body.broken, false);
  }),
);

contractTest("missing and wrong-type steps give the status of the failing step", () =>
  withAgent({ setup, prefix: "fd-paths-" }, async (app) => {
    assert.equal((await getJson(app, "/api/fs/stat?path=/nope")).status, 404);
    assert.equal((await getJson(app, "/api/fs/list?path=/nope/deeper")).status, 404);
    assert.equal((await getJson(app, "/api/fs/read?path=/nope/deeper/file")).status, 404);
    const nd = await getJson(app, "/api/fs/read?path=/a/file.txt/x");
    assert.equal(nd.status, 400);
    assert.equal(nd.body.error, "not a directory");
    const ls = await getJson(app, "/api/fs/list?path=/a/file.txt");
    assert.equal(ls.status, 400);
    assert.equal(ls.body.error, "not a directory");
    assert.equal((await getJson(app, "/api/fs/read?path=/a")).body.error, "is a directory");
  }),
);

contractTest("the error body is JSON with an error field, and an unknown route is 404", () =>
  withAgent({ setup, prefix: "fd-paths-" }, async (app) => {
    const r = await app.request("/api/fs/stat?path=/nope");
    assert.equal(r.status, 404);
    assert.match(r.headers.get("content-type") ?? "", /^application\/json/);
    assert.deepEqual(await r.json(), { error: "not found" });
    assert.equal((await app.request("/api/fs/nothing")).status, 404);
    assert.equal((await app.anon("/api/fs/stat?path=/")).status, 401);
  }),
);
