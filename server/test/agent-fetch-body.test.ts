import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { IncomingMessage } from "node:http";
import { PassThrough } from "node:stream";
import { bodyStream } from "../src/agent-fetch.ts";

const fake = () => new PassThrough() as unknown as IncomingMessage & PassThrough;

test("answer body: the chunks arrive in order and the end closes the stream", async () => {
  const res = fake();
  const rd = bodyStream(res).getReader();
  res.write("a");
  res.end("b");
  const got: string[] = [];
  for (;;) {
    const r = await rd.read();
    if (r.done) break;
    got.push(Buffer.from(r.value).toString());
  }
  assert.equal(got.join(""), "ab");
});

test("answer body: a cut connection fails the stream, and a chunk that still arrives afterwards is ignored", async () => {
  // the event order of a caller that aborts while buffered chunks are still to be delivered
  const res = fake();
  const rd = bodyStream(res).getReader();
  const failed = rd.read().then(
    () => "read",
    () => "failed",
  );
  res.destroy(new Error("cut"));
  assert.equal(await failed, "failed");
  assert.doesNotThrow(() => res.emit("data", Buffer.from("late")));
  assert.doesNotThrow(() => res.emit("end"));
});

test("answer body: cancel destroys the connection, and a later chunk is ignored", async () => {
  const res = fake();
  const rd = bodyStream(res).getReader();
  await rd.cancel();
  assert.equal(res.destroyed, true);
  assert.doesNotThrow(() => res.emit("data", Buffer.from("late")));
});

test("answer body: a real answer cut by the server fails the stream", async () => {
  const srv = http.createServer((_q, s) => {
    s.write("x");
    setTimeout(() => s.destroy(), 20);
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  try {
    const res = await new Promise<IncomingMessage>((r) => http.get({ host: "127.0.0.1", port: (srv.address() as { port: number }).port }, r));
    const rd = bodyStream(res).getReader();
    assert.equal((await rd.read()).done, false);
    await assert.rejects(async () => {
      for (;;) if ((await rd.read()).done) break;
    });
  } finally {
    srv.close();
    srv.closeAllConnections();
  }
});
