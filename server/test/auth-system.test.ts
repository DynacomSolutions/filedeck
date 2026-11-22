import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { generateKeyPairSync, sign } from "node:crypto";
import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import { createAgent } from "../src/agent.ts";
import { createHub } from "../src/hub.ts";
import { loadConfig } from "../src/config.ts";
import { HostPam } from "../src/host-pam.ts";
import { KeyCheck } from "../src/agent-keys.ts";
import { loginMessage } from "../src/auth/sshkey.ts";
import { USER_HEADER } from "../src/auth/identity.ts";
import { AgentSystemAuth, CALL_TIMEOUT_MS, TOTAL_MS } from "../src/auth/system.ts";
import type { LocalAccount } from "../src/local-accounts.ts";
import { fakeResolver, privateTmpdir, withSignIn } from "./worker-env.ts";

/**
 * work-item: the hub signs system users in by asking the agents in the sign-in order (password through PAM, key through the user's own
 * authorized_keys), and a name that resolves to uid 0 never signs in. Two real agents (fake PAM, fake key reader) behind a recording
 * wrapper, and a real hub over them.
 */
const T = "agent-secret-auth-system";
const PW = "correct horse battery staple";
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "filedeck-authsys-")));
fs.writeFileSync(path.join(tmp, "index.html"), "<!doctype html><title>t</title>");
const dropTmp = privateTmpdir();

type Server = ReturnType<typeof serve>;
const servers: Server[] = [];
const closers: { close(): Promise<void> }[] = [];
after(async () => {
  for (const h of closers) await h.close().catch(() => {});
  for (const s of servers) {
    s.close();
    (s as unknown as { closeAllConnections?(): void }).closeAllConnections?.();
  }
  fs.rmSync(tmp, { recursive: true, force: true });
  dropTmp();
});

function sshKey() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const raw = Buffer.from(publicKey.export({ format: "jwk" }).x as string, "base64url");
  const f = (b: Buffer) => {
    const l = Buffer.alloc(4);
    l.writeUInt32BE(b.length);
    return Buffer.concat([l, b]);
  };
  return { line: `ssh-ed25519 ${Buffer.concat([f(Buffer.from("ssh-ed25519")), f(raw)]).toString("base64")}`, privateKey };
}
const KEY = sshKey();

interface Rec {
  node: string;
  path: string;
  headers: Record<string, string>;
  body: string;
}
/** Every request any agent got, in order. */
const seen: Rec[] = [];
/** The sign-in calls the agents got. The presence lookups a sign-in starts (auth-presence.test.ts) run on their own time, so they are left out. */
const authRecs = () => seen.filter((r) => r.path.startsWith("/api/auth/") && r.path !== "/api/auth/lookup");

interface FakeAgent {
  url: string;
  pamCalls: string[];
  lines: string[];
}

/**
 * A real agent with sign-in on. `accounts` are the names that exist there; `goodPw` is what its PAM accepts for each name (a name
 * missing from it fails); every account lists KEY in its authorized_keys.
 */
async function agent(node: string, accounts: Record<string, Partial<LocalAccount>>, goodPw: Record<string, string>): Promise<FakeAgent> {
  const root = path.join(tmp, `agent-${node}`);
  fs.mkdirSync(root);
  const resolver = fakeResolver(accounts);
  const pamCalls: string[] = [];
  const pam = new HostPam({
    // a PAM that knows nothing of uid 0: the agent itself must refuse such a name before it runs
    run: async (name, stdin) => (pamCalls.push(name), { code: goodPw[name] === stdin.toString() ? 0 : 1 }),
    log: () => {},
  });
  const keys = new KeyCheck({ root, accounts: resolver, read: async (_r, _a, _f, _m, o) => (o.closed(), `${KEY.line} me\n`), log: () => {} });
  const lines: string[] = [];
  const app = createAgent(loadConfig({ FILEDECK_ROOT: root, FILEDECK_NODE: node, FILEDECK_AGENT_TOKEN: T, FILEDECK_AUTH: "on" } as never), (l) => lines.push(l), { accounts: resolver, pam, keys });
  closers.push(app as unknown as { close(): Promise<void> });
  const a: FakeAgent = { url: "", pamCalls, lines };
  const srv = await new Promise<Server>((res) => {
    const s: Server = serve(
      {
        fetch: async (req: Request, env: unknown) => {
          const headers: Record<string, string> = {};
          req.headers.forEach((v, k) => (headers[k] = v));
          seen.push({ node, path: new URL(req.url).pathname, headers, body: await req.clone().text() });
          return app.fetch(req, env as never);
        },
        port: 0,
      },
      () => res(s),
    );
  });
  servers.push(srv);
  a.url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  return a;
}

/** A URL nothing listens on. */
async function deadUrl(): Promise<string> {
  const s = net.createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const port = (s.address() as AddressInfo).port;
  await new Promise<void>((r) => s.close(() => r()));
  return `http://127.0.0.1:${port}`;
}

// alice: only on a. bob: on both; b's PAM takes "pw-b", a's takes PW. toor: uid 0 on both, and both "PAMs" would take PW.
// zed: uid 0 on b only, an ordinary account with PW on a. gzed: a member of group 0 on b only.
const A = await agent("a", { alice: {}, bob: {}, toor: { uid: 0 }, zed: {}, gzed: {} }, { alice: PW, bob: PW, toor: PW, zed: PW, gzed: PW });
const B = await agent("b", { bob: {}, toor: { uid: 0 }, zed: { uid: 0 }, gzed: { groups: [4242, 0] } }, { bob: "pw-b", toor: PW, zed: PW, gzed: PW });

type Hub = ReturnType<typeof createHub>;
function makeHub(nodes: string, env: Record<string, string> = {}, sink?: (l: string) => void): Hub {
  const h = createHub(
    loadConfig({ FILEDECK_MODE: "hub", FILEDECK_AUTH: "on", FILEDECK_AGENT_TOKEN: T, FILEDECK_STATIC: tmp, NODES: nodes, FILEDECK_DIFF_DIR: path.join(tmp, `diff-${closers.length}`), ...env } as never),
    undefined,
    sink ?? (() => {}),
  );
  closers.push(h);
  return h;
}
const peer = { incoming: { socket: { remoteAddress: "127.0.0.1", encrypted: false } } };
const post = async (h: Hub, p: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> =>
  h.request("http://localhost" + p, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) }, peer as never);

async function timed<T>(fn: () => Promise<T>): Promise<[T, number]> {
  const t0 = performance.now();
  const v = await fn();
  return [v, performance.now() - t0];
}

const hub = makeHub(`a=${A.url},b=${B.url}`, { FILEDECK_AUTH_NODES: "b,a" });

/** A challenge and a good signature for `name`, as the web app makes them. */
async function signed(h: Hub, name: string): Promise<{ challenge: string; signature: string; hubId: string }> {
  const { challenge, hubId } = (await (await post(h, "/api/auth/challenge", { name })).json()) as { challenge: string; hubId: string };
  return { challenge, hubId, signature: sign(null, loginMessage(hubId, name, Buffer.from(challenge, "base64")), KEY.privateKey).toString("base64") };
}

test("order: FILEDECK_AUTH_NODES decides; unknown goes on, fail stops", async () => {
  seen.length = 0;
  const r = await post(hub, "/api/auth/login", { name: "alice", password: PW });
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { auth: true, kind: "sys", name: "alice", admin: false });
  assert.match(r.headers.get("set-cookie") ?? "", /^__Host-filedeck=/);
  assert.deepEqual(
    authRecs().map((x) => [x.node, x.path]),
    [
      ["b", "/api/auth/password"],
      ["a", "/api/auth/password"],
    ],
  );
  // a wrong password on b (fail) stops: a, whose PAM would take it, is never asked
  seen.length = 0;
  const [w, ms] = await timed(() => post(hub, "/api/auth/login", { name: "bob", password: PW }));
  assert.equal(w.status, 401);
  assert.deepEqual(await w.json(), { error: "sign-in failed" });
  assert.ok(ms >= 490, `${ms} ms`);
  assert.deepEqual(
    authRecs().map((x) => x.node),
    ["b"],
  );
  // the right password for b signs bob in there
  assert.equal((await post(hub, "/api/auth/login", { name: "bob", password: "pw-b" })).status, 200);
});

test("order: without FILEDECK_AUTH_NODES the order of NODES; an unknown name in it stops the hub", async () => {
  const h = makeHub(`a=${A.url},b=${B.url}`);
  seen.length = 0;
  assert.equal((await post(h, "/api/auth/login", { name: "bob", password: PW })).status, 200);
  assert.deepEqual(
    authRecs().map((x) => x.node),
    ["a"],
  );
  assert.throws(() => makeHub(`a=${A.url},b=${B.url}`, { FILEDECK_AUTH_NODES: "b,zz" }), /FILEDECK_AUTH_NODES names an unknown node: zz/);
  // inert with sign-in off
  const off = createHub(loadConfig({ FILEDECK_MODE: "hub", FILEDECK_STATIC: tmp, NODES: `a=${A.url}`, FILEDECK_AUTH_NODES: "zz" } as never), undefined, () => {});
  closers.push(off);
});

test("unreachable node is skipped", async () => {
  const h = makeHub(`b=${await deadUrl()},a=${A.url}`, { FILEDECK_AUTH_NODES: "b,a" });
  const r = await post(h, "/api/auth/login", { name: "alice", password: PW });
  assert.equal(r.status, 200);
  const k = await signed(h, "alice");
  assert.equal((await post(h, "/api/auth/login-key", { name: "alice", publicKey: KEY.line, challenge: k.challenge, signature: k.signature })).status, 200);
});

test("uid 0 never signs in", async () => {
  A.pamCalls.length = 0;
  B.pamCalls.length = 0;
  const [p, pms] = await timed(() => post(hub, "/api/auth/login", { name: "toor", password: PW }));
  assert.equal(p.status, 401);
  assert.deepEqual(await p.json(), { error: "sign-in failed" });
  assert.ok(pms >= 490, `${pms} ms`);
  // the agents refuse the name before PAM runs
  assert.deepEqual([...A.pamCalls, ...B.pamCalls], []);
  const k = await signed(hub, "toor");
  const [q, kms] = await timed(() => post(hub, "/api/auth/login-key", { name: "toor", publicKey: KEY.line, challenge: k.challenge, signature: k.signature }));
  assert.equal(q.status, 401);
  assert.deepEqual(await q.json(), { error: "sign-in failed" });
  assert.ok(kms >= 490, `${kms} ms`);
  // root itself never reaches an agent
  seen.length = 0;
  assert.equal((await post(hub, "/api/auth/login", { name: "root", password: PW })).status, 401);
  assert.deepEqual(authRecs(), []);
  // the lookup says no for uid 0, gid 0 and group 0, and for a name that is not there
  const look = (u: string, body: unknown, auth = `Bearer ${T}`) =>
    fetch(`${u}/api/auth/lookup`, { method: "POST", headers: { "content-type": "application/json", authorization: auth }, body: JSON.stringify(body) });
  const exists = async (u: string, name: string) => ((await (await look(u, { name })).json()) as { exists: boolean }).exists;
  assert.equal(await exists(A.url, "toor"), false);
  assert.equal(await exists(B.url, "toor"), false);
  assert.equal(await exists(A.url, "alice"), true);
  assert.equal(await exists(B.url, "alice"), false);
  assert.deepEqual(await (await look(B.url, { name: "toor" })).json(), { exists: false, refused: true });
});

test("uid 0 on one machine asked ends the search: refused stops like fail", async () => {
  for (const name of ["zed", "gzed"]) {
    // the agent itself says refused, for the password and the key
    const direct = (route: string, body: unknown) =>
      fetch(`${B.url}/api/auth/${route}`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${T}` }, body: JSON.stringify(body) }).then((r) => r.json());
    assert.deepEqual(await direct("password", { name, password: PW, address: "203.0.113.7" }), { result: "refused" }, name);
    const msg = loginMessage("h", name, Buffer.alloc(32, 1));
    assert.deepEqual(await direct("key", { name, publicKey: KEY.line, message: msg.toString("base64"), signature: sign(null, msg, KEY.privateKey).toString("base64") }), { result: "refused" }, name);
    // b (uid 0 or group 0 there) first: no sign-in, although a would take the password and the key
    const h = makeHub(`a=${A.url},b=${B.url}`, { FILEDECK_AUTH_NODES: "b,a" });
    seen.length = 0;
    const [p, ms] = await timed(() => post(h, "/api/auth/login", { name, password: PW }));
    assert.equal(p.status, 401, name);
    assert.deepEqual(await p.json(), { error: "sign-in failed" });
    assert.ok(ms >= 480, `${ms} ms`);
    const k = await signed(h, name);
    const [q, kms] = await timed(() => post(h, "/api/auth/login-key", { name, publicKey: KEY.line, challenge: k.challenge, signature: k.signature }));
    assert.equal(q.status, 401, name);
    assert.ok(kms >= 480, `${kms} ms`);
    assert.deepEqual(
      authRecs().map((x) => x.node),
      ["b", "b"],
      "a is never asked",
    );
    // only the machines asked count: with a first, a answers ok and b is never asked
    const first = makeHub(`a=${A.url},b=${B.url}`, { FILEDECK_AUTH_NODES: "a,b" });
    assert.equal((await post(first, "/api/auth/login", { name, password: PW })).status, 200, name);
  }
});

test("lookup: a root route behind the agent token, strict body, a failing lookup is 503", async () => {
  const lines: string[] = [];
  const logs: string[] = [];
  const accounts = withSignIn({
    async resolve(name: string): Promise<LocalAccount | null> {
      if (name === "broken") throw new Error("nss: no answer");
      if (name === "gid0") return { name, uid: 1500, gid: 0, groups: [], home: "/home/x" };
      if (name === "grp0") return { name, uid: 1500, gid: 1500, groups: [1500, 0], home: "/home/x" };
      if (name === "uid0") return { name, uid: 0, gid: 1500, groups: [1500], home: "/home/x" };
      return name === "carol" ? { name, uid: 1500, gid: 1500, groups: [1500], home: "/home/x" } : null;
    },
  });
  const app = createAgent(loadConfig({ FILEDECK_ROOT: tmp, FILEDECK_NODE: "l", FILEDECK_AGENT_TOKEN: T, FILEDECK_AUTH: "on" } as never), (l) => lines.push(l), { accounts });
  closers.push(app as unknown as { close(): Promise<void> });
  const origError = console.error;
  console.error = (...a: unknown[]) => void logs.push(a.join(" "));
  try {
    const look = (body: unknown, headers: Record<string, string> = { authorization: `Bearer ${T}` }) =>
      app.request("/api/auth/lookup", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });
    assert.deepEqual(await (await look({ name: "carol" })).json(), { exists: true });
    for (const n of ["uid0", "gid0", "grp0"]) assert.deepEqual(await (await look({ name: n })).json(), { exists: false, refused: true }, n);
    assert.deepEqual(await (await look({ name: "nobody-here" })).json(), { exists: false });
    // a lookup that fails is no answer: 503, so the hub's presence asks again soon rather than hiding the machine
    const broken = await look({ name: "broken" });
    assert.equal(broken.status, 503);
    assert.equal(((await broken.json()) as { exists?: unknown }).exists, undefined);
    assert.equal(logs.filter((l) => l.includes("broken")).length, 1, logs.join("\n"));
    assert.ok(logs.some((l) => l.includes("nss: no answer")));
    assert.equal((await look({ name: "carol" }, {})).status, 401);
    assert.equal((await look({ name: "carol" }, { authorization: "Bearer nope" })).status, 401);
    const SECRET = "s3cret-in-body";
    for (const body of [{}, { name: 5 }, { name: SECRET.toUpperCase() + "/" }, [SECRET], { name: "carol", extra: SECRET }, "not json " + SECRET, { name: "-x" }]) {
      const r = await look(body);
      assert.equal(r.status, 400, JSON.stringify(body));
      const t = await r.text();
      assert.ok(!t.includes(SECRET) && !t.includes(SECRET.toUpperCase()), t);
    }
    assert.ok(!lines.join("\n").includes(SECRET), "no audit line holds more than the name");
    const line = lines.find((l) => l.includes("/api/auth/lookup") && l.includes("carol"));
    assert.ok(line, lines.join("\n"));
    assert.deepEqual(JSON.parse(line).body, { name: "carol" });
  } finally {
    console.error = origError;
  }
});

test("key sign-in: the hub builds the message; a message from the client is never used", async () => {
  // (a hub of its own: the limiter of the shared one has counted the failures of the tests above)
  const hub = makeHub(`a=${A.url},b=${B.url}`, { FILEDECK_AUTH_NODES: "b,a" });
  seen.length = 0;
  const k = await signed(hub, "alice");
  // the client also sends a message of its own (for another hub and challenge), signed: it is ignored
  const otherMsg = loginMessage("another-hub", "alice", Buffer.alloc(32, 7));
  const otherSig = sign(null, otherMsg, KEY.privateKey).toString("base64");
  const bad = await post(hub, "/api/auth/login-key", { name: "alice", publicKey: KEY.line, challenge: k.challenge, signature: otherSig, message: otherMsg.toString("base64") });
  assert.equal(bad.status, 401);
  // (its signature is not over the hub's message, so the hub's own check fails it before any agent is asked)
  assert.deepEqual(authRecs(), []);
  // the same client message with the hub's own signature: the challenge is used up, so a new one
  seen.length = 0;
  const k2 = await signed(hub, "alice");
  const ok = await post(hub, "/api/auth/login-key", { name: "alice", publicKey: KEY.line, challenge: k2.challenge, signature: k2.signature, message: otherMsg.toString("base64") });
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { auth: true, kind: "sys", name: "alice", admin: false });
  assert.deepEqual(
    authRecs().map((x) => [x.node, JSON.parse(x.body).message]),
    [
      ["b", loginMessage(k2.hubId, "alice", Buffer.from(k2.challenge, "base64")).toString("base64")],
      ["a", loginMessage(k2.hubId, "alice", Buffer.from(k2.challenge, "base64")).toString("base64")],
    ],
  );
});

test("no user header on sign-in calls, no cookie or client header, bodies hold only what the route needs", async () => {
  const hubLines: string[] = [];
  const hub = makeHub(`a=${A.url},b=${B.url}`, { FILEDECK_AUTH_NODES: "b,a" }, (l) => hubLines.push(l));
  const cookie = `__Host-filedeck=${hub.auth!.sessions.create("sys", "alice")}`;
  const client = { cookie, "x-forwarded-for": "203.0.113.9", "x-client-thing": "leak-me", authorization: "Bearer client-token", [USER_HEADER]: "forged", "x-filedeck-password": "leak-me" };
  seen.length = 0;
  assert.equal((await post(hub, "/api/auth/login", { name: "alice", password: PW, extra: "leak-me" }, client)).status, 200);
  const k = await signed(hub, "alice");
  assert.equal((await post(hub, "/api/auth/login-key", { name: "alice", publicKey: KEY.line, challenge: k.challenge, signature: k.signature, extra: "leak-me" }, client)).status, 200);
  const recs = authRecs();
  assert.equal(recs.length, 4);
  for (const r of recs) {
    assert.equal(r.headers[USER_HEADER], undefined, r.path);
    assert.equal(r.headers.cookie, undefined);
    assert.equal(r.headers.authorization, `Bearer ${T}`);
    assert.ok(!JSON.stringify(r.headers).includes("leak-me"), JSON.stringify(r.headers));
    assert.ok(!JSON.stringify(r.headers).includes("203.0.113.9"), JSON.stringify(r.headers));
    assert.ok(!r.body.includes("leak-me"));
    const keys = Object.keys(JSON.parse(r.body)).sort();
    assert.deepEqual(keys, r.path === "/api/auth/password" ? ["address", "name", "password"] : ["message", "name", "publicKey", "signature"]);
    // the password check carries the client's address as the hub sees it (no trusted proxy here: the socket's peer, not the forwarded one)
    if (r.path === "/api/auth/password") assert.equal(JSON.parse(r.body).address, "127.0.0.1");
  }
  assert.ok(hubLines.length > 0);
  assert.ok(!hubLines.join("\n").includes(PW), "no hub audit line holds the password");
  for (const a of [A, B]) assert.ok(!a.lines.join("\n").includes(PW), "no agent audit line holds the password");
});

test("the hub never forwards a client to an agent's sign-in routes", async () => {
  const cookie = `__Host-filedeck=${hub.auth!.sessions.create("sys", "alice")}`;
  seen.length = 0;
  for (const p of ["/api/auth/password", "/api/auth/lookup", "/api/auth/key", "/api/%61uth/password", "//api/auth/password", "/API/auth/lookup", "/api/auth", "/api/auth/password/", "/api%2Fauth/password", "/api%2fauth/lookup", "/api/x%2f..%2fauth/password", "/api%5cauth/password", "/api/x/%2e%2e/auth/key"]) {
    const r = await hub.request(`http://localhost/api/nodes/a${p}`, { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ name: "bob", password: PW }) }, peer as never);
    assert.equal(r.status, 404, p);
  }
  assert.deepEqual(seen, []);
});

test("every other agent call refuses the sign-in routes too (not only the proxy)", async () => {
  const target = hub.nodeTargets.get("a");
  assert.ok(target);
  seen.length = 0;
  for (const p of ["/api/auth/password", "/api/auth/lookup?x=1", "/api%2Fauth/key", "/api/x%2f..%2fauth/password", "/api%5cauth/password", "/api/auth/password/"]) {
    await assert.rejects(target.fetch(p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "bob", password: PW }) }), /sign-in routes are not forwarded/, p);
  }
  assert.deepEqual(seen, []);
});

test("key sign-in: the hub checks a system account's signature first; a bad one asks no agent and still counts", async () => {
  const h = makeHub(`a=${A.url},b=${B.url}`, { FILEDECK_AUTH_NODES: "b,a" });
  const other = sshKey();
  seen.length = 0;
  for (let i = 0; i < 5; i++) {
    const k = await signed(h, "alice");
    const bad = sign(null, loginMessage(k.hubId, "alice", Buffer.from(k.challenge, "base64")), other.privateKey).toString("base64");
    const [r, ms] = await timed(() => post(h, "/api/auth/login-key", { name: "alice", publicKey: KEY.line, challenge: k.challenge, signature: bad }));
    assert.equal(r.status, 401);
    assert.deepEqual(await r.json(), { error: "sign-in failed" });
    assert.ok(ms >= 480, `${ms} ms`);
  }
  assert.deepEqual(authRecs(), [], "no agent was asked");
  // the five failures were counted: the next attempt, even a good one, is refused
  const k = await signed(h, "alice");
  assert.equal((await post(h, "/api/auth/login-key", { name: "alice", publicKey: KEY.line, challenge: k.challenge, signature: k.signature })).status, 429);
});

// --- AgentSystemAuth on its own: how answers, slow nodes and the total limit drive the order ---

type Answer = Response | "hang" | "throw";
function fakeCall(answers: Record<string, Answer>) {
  const asked: string[] = [];
  const call = async (node: string, _p: string, _b: unknown, signal?: AbortSignal): Promise<Response> => {
    asked.push(node);
    const a = answers[node];
    if (a === "throw" || a === undefined) throw new Error("connect ECONNREFUSED");
    if (a === "hang") return new Promise<Response>((_, rej) => signal?.addEventListener("abort", () => rej(new Error("aborted"))));
    return a;
  };
  return { asked, call };
}
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });

test("AgentSystemAuth: a password check carries the client's address; a key check carries none", async () => {
  const bodies: unknown[] = [];
  const call = async (_node: string, _p: string, b: unknown) => (bodies.push(b), json({ result: "ok" }));
  const s = new AgentSystemAuth({ nodes: ["x"], call, log: () => {} });
  assert.equal(await s.password("alice", PW, "203.0.113.7"), true);
  assert.equal(await s.key("alice", KEY.line, Buffer.from("m"), Buffer.from("s")), true);
  assert.deepEqual(bodies[0], { name: "alice", password: PW, address: "203.0.113.7" });
  assert.equal((bodies[1] as Record<string, unknown>).address, undefined);
});

test("the hub sends the client's address behind a trusted proxy, and a real agent refuses a check without one", async () => {
  const h = makeHub(`a=${A.url}`, { FILEDECK_TRUSTED_PROXIES: "1" });
  seen.length = 0;
  assert.equal((await post(h, "/api/auth/login", { name: "alice", password: PW }, { "x-forwarded-for": "198.51.100.23", "x-forwarded-proto": "https" })).status, 200);
  const pw = authRecs().filter((r) => r.path === "/api/auth/password");
  assert.equal(pw.length, 1);
  assert.equal(JSON.parse(pw[0]!.body).address, "198.51.100.23");
  // straight to the agent without an address: 400, PAM never runs
  const before = A.pamCalls.length;
  const r = await fetch(`${A.url}/api/auth/password`, { method: "POST", headers: { authorization: `Bearer ${T}`, "content-type": "application/json" }, body: JSON.stringify({ name: "alice", password: PW }) });
  assert.equal(r.status, 400);
  assert.equal(A.pamCalls.length, before);
});

test("the hub sends an IPv4-mapped client address in its plain IPv4 form", async () => {
  const h = makeHub(`a=${A.url}`);
  seen.length = 0;
  const mapped = { incoming: { socket: { remoteAddress: "::ffff:198.51.100.2", encrypted: true } } };
  const r = await h.request("http://localhost/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "alice", password: PW }) }, mapped as never);
  assert.equal(r.status, 200);
  const pw = authRecs().filter((x) => x.path === "/api/auth/password");
  assert.equal(pw.length, 1);
  assert.equal(JSON.parse(pw[0]!.body).address, "198.51.100.2");
});

test("AgentSystemAuth: limits are 15 s per call and 20 s in all", () => {
  assert.equal(CALL_TIMEOUT_MS, 15_000);
  assert.equal(TOTAL_MS, 20_000);
});

test("AgentSystemAuth: only ok signs in, only fail stops; anything else goes on to the next", async () => {
  // Each case builds a fresh Response: a clone shares a tee'd body, and cancelling one branch waits for the other.
  const cases: [() => Answer, boolean][] = [
    [() => json({ result: "unknown" }), true],
    [() => json({ result: "unavailable" }), true],
    [() => json({ result: "ok" }, 500), true],
    [() => json({ result: "ok" }, 201), true],
    [() => new Response("not json", { status: 200 }), true],
    [() => json({ answer: "ok" }), true],
    [() => "throw", true],
    [() => json({ result: "fail" }), false],
    [() => json({ result: "refused" }), false],
  ];
  for (const [make, next] of cases) {
    for (const m of ["password", "key"] as const) {
      const first = make();
      const { asked, call } = fakeCall({ x: first, y: json({ result: "ok" }) });
      const s = new AgentSystemAuth({ nodes: ["x", "y"], call, log: () => {} });
      const got = m === "password" ? await s.password("alice", PW) : await s.key("alice", KEY.line, Buffer.from("m"), Buffer.from("s"));
      assert.equal(got, next, `${m} after ${typeof first === "string" ? first : first.status}`);
      assert.deepEqual(asked, next ? ["x", "y"] : ["x"]);
    }
  }
  const { asked, call } = fakeCall({ x: json({ result: "unknown" }), y: json({ result: "unknown" }) });
  assert.equal(await new AgentSystemAuth({ nodes: ["x", "y"], call, log: () => {} }).password("alice", PW), false);
  assert.deepEqual(asked, ["x", "y"]);
  // an invalid name is not sent at all
  const none = fakeCall({ x: json({ result: "ok" }) });
  assert.equal(await new AgentSystemAuth({ nodes: ["x"], call: none.call, log: () => {} }).password("../x", PW), false);
  assert.deepEqual(none.asked, []);
});

test("AgentSystemAuth: a slow node does not stop the next from being asked; the total limit ends the attempt", async () => {
  const logs: string[] = [];
  const { asked, call } = fakeCall({ x: "hang", y: json({ result: "ok" }) });
  const s = new AgentSystemAuth({ nodes: ["x", "y"], call, callTimeoutMs: 150, totalMs: 1000, log: (l) => logs.push(l) });
  const [ok, ms] = await timed(() => s.password("alice", PW));
  assert.equal(ok, true);
  assert.deepEqual(asked, ["x", "y"]);
  assert.ok(ms >= 140 && ms < 5000, `${ms} ms`);
  assert.ok(logs.some((l) => l.includes("x")));
  assert.ok(!logs.join("\n").includes(PW));
  // a call that ignores its abort signal is still left behind at its limit
  const deaf = async (node: string) => (node === "x" ? new Promise<Response>(() => {}) : json({ result: "ok" }));
  assert.equal(await new AgentSystemAuth({ nodes: ["x", "y"], call: deaf, callTimeoutMs: 100, totalMs: 1000, log: () => {} }).password("alice", PW), true);
  // every node slow: the whole attempt ends at the total limit, and later nodes are not asked
  const all = fakeCall({ x: "hang", y: "hang", z: "hang", w: "hang" });
  const t = new AgentSystemAuth({ nodes: ["x", "y", "z", "w"], call: all.call, callTimeoutMs: 200, totalMs: 500, log: () => {} });
  const [no, ms2] = await timed(() => t.key("alice", KEY.line, Buffer.from("m"), Buffer.from("s")));
  assert.equal(no, false);
  assert.ok(ms2 >= 480 && ms2 < 5000, `${ms2} ms`);
  assert.deepEqual(all.asked, ["x", "y", "z"]);
  // a body that never ends counts against the same limit
  const stall = async () => new Response(new ReadableStream({ start: () => {} }), { status: 200 });
  const [no2, ms3] = await timed(() => new AgentSystemAuth({ nodes: ["x"], call: stall, callTimeoutMs: 150, totalMs: 1000, log: () => {} }).password("alice", PW));
  assert.equal(no2, false);
  assert.ok(ms3 >= 140 && ms3 < 5000, `${ms3} ms`);
});

test("AgentSystemAuth.exists: the agent's answer, or undefined when it does not answer in time", async () => {
  const bodies: unknown[] = [];
  const call = async (node: string, p: string, b: unknown, signal?: AbortSignal) => {
    bodies.push([node, p, b]);
    if (node === "slow") return new Promise<Response>((_, rej) => signal?.addEventListener("abort", () => rej(new Error("aborted"))));
    if (node === "bad") return json({ exists: "yes" });
    if (node === "err") return json({ error: "x" }, 503);
    return json({ exists: node === "yes" });
  };
  const s = new AgentSystemAuth({ nodes: [], call, existsTimeoutMs: 150, log: () => {} });
  assert.equal(await s.exists("yes", "alice"), true);
  assert.equal(await s.exists("no", "alice"), false);
  assert.equal(await s.exists("bad", "alice"), undefined);
  assert.equal(await s.exists("err", "alice"), undefined);
  const [u, ms] = await timed(() => s.exists("slow", "alice"));
  assert.equal(u, undefined);
  assert.ok(ms >= 140 && ms < 5000, `${ms} ms`);
  assert.deepEqual(bodies[0], ["yes", "/api/auth/lookup", { name: "alice" }]);
  // the hub's own lookup goes to the agent without a user, and the real agent answers
  const h = hub as unknown as { systemAuth?: AgentSystemAuth };
  assert.ok(h.systemAuth instanceof AgentSystemAuth);
  seen.length = 0;
  assert.equal(await h.systemAuth.exists("a", "alice"), true);
  assert.equal(await h.systemAuth.exists("b", "alice"), false);
  assert.equal(await h.systemAuth.exists("b", "toor"), false);
  const looked = seen.filter((r) => r.path === "/api/auth/lookup");
  assert.ok(looked.length >= 3);
  for (const r of looked) assert.equal(r.headers[USER_HEADER], undefined);
});

test("vouch: refused stops the search; exists:false, a failure or no answer goes on; the first yes vouches", async () => {
  const cases: [Record<string, Answer>, "yes" | "no" | "refused", string[]][] = [
    [{ x: json({ exists: false, refused: true }), y: json({ exists: true }) }, "refused", ["x"]],
    [{ x: json({ exists: false }), y: json({ exists: true }) }, "yes", ["x", "y"]],
    [{ x: "throw", y: json({ exists: true }) }, "yes", ["x", "y"]],
    [{ x: json({ exists: true }, 500), y: json({ exists: true }) }, "yes", ["x", "y"]],
    [{ x: new Response("not json", { status: 200 }), y: json({ exists: true }) }, "yes", ["x", "y"]],
    [{ x: json({ exists: "yes" }), y: json({ exists: true }) }, "yes", ["x", "y"]],
    [{ x: json({ exists: true }), y: json({ exists: false, refused: true }) }, "yes", ["x"]],
    [{ x: json({ exists: false }), y: json({ exists: false }) }, "no", ["x", "y"]],
  ];
  for (const [answers, want, order] of cases) {
    const { asked, call } = fakeCall(answers);
    const s = new AgentSystemAuth({ nodes: ["x", "y"], call, log: () => {} });
    assert.equal(await s.vouch("alice"), want, JSON.stringify(Object.keys(answers)));
    assert.deepEqual(asked, order);
  }
  // root and invalid names: no call
  const none = fakeCall({ x: json({ exists: true }) });
  const s = new AgentSystemAuth({ nodes: ["x"], call: none.call, log: () => {} });
  assert.equal(await s.vouch("root"), "refused");
  assert.equal(await s.vouch("../x"), "no");
  assert.deepEqual(none.asked, []);
  // a slow node is passed over; the total limit ends the search
  const slow = fakeCall({ x: "hang", y: json({ exists: true }) });
  const [v, ms] = await timed(() => new AgentSystemAuth({ nodes: ["x", "y"], call: slow.call, callTimeoutMs: 150, totalMs: 1000, log: () => {} }).vouch("alice"));
  assert.equal(v, "yes");
  assert.ok(ms >= 140 && ms < 5000, `${ms} ms`);
});

test("vouch: the hub asks the real agents' lookup in the sign-in order", async () => {
  const h = hub as unknown as { systemAuth?: AgentSystemAuth };
  assert.equal(await h.systemAuth!.vouch("alice"), "yes");
  assert.equal(await h.systemAuth!.vouch("toor"), "refused");
});
