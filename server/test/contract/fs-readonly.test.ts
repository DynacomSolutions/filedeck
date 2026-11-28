import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { contractTest } from "./agent-under-test.ts";
import { agentUnderTest, contractMode } from "./agent-under-test.ts";
import { TOKEN, getJson, withAgent } from "./fs-fixture.ts";

// The HTTP form of test/readonly.test.ts. The TS agent refuses changes under the prefixes of FILEDECK_READONLY;
// the Rust agent is read only everywhere. What both give: reads work, every change route answers 403 and changes nothing.
const setup = (root: string) => {
  fs.mkdirSync(path.join(root, "ro/sub"), { recursive: true });
  fs.mkdirSync(path.join(root, "rw"));
  fs.writeFileSync(path.join(root, "ro/a.txt"), "x");
  fs.symlinkSync("../ro", path.join(root, "rw/into-ro"));
};

const json = (method: string, body: unknown): RequestInit => ({ method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

contractTest("changes under a read-only prefix answer 403 and change nothing; reads still work", () =>
  withAgent({ setup, prefix: "fd-ro-", env: { FILEDECK_READONLY: "/ro" } }, async (app, root) => {
    const denied = async (url: string, init: RequestInit) => {
      const r = await app.request(url, init);
      assert.equal(r.status, 403, `${init.method} ${url}`);
      assert.match(((await r.json()) as { error: string }).error, /read-only|read only/, `${init.method} ${url}`);
    };
    assert.equal((await app.request("/api/fs/list?path=/ro")).status, 200);
    assert.equal((await app.request("/api/fs/read?path=/ro/a.txt")).status, 200);
    await denied("/api/fs/mkdir", json("POST", { path: "/ro/new" }));
    await denied("/api/fs/symlink", json("POST", { path: "/ro/ln", target: "a.txt" }));
    await denied("/api/fs/delete", json("POST", { paths: ["/ro/a.txt"] }));
    await denied("/api/fs/trash", json("POST", { paths: ["/ro/a.txt"] }));
    await denied("/api/fs/rename", json("POST", { from: "/ro/a.txt", to: "/rw/a.txt" }));
    await denied("/api/fs/rename", json("POST", { from: "/rw/x", to: "/ro/x" }));
    await denied("/api/fs/move", json("POST", { from: ["/ro/a.txt"], toDir: "/rw" }));
    await denied("/api/fs/copy", json("POST", { from: ["/rw"], toDir: "/ro" }));
    await denied("/api/fs/perms", json("POST", { path: "/ro/a.txt", mode: 0o600 }));
    await denied("/api/fs/mkdir", json("POST", { path: "/rw/into-ro/viasym" }));
    await denied("/api/fs/upload?dir=/ro&name=u", { method: "PUT", body: "x" });
    await denied("/api/fs/write?path=/ro/a.txt", { method: "PUT", headers: { "if-match": "x" }, body: "y" });
    await denied("/api/fs/write?path=/rw/into-ro/a.txt", { method: "PUT", headers: { "if-match": "x" }, body: "y" });
    assert.equal(fs.readFileSync(path.join(root, "ro/a.txt"), "utf8"), "x");
    assert.ok(!fs.existsSync(path.join(root, "ro/new")));
    assert.ok(!fs.existsSync(path.join(root, "ro/ln")));
    assert.ok(!fs.existsSync(path.join(root, "rw/into-ro/viasym")));
  }),
);

contractTest("/api/info lists the read-only prefixes; the folder /ro is covered", () =>
  withAgent({ setup, prefix: "fd-ro-", env: { FILEDECK_READONLY: "/ro" } }, async (app) => {
    const info = await getJson(app, "/api/info");
    assert.equal(info.status, 200);
    assert.ok(Array.isArray(info.body.readOnly));
    // the TS agent lists the prefix, the Rust agent lists "/" because all of it is read only: either way /ro is covered
    assert.ok(info.body.readOnly.some((p: string) => p === "/" || p === "/ro"), JSON.stringify(info.body.readOnly));
  }),
);

contractTest("a bad FILEDECK_READONLY entry stops the start", async () => {
  if (contractMode() === "url") return; // a running agent cannot be restarted with other settings
  for (const bad of ["rel", "mnt/a", "/..", "/a/../../b"]) {
    await assert.rejects(
      async () => {
        const app = await agentUnderTest({ env: { FILEDECK_AGENT_TOKEN: TOKEN, FILEDECK_READONLY: bad } });
        await app.close();
      },
      undefined,
      bad,
    );
  }
});

contractTest("an entry with doubled and dotted segments is cleaned: the folder is still covered", () =>
  withAgent({ setup, prefix: "fd-ro-", env: { FILEDECK_READONLY: "//ro/./, /a/b/../c//" } }, async (app) => {
    const info = await getJson(app, "/api/info");
    assert.ok(info.body.readOnly.some((p: string) => p === "/" || p === "/ro"), JSON.stringify(info.body.readOnly));
    assert.equal((await app.request("/api/fs/mkdir", json("POST", { path: "/ro/new" }))).status, 403);
  }),
);
