import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { contractTest } from "./agent-under-test.ts";
import { getJson, q, streamLines, withAgent } from "./fs-fixture.ts";

// The HTTP form of test/reserved-names.test.ts for the read routes: the agent's own folder names are hidden and refused.
const RESERVED = [".filedeck-trash", ".filedeck-work", ".filedeck-work-abc", ".filedeck-work-9f3a-77"];
const setup = (root: string) => {
  fs.mkdirSync(path.join(root, "sub"), { recursive: true });
  fs.writeFileSync(path.join(root, "visible.txt"), "v");
  fs.writeFileSync(path.join(root, "sub/inner.txt"), "i");
  for (const r of RESERVED) {
    for (const where of [root, path.join(root, "sub")]) {
      fs.mkdirSync(path.join(where, r));
      fs.writeFileSync(path.join(where, r, "hidden.bin"), "X".repeat(1000));
    }
  }
  fs.mkdirSync(path.join(root, ".filedeck-workshop")); // not reserved: only the exact names and the staging prefix are
  fs.writeFileSync(path.join(root, ".filedeck-workshop/ok.txt"), "ok");
};

contractTest("reads, stats and listings of every reserved name are refused with 403", () =>
  withAgent({ setup, prefix: "fd-reserved-" }, async (app) => {
    for (const n of RESERVED) {
      for (const where of ["", "/sub"]) {
        for (const route of ["read", "download", "text"]) {
          const r = await getJson(app, `/api/fs/${route}?path=${q(`${where}/${n}/hidden.bin`)}`);
          assert.equal(r.status, 403, `${route} ${where}/${n}`);
          assert.doesNotMatch(JSON.stringify(r.body), /XXXX/);
        }
        for (const route of ["stat", "list"]) assert.equal((await getJson(app, `/api/fs/${route}?path=${q(`${where}/${n}`)}`)).status, 403, `${route} ${where}/${n}`);
        assert.equal((await getJson(app, `/api/fs/list?path=${q(`${where}/${n}`)}&stream=1`)).status, 403, `stream ${where}/${n}`);
      }
    }
    // the check is on the name, so a reserved name that does not exist is refused too
    assert.equal((await getJson(app, "/api/fs/read?path=/nope/.filedeck-trash/x")).status, 403);
    assert.equal((await getJson(app, "/api/fs/read?path=/.filedeck-work-zzz")).status, 403);
    const t = await getJson(app, "/api/fs/read?path=/x/.filedeck-trash/id/data");
    assert.equal(t.body.error, "trash is managed via the trash API");
    const w = await getJson(app, "/api/fs/read?path=/.filedeck-work/hidden.bin");
    assert.equal(w.body.error, "this name is reserved for the file manager's own use");
  }),
);

contractTest("listings skip every reserved name, with and without hidden names, plain and streamed", () =>
  withAgent({ setup, prefix: "fd-reserved-" }, async (app) => {
    for (const hidden of ["0", "1"]) {
      for (const dir of ["/", "/sub"]) {
        const plain = await getJson(app, `/api/fs/list?path=${q(dir)}&hidden=${hidden}`);
        const names: string[] = plain.body.entries.map((e: { name: string }) => e.name);
        const lines = await streamLines(app, `/api/fs/list?path=${q(dir)}&hidden=${hidden}&stream=1`);
        const streamed: string[] = lines.flatMap((l) => (l.e ?? []).map((e: { name: string }) => e.name));
        for (const got of [names, streamed]) {
          assert.deepEqual(got.filter((n) => RESERVED.includes(n) || n.startsWith(".filedeck-work-")), [], `${dir} hidden=${hidden}`);
        }
        assert.deepEqual([...names].sort(), [...streamed].sort(), `${dir} hidden=${hidden}`);
      }
    }
    const root = await getJson(app, "/api/fs/list?path=/&hidden=1");
    const names = root.body.entries.map((e: { name: string }) => e.name);
    assert.ok(names.includes("visible.txt"));
    assert.ok(names.includes(".filedeck-workshop"), "a name that only looks like a reserved one is listed");
    assert.equal((await getJson(app, "/api/fs/list?path=/&hidden=0")).body.entries.some((e: { name: string }) => e.name.startsWith(".")), false);
    assert.equal(await (await app.request("/api/fs/read?path=/.filedeck-workshop/ok.txt")).text(), "ok");
  }),
);

contractTest("a link to a reserved name is refused too", () =>
  withAgent({ setup, prefix: "fd-reserved-" }, async (app, root) => {
    fs.symlinkSync(".filedeck-trash", path.join(root, "to-trash"));
    const r = await getJson(app, "/api/fs/read?path=/to-trash/hidden.bin");
    assert.equal(r.status, 403);
    const s = await getJson(app, "/api/fs/stat?path=/to-trash");
    assert.equal(s.status, 200, "the link itself is an entry");
    assert.equal(s.body.type, "symlink");
    assert.equal(s.body.linkDir, false);
  }),
);
