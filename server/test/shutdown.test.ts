import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { installShutdown } from "../src/shutdown.ts";

test("shutdown exits even with an endless stream open", async () => {
  const server = http.createServer((_q, r) => {
    r.writeHead(200, { "content-type": "text/event-stream" });
    r.write("data: x\n\n"); // never ends
  });
  await new Promise<void>((r) => server.listen(0, r));
  const port = (server.address() as AddressInfo).port;
  const res = await new Promise<http.IncomingMessage>((r) => http.get({ port }, r));
  res.on("error", () => undefined);
  const code = await new Promise<number>((resolve) => installShutdown(server, () => undefined, { drainMs: 100, hardMs: 5_000, exit: resolve })());
  assert.equal(code, 0);
});

test("shutdown exits at the hard limit when cleanup hangs", async () => {
  const server = http.createServer();
  await new Promise<void>((r) => server.listen(0, r));
  const keepAlive = setInterval(() => undefined, 1_000); // stands in for the live handles of a real process
  const code = await new Promise<number>((resolve) => installShutdown(server, () => new Promise(() => undefined), { drainMs: 50, hardMs: 200, exit: resolve })());
  clearInterval(keepAlive);
  assert.equal(code, 1);
});
