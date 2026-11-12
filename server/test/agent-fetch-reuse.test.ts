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

test("a POST on a pooled connection the server kills is received once and the call fails: a change is never carried out twice", async () => {
  const f = await flaky();
  try {
    assert.equal(await (await agentFetch(f.url)).text(), "ok");
    await assert.rejects(agentFetch(f.url, { method: "POST", body: "payload" }), /socket hang up|ECONNRESET|EPIPE/);
    assert.equal(f.requests.filter((x) => x.body === "payload").length, 1, "the server received the POST once");
    // the same for a body-less POST, a DELETE and a PUT with a buffer
    for (const [method, body] of [["POST", undefined], ["DELETE", undefined], ["PUT", new Uint8Array([1, 2, 3])]] as const) {
      assert.equal(await (await agentFetch(f.url)).text().catch(() => "x"), "ok");
      const before = f.requests.length;
      await assert.rejects(agentFetch(f.url, { method, body }));
      assert.equal(f.requests.length - before, 1, `${method}: received once`);
    }
  } finally {
    f.close();
  }
});

test("a GET on a pooled connection the server kills is repeated once on a new connection and succeeds", async () => {
  const f = await flaky();
  try {
    assert.equal(await (await agentFetch(f.url)).text(), "ok");
    const r = await agentFetch(f.url);
    assert.equal(await r.text(), "ok");
    assert.deepEqual(f.requests.map((x) => x.nth), [1, 2, 1], "request 1 answered; request 2 hit the killed connection; the repeat was the first on a new one");
    assert.equal(f.requests.length, 3);
  } finally {
    f.close();
  }
});

test("a GET marked replay: false (the one-use zip ticket) is not repeated", async () => {
  const f = await flaky();
  try {
    assert.equal(await (await agentFetch(f.url)).text(), "ok");
    await assert.rejects(agentFetch(f.url, { replay: false }));
    assert.equal(f.requests.length, 2, "received twice in all: the first GET and the one that failed, no repeat");
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

test("an idle connection is dropped when the server announces a shorter keep-alive time than the client's own", async () => {
  let connections = 0;
  const srv = http.createServer((_q, res) => res.writeHead(200, { "keep-alive": "timeout=2" }).end("ok"));
  srv.keepAliveTimeout = 2000;
  srv.on("connection", () => connections++);
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}/`;
  try {
    await (await agentFetch(url)).text();
    await (await agentFetch(url)).text();
    assert.equal(connections, 1, "the second call reused the connection");
    await new Promise((r) => setTimeout(r, 2600)); // longer than the announced 2 s, far shorter than the client's own 30 s
    await (await agentFetch(url)).text();
    assert.equal(connections, 2, "the idle connection was not used again after the announced time");
  } finally {
    srv.closeAllConnections();
    srv.close();
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

test("through the hub: the zip-ticket GET is not repeated, an ordinary GET is, and a bodiless POST uses the pool", async () => {
  const { createHub } = await import("../src/hub.ts");
  const { loadConfig } = await import("../src/config.ts");
  const { serve } = await import("@hono/node-server");
  const f = await flaky();
  const agentPort = new URL(f.url).port;
  const hubApp = createHub(loadConfig({ FILEDECK_MODE: "hub", FILEDECK_STATIC: "/tmp", NODES: `A=http://127.0.0.1:${agentPort}` } as never));
  const hub = await new Promise<ReturnType<typeof serve>>((r) => { const s = serve({ fetch: hubApp.fetch as never, port: 0 }, () => r(s)); });
  const base = `http://127.0.0.1:${(hub.address() as AddressInfo).port}/api/nodes/A`;
  try {
    assert.equal((await fetch(base + "/api/fs/stat?path=/")).status, 200); // opens the pooled connection (answered: first request on it)
    const before = f.requests.length;
    assert.equal((await fetch(base + "/api/fs/zip?ticket=abc")).status, 502, "the one-use ticket GET failed and was not sent again");
    assert.equal(f.requests.length - before, 1, "zip ticket: reached the agent once");
    assert.equal((await fetch(base + "/api/fs/stat?path=/")).status, 200); // a new connection again (answered: first request on it)
    const b1 = f.requests.length;
    assert.equal((await fetch(base + "/api/fs/stat?path=/")).status, 200, "an ordinary GET that meets the killed connection is repeated and succeeds");
    assert.equal(f.requests.length - b1, 2, "GET: killed once, answered on the repeat");
    assert.equal((await fetch(base + "/api/fs/stat?path=/")).status, 200); // pools a connection again
    const b2 = f.requests.length;
    assert.equal((await fetch(base + "/api/jobs/x/cancel", { method: "POST" })).status, 502, "a POST is never repeated");
    assert.equal(f.requests.length - b2, 1, "POST: reached the agent once");
  } finally {
    hub.close();
    f.close();
  }
});
