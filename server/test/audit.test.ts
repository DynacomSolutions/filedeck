import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createAgent } from "../src/agent.ts";
import { loadConfig } from "../src/config.ts";
import { useSandboxOrOff } from "./sandbox-env.ts";
import { chownForTest, fakeResolver, privateTmpdir } from "./worker-env.ts";

await useSandboxOrOff(); // with sign-in on, the agent's file routes run in a worker started through the sandbox launcher

test("audit log records writes, never reads, never contents", async () => {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "filedeck-audit-")));
  const lines: string[] = [];
  const app = createAgent(loadConfig({ FILEDECK_ROOT: tmp, FILEDECK_NODE: "t", FILEDECK_TRUSTED_PROXIES: "1" } as never), (l) => lines.push(l));
  try {
    await app.request("/api/fs/list?path=/");
    await app.request("/api/fs/mkdir", { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": "100.64.0.9, 10.0.0.1" }, body: JSON.stringify({ path: "/made" }) });
    await app.request("/api/fs/upload?dir=/&name=secret.txt", { method: "PUT", body: "TOPSECRET-CONTENT" });
    await app.request("/api/fs/delete", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ paths: ["/nope"] }) });
    assert.equal(lines.length, 3, "the list (a read) is not logged");
    const [mk, up, del] = lines.map((l) => JSON.parse(l));
    assert.equal(mk.audit, true);
    assert.equal(mk.who, "agent:t");
    assert.equal(mk.method, "POST");
    assert.equal(mk.route, "/api/fs/mkdir");
    assert.equal(mk.body.path, "/made");
    assert.equal(mk.ip, "10.0.0.1", "the last hop, not what the caller wrote first");
    assert.equal(mk.forwardedFor, "100.64.0.9, 10.0.0.1");
    assert.equal(mk.status, 201);
    assert.deepEqual(up.query, { dir: "/", name: "secret.txt" });
    assert.equal(up.status, 201);
    assert.equal(del.status, 404);
    assert.ok(!lines.join("\n").includes("TOPSECRET"));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("the forwarded chain is believed only as far as the configured number of proxies; by default the header is ignored", async () => {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "filedeck-audit-xff-")));
  try {
    const ipFor = async (env: Record<string, string>, xff: string) => {
      const lines: string[] = [];
      const app = createAgent(loadConfig({ FILEDECK_ROOT: tmp, FILEDECK_NODE: "t", ...env } as never), (l) => lines.push(l));
      await app.request("/api/fs/mkdir", { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": xff }, body: JSON.stringify({ path: "/m" + lines.length + Math.random().toString(36).slice(2, 6) }) });
      return JSON.parse(lines[0]!) as { ip?: string; forwardedFor?: string };
    };
    const chain = "198.51.100.1, 203.0.113.7, 10.0.0.1";
    const none = await ipFor({}, chain);
    assert.equal(none.ip, undefined, "no proxy configured: a client-written header names nobody (tests have no socket)");
    assert.equal(none.forwardedFor, undefined);
    assert.equal((await ipFor({ FILEDECK_TRUSTED_PROXIES: "1" }, chain)).ip, "10.0.0.1");
    assert.equal((await ipFor({ FILEDECK_TRUSTED_PROXIES: "2" }, chain)).ip, "203.0.113.7");
    assert.equal((await ipFor({ FILEDECK_TRUSTED_PROXIES: "5" }, chain)).ip, undefined, "a chain shorter than the trusted depth is not believed");
    // a proxy that writes address:port, a bracketed IPv6 address, or something that is not an address
    const one = (xff: string) => ipFor({ FILEDECK_TRUSTED_PROXIES: "1" }, xff).then((x) => x.ip);
    assert.equal(await one("203.0.113.7:51234"), "203.0.113.7");
    assert.equal(await one("[2001:db8::7]:443"), "2001:db8::7");
    assert.equal(await one("[2001:db8::7]"), "2001:db8::7");
    assert.equal(await one("2001:db8::7"), "2001:db8::7");
    assert.equal(await one("198.51.100.1, 203.0.113.7:80"), "203.0.113.7");
    assert.equal(await one("unknown"), undefined, "not an address: the socket peer (none in tests)");
    assert.equal(await one("203.0.113.7:99999x"), undefined);
    assert.equal(await one("evil.example, <script>"), undefined);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("audit user: hub and agent lines both name the account", async () => {
  const { createHub } = await import("../src/hub.ts");
  const { serve } = await import("@hono/node-server");
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "filedeck-audit-user-")));
  const T = "agent-secret-audit";
  const agentLines: string[] = [];
  const hubLines: string[] = [];
  const root = path.join(tmp, "root");
  fs.mkdirSync(root);
  fs.chmodSync(tmp, 0o755);
  chownForTest(root); // (a root suite runs its workers as nobody)
  const dropTmp = privateTmpdir(); // the workers' folders go with it
  const agent = createAgent(loadConfig({ FILEDECK_ROOT: root, FILEDECK_NODE: "A", FILEDECK_AGENT_TOKEN: T, FILEDECK_AUTH: "on" } as never), (l) => agentLines.push(l), {
    accounts: fakeResolver({ guest: {} }),
  });
  const srv = await new Promise<ReturnType<typeof serve>>((res) => {
    const s = serve({ fetch: agent.fetch, port: 0 }, () => res(s));
  });
  const hub = createHub(loadConfig({ FILEDECK_MODE: "hub", FILEDECK_AUTH: "on", FILEDECK_AGENT_TOKEN: T, FILEDECK_STATIC: tmp, NODES: `A=http://127.0.0.1:${(srv.address() as { port: number }).port}` } as never), undefined, (l) => hubLines.push(l));
  try {
    hub.auth!.accounts.create({ name: "guest1", password: "pw-guest1-123", admin: false, nodes: { A: { runAs: "guest", grants: [{ path: "/", write: true }] } } });
    const cookie = `__Host-filedeck=${hub.auth!.sessions.create("virt", "guest1")}`;
    const peer = { incoming: { socket: { remoteAddress: "127.0.0.1", encrypted: false } } };
    const r = await hub.request("http://localhost/api/nodes/A/api/fs/mkdir", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ path: "/made" }) }, peer as never);
    assert.equal(r.status, 201);
    const h = hubLines.map((l) => JSON.parse(l)).find((l) => l.route.endsWith("/api/fs/mkdir"));
    const a = agentLines.map((l) => JSON.parse(l)).find((l) => l.route === "/api/fs/mkdir");
    assert.equal(h.user, "virt:guest1");
    assert.equal(a.user, "virt:guest1");
    assert.ok(!hubLines.concat(agentLines).join("\n").includes("pw-guest1"));
  } finally {
    await hub.close();
    await (agent as unknown as { close(): Promise<void> }).close();
    dropTmp();
    srv.close();
    (srv as unknown as { closeAllConnections?(): void }).closeAllConnections?.();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("audit leaves the user out when there is none", async () => {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "filedeck-audit-nouser-")));
  const lines: string[] = [];
  try {
    const app = createAgent(loadConfig({ FILEDECK_ROOT: tmp, FILEDECK_NODE: "t" } as never), (l) => lines.push(l));
    await app.request("/api/fs/mkdir", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: "/m" }) });
    assert.ok(!("user" in JSON.parse(lines[0]!)));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("a sign-in body keeps only its name: a string or an array body gives no body, never the secret", async () => {
  const { createHub } = await import("../src/hub.ts");
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "filedeck-audit-signin-")));
  const lines: string[] = [];
  const hub = createHub(loadConfig({ FILEDECK_MODE: "hub", FILEDECK_AUTH: "on", FILEDECK_AGENT_TOKEN: "agent-secret-signin", FILEDECK_STATIC: tmp } as never), undefined, (l) => lines.push(l));
  const SECRET = "pw-audit-signin-secret";
  const peer = { incoming: { socket: { remoteAddress: "127.0.0.1", encrypted: false } } };
  try {
    for (const body of [SECRET, [SECRET, "alice"], { name: "alice", password: SECRET }, { name: ["x", SECRET], password: SECRET }]) {
      lines.length = 0;
      await hub.request("http://localhost/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }, peer as never);
      const line = lines.map((l) => JSON.parse(l)).find((l) => l.route === "/api/auth/login");
      assert.ok(line, `an audit line for ${JSON.stringify(body)}`);
      assert.ok(line.body === undefined || JSON.stringify(Object.keys(line.body)) === '["name"]', JSON.stringify(line.body));
      if (!Array.isArray(body) && typeof body === "object" && typeof body.name === "string") assert.deepEqual(line.body, { name: "alice" });
      else assert.equal(line.body, undefined);
      assert.ok(!lines.join("\n").includes(SECRET), JSON.stringify(body));
    }
  } finally {
    await hub.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
