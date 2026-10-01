import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { WebdavBackend } from "../src/sources/webdav.ts";
import { startDav } from "./webdav-server.ts";
import { defineSourceSuite } from "./source-suite.ts";

const PASSWORD = "dav-s3cret-value";

defineSourceSuite("webdav", async (tmp, secrets) => {
  const dav = path.join(tmp, "dav");
  fs.mkdirSync(path.join(dav, "share"), { recursive: true });
  for (const n of ["nas", "badnas"]) {
    fs.mkdirSync(path.join(secrets, n), { recursive: true });
    fs.writeFileSync(path.join(secrets, n, "username"), "bob\n");
    fs.writeFileSync(path.join(secrets, n, "password"), (n === "nas" ? PASSWORD : "wrong-dav-pass") + "\n");
  }
  const srv = await startDav(dav, "bob", PASSWORD);
  const host = `http://127.0.0.1:${srv.port}/dav`;
  return {
    sources: [
      { name: "nas", type: "webdav", host, root: "/share", secretRef: "nas-creds" },
      { name: "badnas", type: "webdav", host, root: "/share", secretRef: "badnas-creds" },
    ],
    diskRoot: path.join(dav, "share"),
    leaks: [PASSWORD, "wrong-dav-pass", "bob"],
    close: () => srv.close(),
  };
});

test("webdav: a server that ignores Range still yields the requested bytes; special characters in names", async () => {
  const dav = fs.mkdtempSync(path.join(fs.realpathSync(process.env.TMPDIR ?? "/tmp"), "filedeck-dav-"));
  fs.mkdirSync(path.join(dav, "r"));
  fs.writeFileSync(path.join(dav, "r", "a b#c.bin"), Buffer.from("0123456789"));
  const srv = await startDav(dav, "u", "p");
  process.env.TEST_DAV_IGNORE_RANGE = "1";
  try {
    const b = new WebdavBackend({ name: "x", type: "webdav", host: `http://127.0.0.1:${srv.port}/dav`, root: "/r" }, async () => ({ username: "u", password: "p" }));
    const chunks: Buffer[] = [];
    for await (const c of (await b.read("/a b#c.bin", { start: 3, end: 6 })) as AsyncIterable<Buffer>) chunks.push(c);
    assert.equal(Buffer.concat(chunks).toString(), "3456");
    assert.deepEqual((await b.list("/")).map((e) => [e.name, e.size]), [["a b#c.bin", 10]]);
    await b.write("/new é.txt", Readable.from([Buffer.from("hi")]), { overwrite: false, size: 2 });
    assert.equal(fs.readFileSync(path.join(dav, "r", "new é.txt"), "utf8"), "hi");
    await b.close();
  } finally {
    delete process.env.TEST_DAV_IGNORE_RANGE;
    await srv.close();
    fs.rmSync(dav, { recursive: true, force: true });
  }
});
