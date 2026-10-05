import fs from "node:fs";
import path from "node:path";
import { startS3 } from "./s3-server.ts";
import { defineSourceSuite } from "./source-suite.ts";

const KEY = "AKIATESTKEY0000";
const SECRET = "s3-secret-access-value";

defineSourceSuite("s3", async (tmp, secrets) => {
  const store = path.join(tmp, "s3");
  fs.mkdirSync(path.join(store, "bkt", "share"), { recursive: true });
  for (const n of ["nas", "badnas"]) {
    fs.mkdirSync(path.join(secrets, n), { recursive: true });
    fs.writeFileSync(path.join(secrets, n, "accessKeyId"), (n === "nas" ? KEY : "AKIAWRONGKEY0000") + "\n");
    fs.writeFileSync(path.join(secrets, n, "secretAccessKey"), SECRET + "\n");
  }
  const srv = await startS3(store, "bkt", KEY);
  const host = `http://127.0.0.1:${srv.port}`;
  const base = { type: "s3", host, root: "/share", options: { bucket: "bkt" } };
  return {
    sources: [
      { name: "nas", ...base, secretRef: "nas-creds" },
      { name: "badnas", ...base, secretRef: "badnas-creds" },
    ],
    diskRoot: path.join(store, "bkt", "share"),
    leaks: [KEY, "AKIAWRONGKEY0000", SECRET],
    close: () => srv.close(),
  };
});

import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import { Readable } from "node:stream";
import { S3Backend } from "../src/sources/s3.ts";

test("s3: folder rename copies every key then deletes; empty folders are markers; paged listing", async () => {
  const store = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "filedeck-s3-")));
  fs.mkdirSync(path.join(store, "bkt"));
  const srv = await startS3(store, "bkt", KEY);
  const b = new S3Backend({ name: "x", type: "s3", host: `http://127.0.0.1:${srv.port}`, root: "/", options: { bucket: "bkt" } }, async () => ({ accessKeyId: KEY, secretAccessKey: SECRET }));
  try {
    await b.mkdir("/a");
    await b.mkdir("/a/empty");
    await b.write("/a/x.txt", Readable.from([Buffer.from("x")]), { overwrite: false, size: 1 });
    await b.write("/a/y.txt", Readable.from([Buffer.from("y")]), { overwrite: false });
    for (let i = 0; i < 1100; i++) fs.writeFileSync(path.join(store, "bkt", "a", `f${String(i).padStart(4, "0")}`), "");
    assert.equal((await b.list("/a")).length, 1103); // 1100 files + x.txt + y.txt + empty/
    for (let i = 0; i < 1100; i++) fs.rmSync(path.join(store, "bkt", "a", `f${String(i).padStart(4, "0")}`));
    await b.rename("/a", "/b", false);
    assert.equal(await b.stat("/a"), null);
    assert.deepEqual((await b.list("/b")).map((e) => [e.name, e.type]).sort(), [["empty", "dir"], ["x.txt", "file"], ["y.txt", "file"]]);
    assert.equal((await b.stat("/b/empty"))?.type, "dir");
    // folders (key prefixes) have no modification time: unknown (null), not the epoch; files keep theirs
    const ls = await b.list("/b");
    assert.equal(ls.find((e) => e.name === "empty")?.mtime, null);
    assert.ok((ls.find((e) => e.name === "x.txt")?.mtime ?? 0) > 0);
    assert.equal((await b.stat("/b/empty"))?.mtime, null);
    assert.equal((await b.stat("/"))?.mtime, null);
    await assert.rejects(() => b.rename("/nope", "/z", false), /not found/);
  } finally {
    await b.close();
    await srv.close();
    fs.rmSync(store, { recursive: true, force: true });
  }
});
