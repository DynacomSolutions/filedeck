import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { contractTest } from "./agent-under-test.ts";
import { getJson, q, withAgent } from "./fs-fixture.ts";

// The HTTP form of test/symlinks.test.ts. Links are made on disk; the agent only reads them.
// Making links through the agent (`/api/fs/symlink`) is a write route, so it stays in the TS tests.
const setup = (root: string) => {
  fs.mkdirSync(path.join(root, "d"), { recursive: true });
  fs.writeFileSync(path.join(root, "d/f.txt"), "hello");
};

contractTest("list shows a link with its text, a broken link, and a link to a folder", () =>
  withAgent({ setup, prefix: "fd-ln-" }, async (app, root) => {
    fs.symlinkSync("f.txt", path.join(root, "d/rel"));
    assert.equal(await (await app.request("/api/fs/read?path=/d/rel")).text(), "hello");
    const ok = await getJson(app, "/api/fs/stat?path=/d/rel");
    assert.equal(ok.body.type, "symlink");
    assert.equal(ok.body.target, "f.txt");
    assert.equal(ok.body.broken, undefined);
    assert.equal(ok.body.linkDir, false);

    fs.rmSync(path.join(root, "d/rel"));
    fs.symlinkSync("gone.txt", path.join(root, "d/rel"));
    fs.symlinkSync("/", path.join(root, "d/dirlink"));
    const ls = await getJson(app, "/api/fs/list?path=/d");
    const by = (n: string) => ls.body.entries.find((x: { name: string }) => x.name === n);
    assert.equal(by("rel").target, "gone.txt");
    assert.equal(by("rel").broken, true);
    assert.equal(by("rel").linkDir, false);
    assert.equal(by("dirlink").linkDir, true);
    assert.equal(by("dirlink").target, "/");
    assert.equal(by("dirlink").broken, undefined);
    assert.equal(by("f.txt").target, undefined);
    assert.equal(by("f.txt").linkDir, undefined);
  }),
);

contractTest("a link made with an escaping target cannot be used to read outside", () =>
  withAgent({ setup, prefix: "fd-ln-" }, async (app, root, outside) => {
    fs.symlinkSync(path.join(outside, "secret"), path.join(root, "d/esc"));
    fs.symlinkSync("../../outside/secret", path.join(root, "d/esc2"));
    fs.symlinkSync("../".repeat(30) + outside.slice(1) + "/secret", path.join(root, "d/esc3"));
    for (const p of ["/d/esc", "/d/esc2", "/d/esc3"]) {
      for (const route of ["read", "download", "text"]) {
        const r = await app.request(`/api/fs/${route}?path=${p}`);
        assert.equal(r.status, 404, `${route} ${p}`);
        assert.doesNotMatch(await r.text(), /top secret/, `${route} ${p}`);
      }
    }
  }),
);

contractTest("a folder that is a link to the outside shows nothing of the outside", () =>
  withAgent({ setup, prefix: "fd-ln-" }, async (app, root, outside) => {
    fs.symlinkSync(outside, path.join(root, "swapped"));
    assert.equal((await getJson(app, "/api/fs/list?path=/swapped")).status, 404);
    assert.equal((await getJson(app, "/api/fs/stat?path=/swapped/secret")).status, 404);
    assert.equal((await app.request("/api/fs/read?path=/swapped/secret")).status, 404);
    // the link itself is an entry of the root, and it is reported as broken (its target does not exist under the root)
    const root_ls = await getJson(app, "/api/fs/list?path=/");
    const e = root_ls.body.entries.find((x: { name: string }) => x.name === "swapped");
    assert.equal(e.type, "symlink");
    assert.equal(e.broken, true);
  }),
);

contractTest("a final link that points outside is refused, a link that points inside works", () =>
  withAgent({ setup, prefix: "fd-ln-" }, async (app, root, outside) => {
    fs.writeFileSync(path.join(root, "late.txt"), "inside");
    fs.symlinkSync(path.join(outside, "secret"), path.join(root, "late-link"));
    fs.symlinkSync("late.txt", path.join(root, "good-link"));
    assert.equal((await app.request("/api/fs/read?path=/late-link")).status, 404);
    assert.equal(await (await app.request("/api/fs/read?path=/late.txt")).text(), "inside");
    assert.equal(await (await app.request("/api/fs/read?path=/good-link")).text(), "inside");
  }),
);

contractTest("an absolute link is re-based on the root: it reads the root's own file, not the host's", () =>
  withAgent({ setup, prefix: "fd-ln-" }, async (app, root) => {
    fs.symlinkSync("/d/f.txt", path.join(root, "abs-in"));
    assert.equal(await (await app.request("/api/fs/read?path=/abs-in")).text(), "hello");
    fs.symlinkSync("/d", path.join(root, "abs-dir"));
    const l = await getJson(app, "/api/fs/list?path=/abs-dir");
    assert.equal(l.status, 200);
    assert.equal(l.body.path, "/d", "the answer names the folder the link leads to");
  }),
);
