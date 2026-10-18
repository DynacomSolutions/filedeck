import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { DatabaseSync } from "node:sqlite";
import type { AddressInfo } from "node:net";
import { installShutdown } from "../src/shutdown.ts";
import { IndexCache } from "../src/index-cache.ts";

const listen = async (server: http.Server) => {
  await new Promise<void>((r) => server.listen(0, r));
  return (server.address() as AddressInfo).port;
};
const get = (port: number) =>
  new Promise<string>((resolve, reject) =>
    http.get({ port, agent: false }, (res) => {
      let b = "";
      res.on("data", (d) => (b += d));
      res.on("end", () => resolve(b));
    }).on("error", reject),
  );

test("shutdown exits even with an endless stream open", async () => {
  const server = http.createServer((_q, r) => {
    r.writeHead(200, { "content-type": "text/event-stream" });
    r.write("data: x\n\n"); // never ends
  });
  const port = await listen(server);
  const res = await new Promise<http.IncomingMessage>((r) => http.get({ port }, r));
  res.on("error", () => undefined);
  const code = await new Promise<number>((resolve) => installShutdown(server, () => undefined, { drainMs: 100, hardMs: 5_000, exit: resolve })());
  assert.equal(code, 0);
});

test("shutdown exits at the hard limit when cleanup hangs", async () => {
  const server = http.createServer();
  await listen(server);
  const keepAlive = setInterval(() => undefined, 1_000); // stands in for the live handles of a real process
  const code = await new Promise<number>((resolve) => installShutdown(server, () => new Promise(() => undefined), { drainMs: 50, hardMs: 200, exit: resolve })());
  clearInterval(keepAlive);
  assert.equal(code, 1);
});

test("an in-flight request finishes before exit, and cleanup waits for it", async () => {
  let cleaned = false;
  const server = http.createServer((_q, r) => setTimeout(() => r.end(cleaned ? "cleaned" : "open"), 1_000));
  const port = await listen(server);
  const body = get(port);
  await new Promise((r) => setTimeout(r, 100));
  let exited = false;
  const done = new Promise<number>((resolve) =>
    installShutdown(server, () => void (cleaned = true), { drainMs: 5_000, hardMs: 10_000, exit: (c) => ((exited = true), resolve(c)) })(),
  );
  assert.equal(exited, false);
  assert.equal(await body, "open");
  assert.equal(await done, 0);
  assert.equal(cleaned, true);
});

test("a busy index file is not deleted", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "filedeck-busy-"));
  const file = path.join(dir, "index.db");
  const a = new DatabaseSync(file); // rollback-journal mode: switching to WAL needs a lock another process holds
  a.exec("CREATE TABLE t (x); INSERT INTO t VALUES (1); BEGIN EXCLUSIVE");
  const ino = fs.statSync(file).ino;
  new IndexCache(file, (async () => []) as never).close();
  assert.equal(fs.statSync(file).ino, ino); // same file: not deleted and recreated
  a.exec("COMMIT");
  assert.equal((a.prepare("SELECT x FROM t").get() as { x: number }).x, 1);
  a.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
