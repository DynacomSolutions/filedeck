import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import tls from "node:tls";
import type { AddressInfo } from "node:net";
import { boot, makeCert } from "./mcp-support.ts";
import { loadConfig } from "../src/config.ts";
import { createMcp } from "../src/mcp/index.ts";

// the test certificate is self-signed: this process (one test file) accepts it
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

const fingerprint = (port: number) =>
  new Promise<string>((resolve, reject) => {
    const s = tls.connect({ host: "127.0.0.1", port, rejectUnauthorized: false }, () => {
      const f = s.getPeerCertificate().fingerprint256;
      s.destroy();
      resolve(f);
    });
    s.on("error", reject);
    s.setTimeout(3000, () => {
      s.destroy();
      reject(new Error("no TLS answer in 3 seconds"));
    });
  });

test("TLS: the listener serves HTTPS, tools work over it, and plain HTTP does not", async (t) => {
  const b = await boot({ tls: true });
  t.after(() => b.close());
  assert.match(b.url, /^https:/);
  const c = await b.connect();
  const nodes = (await c.client.callTool({ name: "filedeck_nodes", arguments: {} })) as unknown as { structuredContent: { nodes: unknown[] } };
  assert.equal(nodes.structuredContent.nodes.length, 1);
  assert.equal((await fetch(b.url + "/mcp/healthz")).status, 200, "the probes are on HTTPS too");
  await c.client.subscribeResource({ uri: "filedeck://nodes/n/status" });

  // the same port with plain HTTP gets no MCP answer: the TLS server cannot read an HTTP request
  const port = Number(new URL(b.url).port);
  const plain = await new Promise<string>((resolve) => {
    const req = http.get({ host: "127.0.0.1", port, path: "/mcp/healthz", agent: false }, (res) => {
      res.resume();
      resolve(`status ${res.statusCode}`);
    });
    req.on("error", (e) => resolve(`error ${(e as NodeJS.ErrnoException).code ?? e.message}`));
    req.setTimeout(2000, () => {
      req.destroy();
      resolve("timeout");
    });
  });
  assert.doesNotMatch(plain, /status 200/, `plain HTTP must not be answered: ${plain}`);
});

test("without TLS the listener is refused unless plain HTTP is allowed by the test switch", async (t) => {
  const b = await boot(); // allowed: FILEDECK_MCP_ALLOW_PLAINTEXT=1
  t.after(() => b.close());
  assert.match(b.url, /^http:/);
  const lines: string[] = [];
  const stub = { fetch: () => new Response(), addMetrics: () => undefined };
  const env = { FILEDECK_MODE: "hub", NODES: "n=http://127.0.0.1:1", FILEDECK_MCP_PORT: "9092", FILEDECK_MCP_GRANTS_FILE: b.dir + "/grants.json" };
  assert.equal(await createMcp(loadConfig(env), stub, { log: (m) => lines.push(m) }), undefined);
  assert.match(lines[0]!, /never serves plain HTTP/);
  const allowed = await createMcp(loadConfig({ ...env, FILEDECK_MCP_ALLOW_PLAINTEXT: "1" }), stub, { log: () => undefined });
  try {
    assert.ok(allowed);
  } finally {
    await allowed?.stop(); // also when the check fails: its grants timer and its server must not keep the test file open
  }
});

test("TLS: a renewed certificate is used by new connections with no restart", async (t) => {
  const b = await boot({ tls: true });
  t.after(() => b.close());
  const port = Number((b.mcp.server.address() as AddressInfo).port);
  const before = await fingerprint(port);
  const renewed = makeCert(b.dir, "renewed");
  fs.copyFileSync(renewed.key, b.tls!.key);
  fs.copyFileSync(renewed.cert, b.tls!.cert);
  let after = before;
  for (let i = 0; i < 60 && after === before; i++) {
    await new Promise((r) => setTimeout(r, 100));
    after = await fingerprint(port);
  }
  assert.notEqual(after, before, "the new certificate is served");
  // the old session and a new one both work
  const c = await b.connect();
  assert.equal(((await c.client.callTool({ name: "filedeck_nodes", arguments: {} })) as { isError?: boolean }).isError, undefined);
  // a broken pair is not used: the last good certificate stays
  fs.writeFileSync(b.tls!.cert, "not a certificate");
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(await fingerprint(port), after);
});

test("a boot that fails leaves no server or timer behind (a failing test never hangs the file)", async () => {
  await assert.rejects(boot({ tls: true, env: { FILEDECK_MCP_TLS_CERT: "/nonexistent/tls.crt" } }), /createMcp returned no server/);
  // if a handle were left, this file would not end: the test runner waits for it (the file has a 600 s limit in `npm test`)
});
