import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import type { AddressInfo } from "node:net";
import { agentFetch, CLIENT_IDLE_MS, SERVER_KEEP_ALIVE_MS } from "../src/agent-fetch.ts";

/**
 * A server that, for the second request on a connection, closes it without an answer: the request crossed the server's keep-alive close on the wire, which
 * is what a client sees when it sends on a pooled connection at the moment the server gives it up. (Closing an idle connection earlier is noticed by the
 * client's pool and does not show the race.) The first request of every connection is answered.
 */
async function flaky() {
  const requests: { body: string; nth: number }[] = [];
  const srv = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const nth = ((req.socket as net.Socket & { served?: number }).served = ((req.socket as net.Socket & { served?: number }).served ?? 0) + 1);
      requests.push({ body: Buffer.concat(chunks).toString(), nth });
      if (nth > 1) return void req.socket.destroy();
      res.writeHead(200, { "content-type": "text/plain" }).end("ok");
    });
  });
  srv.keepAliveTimeout = 60_000;
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}/x`;
  return { url, requests, close: () => (srv.closeAllConnections(), srv.close()) };
}

test("a call on a pooled connection the server just closed is repeated once on a new one", async () => {
  const f = await flaky();
  try {
    assert.equal(await (await agentFetch(f.url)).text(), "ok");
    const r = await agentFetch(f.url, { method: "POST", body: "payload" });
    assert.equal(await r.text(), "ok");
    assert.deepEqual(f.requests.map((x) => x.body), ["", "payload", "payload"], "the second try is the repeat, on a new connection");
  } finally {
    f.close();
  }
});

test("a streamed body is never sent twice: it gets a connection of its own", async () => {
  const f = await flaky();
  try {
    assert.equal(await (await agentFetch(f.url)).text(), "ok");
    const body = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new TextEncoder().encode("streamed")); c.close(); } });
    const r = await agentFetch(f.url, { method: "PUT", body, duplex: "half" } as RequestInit);
    assert.equal(await r.text(), "ok");
    assert.equal(f.requests.filter((x) => x.body === "streamed").length, 1);
    assert.equal(f.requests.at(-1)!.nth, 1, "on a connection of its own");
  } finally {
    f.close();
  }
});

test("a reset that comes with no pooled connection behind it is not hidden, and an answered call is never repeated", async () => {
  const srv = http.createServer((_q, res) => res.destroy());
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  let hits = 0;
  srv.on("request", () => hits++);
  try {
    await assert.rejects(agentFetch(`http://127.0.0.1:${(srv.address() as AddressInfo).port}/`));
    assert.equal(hits, 1, "a fresh connection that fails is not tried again");
  } finally {
    srv.closeAllConnections();
    srv.close();
  }
});

test("the server keeps an idle connection longer than the client pool does", () => {
  assert.ok(SERVER_KEEP_ALIVE_MS > CLIENT_IDLE_MS * 2);
});

test("a large streamed upload and an event stream still stream through agentFetch", async () => {
  let received = 0;
  const srv = http.createServer((req, res) => {
    if (req.url === "/events") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("data: one\n\n");
      setTimeout(() => res.end("data: two\n\n"), 50);
      return;
    }
    req.on("data", (c) => (received += c.length));
    req.on("end", () => res.end(String(received)));
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  try {
    const chunk = new Uint8Array(1024 * 1024);
    let n = 0;
    const body = new ReadableStream<Uint8Array>({ pull(c) { if (n++ < 32) c.enqueue(chunk); else c.close(); } });
    assert.equal(await (await agentFetch(base + "/up", { method: "PUT", body, duplex: "half" } as RequestInit)).text(), String(32 * 1024 * 1024));
    const r = await agentFetch(base + "/events");
    const reader = r.body!.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    assert.equal(first, "data: one\n\n", "the first event arrives before the stream ends");
    let rest = "";
    for (let x = await reader.read(); !x.done; x = await reader.read()) rest += new TextDecoder().decode(x.value);
    assert.equal(rest, "data: two\n\n");
  } finally {
    srv.closeAllConnections();
    srv.close();
  }
});
