import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import { createAgent } from "../src/agent.ts";
import { createHub } from "../src/hub.ts";
import { loadConfig } from "../src/config.ts";
import { claimFor, signClaim, verifyClaim, USER_HEADER, type Identity, type UserClaim } from "../src/auth/identity.ts";
import { ownerFrom } from "../src/auth/job-owner.ts";
import type { SystemAuth } from "../src/auth/routes.ts";
import { loginMessage } from "../src/auth/sshkey.ts";
import type { WorkerPool } from "../src/worker-pool.ts";
import { useSandboxOrOff } from "./sandbox-env.ts";
import { chownForTest, fakeResolver, privateTmpdir } from "./worker-env.ts";

/**
 * Act as root (part 2b, Task 5): a system administrator (FILEDECK_ADMINS) proves again who they are, and for 15 minutes their requests
 * run in the agent's root process, as with sign-in off. Never for a virtual account; every audit line made under it has `"asRoot":true`.
 */

await useSandboxOrOff();
const ROOT_ONLY = process.getuid?.() === 0 ? false : "worker live: skipped (not running as root)";

const T = "agent-secret-as-root";
const RIGHT = "right-password-123";
const FIFTEEN_MIN = 15 * 60_000;

let tmp = "";
let dropTmp = () => {};
type Server = ReturnType<typeof serve>;
const servers: Server[] = [];
const closers: { close(): Promise<void> }[] = [];
type Agent = ReturnType<typeof createAgent>;
type Hub = ReturnType<typeof createHub>;

interface Rec {
  path: string;
  claim: UserClaim | null;
}
interface Served {
  url: string;
  recs: Rec[];
  app: Agent;
  lines: string[];
  hook?: (req: Request) => Promise<void>;
}

before(() => {
  dropTmp = privateTmpdir();
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "filedeck-asroot-")));
  fs.chmodSync(tmp, 0o755);
  fs.writeFileSync(path.join(tmp, "index.html"), "<!doctype html><title>t</title>");
});
after(async () => {
  for (const h of closers) await h.close().catch(() => {});
  for (const s of servers) {
    s.close();
    (s as unknown as { closeAllConnections?(): void }).closeAllConnections?.();
  }
  fs.rmSync(tmp, { recursive: true, force: true });
  dropTmp();
});

/** A real agent behind a wrapper that records the claim of every request it gets (verified when it arrives). */
async function agent(node: string, auth: boolean, names: string[]): Promise<Served> {
  const root = path.join(tmp, `root-${node}`);
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, "hello.txt"), "hello\n");
  chownForTest(root);
  const lines: string[] = [];
  const env: Record<string, string> = { FILEDECK_ROOT: root, FILEDECK_NODE: node, FILEDECK_AGENT_TOKEN: T, FILEDECK_INDEX_DIR: path.join(tmp, `index-${node}`) };
  if (auth) env.FILEDECK_AUTH = "on";
  fs.mkdirSync(env.FILEDECK_INDEX_DIR!, { recursive: true });
  const app = createAgent(loadConfig(env as never), (l) => lines.push(l), auth ? { accounts: fakeResolver(Object.fromEntries(names.map((n) => [n, {}]))) } : {});
  closers.push(app as unknown as { close(): Promise<void> });
  const a: Served = { url: "", recs: [], app, lines };
  const srv = await new Promise<Server>((res) => {
    const s: Server = serve(
      {
        fetch: async (req: Request, env: unknown) => {
          const v = req.headers.get(USER_HEADER);
          a.recs.push({ path: new URL(req.url).pathname, claim: v ? verifyClaim(v, T, Date.now()) : null });
          if (a.hook) await a.hook(req);
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

const poolOf = (a: Served) => (a.app as unknown as { pool: WorkerPool }).pool;

/** An Ed25519 key in OpenSSH form, as the browser sends it (`line`), and its private half for signing. */
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
const ALICE_KEY = sshKey();

/** A fake system sign-in: alice's password is RIGHT, and ALICE_KEY is listed for her; every other key is refused. It notes the names it was asked for. */
function fakeSystem(asked: string[], addresses: (string | undefined)[] = []): SystemAuth {
  return {
    async password(name, pw, address) {
      asked.push(name);
      addresses.push(address);
      return name === "alice" && pw === RIGHT;
    },
    async key(name, pub) {
      asked.push(name);
      return name === "alice" && pub === ALICE_KEY.line;
    },
  };
}

const peer = { incoming: { socket: { remoteAddress: "127.0.0.1", encrypted: false } } };

let A: Served;
let B: Served;
let C: Served;
let hub: Hub;
let clock = Date.now();
const asked: string[] = [];
const addresses: (string | undefined)[] = [];
const hubLines: string[] = [];

before(async () => {
  A = await agent("A", true, ["alice", "carol"]);
  B = await agent("B", true, []); // alice has no account here
  C = await agent("C", false, []);
  hub = createHub(
    loadConfig({ FILEDECK_MODE: "hub", FILEDECK_AUTH: "on", FILEDECK_AGENT_TOKEN: T, FILEDECK_STATIC: tmp, NODES: `A=${A.url},B=${B.url}`, FILEDECK_ADMINS: "alice,vadmin", FILEDECK_AUTH_FILE: path.join(tmp, "auth.db"), FILEDECK_DIFF_DIR: path.join(tmp, "diff") } as never),
    undefined,
    (l) => hubLines.push(l),
    { now: () => clock, system: fakeSystem(asked, addresses) },
  );
  closers.push(hub);
});

const call = (h: Hub, p: string, cookie: string, init: RequestInit = {}) =>
  h.request("http://localhost" + p, { ...init, headers: { ...(init.body ? { "content-type": "application/json" } : {}), ...(init.headers as Record<string, string>), cookie } }, peer as never);
const postJson = (h: Hub, p: string, cookie: string, body: unknown) => call(h, p, cookie, { method: "POST", body: JSON.stringify(body) });
const sysCookie = (h: Hub, name: string) => `__Host-filedeck=${h.auth!.sessions.create("sys", name)}`;
const me = async (h: Hub, cookie: string) => (await (await call(h, "/api/auth/me", cookie)).json()) as { name: string; asRootUntil?: number };

test("admins only: a virtual admin and a system user who is not an admin get 403; a wrong password gives 401 after at least 500 ms", async () => {
  hub.auth!.accounts.create({ name: "vadmin", password: "pw-vadmin-123", admin: true, nodes: { A: { runAs: "alice", grants: [{ path: "/", write: true }] } } });
  const virt = `__Host-filedeck=${hub.auth!.sessions.create("virt", "vadmin")}`;
  const r1 = await postJson(hub, "/api/auth/as-root", virt, { password: "pw-vadmin-123" });
  assert.equal(r1.status, 403);
  assert.deepEqual(await r1.json(), { error: "only system administrators can act as root" });
  const carol = sysCookie(hub, "carol");
  const r2 = await postJson(hub, "/api/auth/as-root", carol, { password: RIGHT });
  assert.equal(r2.status, 403);
  assert.deepEqual(await r2.json(), { error: "only system administrators can act as root" });
  // not signed in at all
  assert.equal((await postJson(hub, "/api/auth/as-root", "", { password: RIGHT })).status, 401);

  const alice = sysCookie(hub, "alice");
  asked.length = 0;
  const t0 = performance.now();
  const r3 = await postJson(hub, "/api/auth/as-root", alice, { password: "wrong" });
  const ms = performance.now() - t0;
  assert.equal(r3.status, 401);
  assert.deepEqual(await r3.json(), { error: "sign-in failed" });
  assert.ok(ms >= 490, `${ms} ms`);
  // the proof is for the session's own name only: a name in the body is never used
  const r4 = await postJson(hub, "/api/auth/as-root", alice, { name: "bob", password: "wrong" });
  assert.equal(r4.status, 401);
  assert.deepEqual(asked, ["alice", "alice"]);
  // the password proof goes to PAM with the client's address, as at sign-in
  assert.deepEqual(addresses.slice(-2), ["127.0.0.1", "127.0.0.1"]);
  // a key proof needs a challenge the hub issued for this name; a bad signature is refused before the agent is asked
  const ch = (await (await postJson(hub, "/api/auth/challenge", alice, { name: "alice" })).json()) as { challenge: string; hubId: string };
  assert.ok(loginMessage(ch.hubId, "alice", Buffer.from(ch.challenge, "base64")).length > 0);
  const r5 = await postJson(hub, "/api/auth/as-root", alice, { publicKey: "ssh-ed25519 AAAA", challenge: ch.challenge, signature: Buffer.alloc(64).toString("base64") });
  assert.equal(r5.status, 401);
  assert.equal((await me(hub, alice)).asRootUntil, undefined);
});

test("key proof: a real signature over the hub's message turns the switch on; a used challenge or one for another name does not", async () => {
  // (a hub of its own: the failures here would otherwise count against alice in the shared hub's sign-in limiter)
  const h5 = createHub(
    loadConfig({ FILEDECK_MODE: "hub", FILEDECK_AUTH: "on", FILEDECK_AGENT_TOKEN: T, FILEDECK_STATIC: tmp, NODES: `A=${A.url}`, FILEDECK_ADMINS: "alice", FILEDECK_AUTH_FILE: path.join(tmp, "auth5.db"), FILEDECK_DIFF_DIR: path.join(tmp, "diff5") } as never),
    undefined,
    () => {},
    { now: () => clock, system: fakeSystem([]) },
  );
  closers.push(h5);
  const hub = h5;
  clock = Date.now();
  const alice = sysCookie(hub, "alice");
  const challenge = async (name: string) => (await (await postJson(hub, "/api/auth/challenge", alice, { name })).json()) as { challenge: string; hubId: string };
  const proof = (ch: { challenge: string; hubId: string }, signedName = "alice") => ({
    publicKey: ALICE_KEY.line,
    challenge: ch.challenge,
    signature: sign(null, loginMessage(ch.hubId, signedName, Buffer.from(ch.challenge, "base64")), ALICE_KEY.privateKey).toString("base64"),
  });
  const c1 = await challenge("alice");
  const ok = await postJson(hub, "/api/auth/as-root", alice, proof(c1));
  assert.equal(ok.status, 200, await ok.clone().text());
  assert.equal(((await ok.json()) as { asRootUntil: number }).asRootUntil, clock + FIFTEEN_MIN);
  assert.ok((await me(hub, alice)).asRootUntil);
  assert.equal((await call(hub, "/api/auth/as-root", alice, { method: "DELETE" })).status, 200);
  // the same challenge again: used up
  const again = await postJson(hub, "/api/auth/as-root", alice, proof(c1));
  assert.equal(again.status, 401);
  assert.deepEqual(await again.json(), { error: "sign-in failed" });
  // a challenge the hub issued for another name, signed for that name or for alice: refused either way
  const cb = await challenge("bob");
  assert.equal((await postJson(hub, "/api/auth/as-root", alice, proof(cb, "bob"))).status, 401);
  const cb2 = await challenge("bob");
  assert.equal((await postJson(hub, "/api/auth/as-root", alice, proof(cb2, "alice"))).status, 401);
  assert.equal((await me(hub, alice)).asRootUntil, undefined);
});

test("epoch rise at the gate: raising alice's epoch ends her session and the switch with it", async () => {
  clock = Date.now();
  const alice = sysCookie(hub, "alice");
  assert.equal((await postJson(hub, "/api/auth/as-root", alice, { password: RIGHT })).status, 200);
  assert.ok((await me(hub, alice)).asRootUntil);
  hub.auth!.accounts.bumpEpoch("sys", "alice");
  assert.equal((await call(hub, "/api/auth/me", alice)).status, 401);
  // a new session after the rise starts without the switch
  assert.equal((await me(hub, sysCookie(hub, "alice"))).asRootUntil, undefined);
});

test("forged asRoot: a virtual claim with asRoot, or an asRoot that is not true, fails verifyClaim; the agent refuses it", async () => {
  const now = Date.now();
  const virt: UserClaim = { kind: "virt", name: "vadmin", epoch: 1, runAs: "alice", grants: [{ path: "/", write: true }], iat: now };
  assert.equal(verifyClaim(signClaim({ ...virt, asRoot: true }, T), T, now), null);
  assert.equal(verifyClaim(signClaim({ kind: "sys", name: "alice", epoch: 1, iat: now, asRoot: "yes" } as unknown as UserClaim, T), T, now), null);
  assert.equal(verifyClaim(signClaim({ kind: "sys", name: "alice", epoch: 1, iat: now, asRoot: false } as unknown as UserClaim, T), T, now), null);
  assert.equal(verifyClaim(signClaim({ kind: "sys", name: "alice", epoch: 1, iat: now, asRoot: true }, T), T, now)?.asRoot, true);
  // claimFor: only a system identity whose switch is still on
  const sys: Identity = { kind: "sys", name: "alice", admin: true, epoch: 1, asRootUntil: now + 1000 };
  assert.equal(claimFor(sys, "A", now)?.asRoot, true);
  assert.equal(claimFor(sys, "A", now + 1000)?.asRoot, undefined);
  assert.equal(claimFor({ ...sys, asRootUntil: undefined }, "A", now)?.asRoot, undefined);
  const v = { kind: "virt", name: "vadmin", admin: true, epoch: 1, nodes: { A: { runAs: "alice", grants: [] } }, asRootUntil: now + 1000 } as unknown as Identity;
  assert.equal(claimFor(v, "A", now)?.asRoot, undefined);
  // the agent: the forged claim is "no user"
  const r = await A.app.request("/api/fs/stat?path=/", { headers: { authorization: `Bearer ${T}`, [USER_HEADER]: signClaim({ ...virt, asRoot: true, iat: Date.now() }, T) } });
  assert.equal(r.status, 401);
  // a stored job owner with a bad asRootUntil reads back without it
  assert.equal((ownerFrom(JSON.stringify({ kind: "sys", name: "alice", admin: true, epoch: 1, asRootUntil: "soon" })) as { asRootUntil?: unknown }).asRootUntil, undefined);
  // both the end and its session, or neither; never on a virtual owner
  const back = ownerFrom(JSON.stringify({ kind: "sys", name: "alice", admin: true, epoch: 1, asRootUntil: 5, asRootSession: "k" })) as { asRootUntil?: unknown; asRootSession?: unknown };
  assert.deepEqual([back.asRootUntil, back.asRootSession], [5, "k"]);
  const half = ownerFrom(JSON.stringify({ kind: "sys", name: "alice", admin: true, epoch: 1, asRootUntil: 5 })) as { asRootUntil?: unknown };
  assert.equal(half.asRootUntil, undefined);
  const bad = ownerFrom(JSON.stringify({ kind: "sys", name: "alice", admin: true, epoch: 1, asRootUntil: 5, asRootSession: 7 })) as { asRootUntil?: unknown; asRootSession?: unknown };
  assert.deepEqual([bad.asRootUntil, bad.asRootSession], [undefined, undefined]);
  const virtOwner = ownerFrom(JSON.stringify({ kind: "virt", name: "v", admin: true, epoch: 1, nodes: {}, asRootUntil: 5, asRootSession: "k" })) as { asRootUntil?: unknown; asRootSession?: unknown };
  assert.deepEqual([virtOwner.asRootUntil, virtOwner.asRootSession], [undefined, undefined]);
});

test("time left by the hub's own clock: asRootLeftMs in the POST answer and in me, beside asRootUntil", async () => {
  clock = Date.now();
  const alice = sysCookie(hub, "alice");
  const on = await postJson(hub, "/api/auth/as-root", alice, { password: RIGHT });
  assert.equal(on.status, 200);
  assert.deepEqual(await on.json(), { asRootUntil: clock + FIFTEEN_MIN, asRootLeftMs: FIFTEEN_MIN });
  clock += 60_000;
  const m = (await (await call(hub, "/api/auth/me", alice)).json()) as { asRootUntil?: number; asRootLeftMs?: number };
  assert.deepEqual([m.asRootUntil, m.asRootLeftMs], [clock - 60_000 + FIFTEEN_MIN, FIFTEEN_MIN - 60_000]);
  assert.equal((await call(hub, "/api/auth/as-root", alice, { method: "DELETE" })).status, 200);
  const off = (await (await call(hub, "/api/auth/me", alice)).json()) as { asRootUntil?: number; asRootLeftMs?: number };
  assert.deepEqual([off.asRootUntil, off.asRootLeftMs], [undefined, undefined]);
});

test("root for 15 minutes: requests run in the root process, every machine is open, then the worker again at until + 1 ms; DELETE ends it", async () => {
  clock = Date.now();
  const alice = sysCookie(hub, "alice");
  const on = await postJson(hub, "/api/auth/as-root", alice, { password: RIGHT });
  assert.equal(on.status, 200);
  const until = ((await on.json()) as { asRootUntil: number }).asRootUntil;
  assert.equal(until, clock + FIFTEEN_MIN);
  assert.equal((await me(hub, alice)).asRootUntil, until);

  A.recs.length = 0;
  const r = await call(hub, "/api/nodes/A/api/fs/stat?path=/hello.txt", alice);
  assert.equal(r.status, 200, await r.clone().text());
  assert.equal(A.recs.at(-1)?.claim?.asRoot, true);
  assert.deepEqual(poolOf(A).list(), [], "no worker for a request under the switch");
  // a machine without alice's account is listed and reachable; a name that is not a machine still answers 403
  const nodes = (await (await call(hub, "/api/nodes", alice)).json()) as { nodes: { name: string }[] };
  assert.ok(nodes.nodes.some((n) => n.name === "B"), JSON.stringify(nodes));
  const rb = await call(hub, "/api/nodes/B/api/fs/stat?path=/hello.txt", alice);
  assert.equal(rb.status, 200, await rb.clone().text());
  assert.deepEqual(poolOf(B).list(), []);
  const rn = await call(hub, "/api/nodes/nosuch/api/fs/stat?path=/", alice);
  assert.equal(rn.status, 403);

  // past the end: the next request goes to the worker again
  clock = until + 1;
  assert.equal((await me(hub, alice)).asRootUntil, undefined);
  const r2 = await call(hub, "/api/nodes/A/api/fs/stat?path=/hello.txt", alice);
  assert.equal(r2.status, 200, await r2.clone().text());
  assert.equal(A.recs.at(-1)?.claim?.asRoot, undefined);
  assert.ok(poolOf(A).list().some((w) => w.key === "sys:alice"), "the worker serves it");

  // on again, then off at once
  const on2 = await postJson(hub, "/api/auth/as-root", alice, { password: RIGHT });
  assert.equal(on2.status, 200);
  assert.ok((await me(hub, alice)).asRootUntil);
  const off = await call(hub, "/api/auth/as-root", alice, { method: "DELETE" });
  assert.equal(off.status, 200);
  assert.equal((await me(hub, alice)).asRootUntil, undefined);
  await call(hub, "/api/nodes/A/api/fs/stat?path=/hello.txt", alice);
  assert.equal(A.recs.at(-1)?.claim?.asRoot, undefined);
});

test("an admin removed from FILEDECK_ADMINS loses the switch at once; sign-out ends it", async () => {
  const lines: string[] = [];
  const h2 = createHub(
    loadConfig({ FILEDECK_MODE: "hub", FILEDECK_AUTH: "on", FILEDECK_AGENT_TOKEN: T, FILEDECK_STATIC: tmp, NODES: `A=${A.url}`, FILEDECK_ADMINS: "alice", FILEDECK_AUTH_FILE: path.join(tmp, "auth2.db"), FILEDECK_DIFF_DIR: path.join(tmp, "diff2") } as never),
    undefined,
    (l) => lines.push(l),
    { system: fakeSystem([]) },
  );
  closers.push(h2);
  const alice = sysCookie(h2, "alice");
  assert.equal((await postJson(h2, "/api/auth/as-root", alice, { password: RIGHT })).status, 200);
  assert.ok((await me(h2, alice)).asRootUntil);
  // the same database under a hub whose config no longer names alice
  const h3 = createHub(
    loadConfig({ FILEDECK_MODE: "hub", FILEDECK_AUTH: "on", FILEDECK_AGENT_TOKEN: T, FILEDECK_STATIC: tmp, NODES: `A=${A.url}`, FILEDECK_ADMINS: "", FILEDECK_AUTH_FILE: path.join(tmp, "auth2.db"), FILEDECK_DIFF_DIR: path.join(tmp, "diff3") } as never),
    undefined,
    () => {},
    { system: fakeSystem([]) },
  );
  closers.push(h3);
  assert.equal((await me(h3, alice)).asRootUntil, undefined);
  assert.equal((await postJson(h3, "/api/auth/as-root", alice, { password: RIGHT })).status, 403);
  // sign-out on h2 ends the session and the switch with it
  await call(h2, "/api/auth/logout", alice, { method: "POST" });
  assert.equal((await call(h2, "/api/auth/me", alice)).status, 401);
});

test("audit: lines under the switch have asRoot:true on hub and agent; lines before it have none; no proof in any line", async () => {
  clock = Date.now();
  const alice = sysCookie(hub, "alice");
  hubLines.length = 0;
  A.lines.length = 0;
  const before = await postJson(hub, "/api/nodes/A/api/fs/mkdir", alice, { path: "/before" });
  assert.ok(before.status < 300, await before.clone().text());
  const on = await postJson(hub, "/api/auth/as-root", alice, { password: RIGHT });
  assert.equal(on.status, 200);
  const under = await postJson(hub, "/api/nodes/A/api/fs/mkdir", alice, { path: "/under" });
  assert.ok(under.status < 300, await under.clone().text());
  const off = await call(hub, "/api/auth/as-root", alice, { method: "DELETE" });
  assert.equal(off.status, 200);

  const parse = (ls: string[]) => ls.map((l) => JSON.parse(l) as { route: string; asRoot?: unknown; body?: unknown; user?: string });
  const hubAll = parse(hubLines);
  // (the hub's line of a forwarded request has no body: the two are told apart by their order)
  const [hBefore, hUnder] = hubAll.filter((l) => l.route === "/api/nodes/A/api/fs/mkdir");
  assert.ok(hBefore && hUnder, JSON.stringify(hubAll));
  assert.equal("asRoot" in hBefore, false);
  assert.equal(hUnder.asRoot, true);
  // turning it on and off each writes one line; neither holds the password
  const onLines = hubAll.filter((l) => l.route === "/api/auth/as-root");
  assert.equal(onLines.length, 2);
  assert.equal("asRoot" in onLines[0]!, false, "the line that turns it on was not made under it");
  assert.equal(onLines[1]!.asRoot, true, "the line that turns it off was");
  for (const l of hubLines) assert.ok(!l.includes(RIGHT), l);

  const agentAll = parse(A.lines);
  const aBefore = agentAll.find((l) => l.route === "/api/fs/mkdir" && String(JSON.stringify(l.body)).includes("/before"));
  const aUnder = agentAll.find((l) => l.route === "/api/fs/mkdir" && String(JSON.stringify(l.body)).includes("/under"));
  assert.ok(aBefore && aUnder, JSON.stringify(agentAll));
  assert.equal("asRoot" in aBefore, false);
  assert.equal(aUnder.asRoot, true);
  assert.equal(aUnder.user, "sys:alice");
});

/**
 * A copy job (4 items, on C) started under the switch, with the hub's own injected clock. At the 2nd `/api/fs/copy`, `mid` runs before
 * the agent answers; every call before that point must carry `asRoot`, every call after it must not. `restart`: the hub is closed there
 * instead, and `restart()` makes the hub that carries the job on (same job and auth files).
 */
let jobRun = 0;
async function jobUnderSwitch(o: { mid?: (h: Hub, cookie: string, until: number, setClock: (t: number) => void) => Promise<void>; restart?: (files: Record<string, string>) => Hub }) {
  const n = jobRun++;
  let hclock = Date.now();
  const files = { FILEDECK_AUTH_FILE: path.join(tmp, `authj${n}.db`), FILEDECK_JOBS_FILE: path.join(tmp, `jobsj${n}.db`) };
  const env = { FILEDECK_MODE: "hub", FILEDECK_AUTH: "on", FILEDECK_AGENT_TOKEN: T, FILEDECK_STATIC: tmp, NODES: `C=${C.url}`, FILEDECK_ADMINS: "alice", FILEDECK_DIFF_DIR: path.join(tmp, `diffj${n}`), ...files };
  let h = createHub(loadConfig(env as never), undefined, () => {}, { now: () => hclock, system: fakeSystem([]) });
  closers.push(h);
  const rootC = path.join(tmp, "root-C");
  const src = `jsrc${n}`;
  const dst = `jdst${n}`;
  fs.mkdirSync(path.join(rootC, src));
  for (let i = 0; i < 4; i++) fs.writeFileSync(path.join(rootC, src, `f${i}.txt`), `file ${i}\n`);
  fs.mkdirSync(path.join(rootC, dst));
  const alice = sysCookie(h, "alice");
  const on = await postJson(h, "/api/auth/as-root", alice, { password: RIGHT });
  assert.equal(on.status, 200);
  const until = ((await on.json()) as { asRootUntil: number }).asRootUntil;
  let copies = 0;
  let cutAt = -1;
  let reached!: () => void;
  const second = new Promise<void>((r) => (reached = r));
  C.recs.length = 0;
  C.hook = async (req) => {
    if (new URL(req.url).pathname !== "/api/fs/copy") return;
    if (++copies === 2) {
      cutAt = C.recs.length; // this call and the ones before it were made before the cut
      if (o.mid) await o.mid(h, alice, until, (t) => (hclock = t));
      reached();
      if (o.restart) await new Promise((r) => setTimeout(r, 150));
    }
  };
  try {
    const items = [0, 1, 2, 3].map((i) => ({ node: "C", path: `/${src}/f${i}.txt` }));
    const res = await postJson(h, "/api/ops/jobs", alice, { op: "copy", items, dst: { node: "C", dir: `/${dst}` }, conflict: "overwrite" });
    assert.equal(res.status, 202, await res.clone().text());
    const { id } = (await res.json()) as { id: string };
    if (o.restart) {
      await second;
      await h.close(); // stops at the next item boundary and hands the job over
      closers.splice(closers.indexOf(h), 1);
      h = o.restart({ ...env } as Record<string, string>);
      closers.push(h);
    }
    // polled with a new session each time (the job's own session may be gone, and an epoch rise ends older ones)
    let state = "";
    for (let i = 0; i < 600; i++) {
      const poll = `__Host-filedeck=${h.auth!.sessions.create("sys", "alice")}`;
      state = ((await (await call(h, `/api/ops/jobs/${id}`, poll)).json()) as { state: string }).state;
      if (state === "done" || state === "failed" || state === "canceled") break;
      await new Promise((r) => setTimeout(r, 25));
    }
    assert.equal(state, "done");
  } finally {
    C.hook = undefined;
  }
  assert.ok(cutAt > 0, `the job reached a second copy (${copies})`);
  const made = C.recs.filter((r) => r.path !== "/healthz" && r.path !== "/metrics");
  const before = made.slice(0, cutAt);
  const afterCut = made.slice(cutAt);
  assert.ok(before.length > 0 && afterCut.some((r) => r.path === "/api/fs/copy"), "calls on both sides of the cut");
  for (const r of before) assert.equal(r.claim?.asRoot, true, `${r.path} before the cut`);
  for (const r of afterCut) {
    assert.ok(r.claim, `${r.path} still names alice`);
    assert.equal(r.claim?.name, "alice");
    assert.equal(r.claim?.asRoot, undefined, `${r.path} after the cut`);
  }
}

test("job and the switch's end: calls after the end carry no asRoot", async () => {
  await jobUnderSwitch({ mid: async (_h, _c, until, setClock) => setClock(until + 1) });
});

test("job and DELETE: switching off mid-job ends asRoot on the next agent call", async () => {
  await jobUnderSwitch({
    mid: async (h, cookie) => {
      assert.equal((await call(h, "/api/auth/as-root", cookie, { method: "DELETE" })).status, 200);
    },
  });
});

test("job and sign-out: signing out mid-job ends asRoot on the next agent call", async () => {
  await jobUnderSwitch({
    mid: async (h, cookie) => {
      assert.equal((await call(h, "/api/auth/logout", cookie, { method: "POST" })).status, 200);
    },
  });
});

test("job and an epoch rise: raising the account epoch mid-job ends asRoot on the next agent call", async () => {
  await jobUnderSwitch({
    mid: async (h) => {
      h.auth!.accounts.bumpEpoch("sys", "alice");
    },
  });
});

test("job and FILEDECK_ADMINS: a hub that carries the job on without alice in its admins sends no asRoot", async () => {
  await jobUnderSwitch({
    restart: (env) => createHub(loadConfig({ ...env, FILEDECK_ADMINS: "" } as never), undefined, () => {}, { system: fakeSystem([]) }),
  });
});

test("agent: an asRoot claim sees every root job, and its folder sizes need no account and no worker", async () => {
  // (dave: an admin name no other test uses, so the agent's epoch for alice is left alone)
  const hdr = (name: string, asRoot: boolean) => ({
    authorization: `Bearer ${T}`,
    "content-type": "application/json",
    [USER_HEADER]: signClaim({ kind: "sys", name, epoch: 0, iat: Date.now(), ...(asRoot ? { asRoot: true as const } : {}) }, T),
  });
  const s = await A.app.request("/api/jobs/size", { method: "POST", headers: hdr("carol", false), body: JSON.stringify({ path: "/" }) });
  assert.equal(s.status, 202, await s.clone().text());
  const job = (await s.json()) as { id: string };
  const list = async (name: string, asRoot: boolean) => ((await (await A.app.request("/api/jobs", { headers: hdr(name, asRoot) })).json()) as { jobs: { id: string }[] }).jobs;
  assert.ok(!(await list("dave", false)).some((j) => j.id === job.id), "not dave's without the switch");
  assert.ok((await list("dave", true)).some((j) => j.id === job.id), "every root job under the switch");
  assert.equal((await A.app.request(`/api/jobs/${job.id}`, { headers: hdr("dave", false) })).status, 404);
  assert.equal((await A.app.request(`/api/jobs/${job.id}`, { headers: hdr("dave", true) })).status, 200);
  // a name with no account on this machine: the root process answers, no lookup, no worker
  const du = await A.app.request("/api/du?path=/", { headers: hdr("zed", true) });
  assert.equal(du.status, 200, await du.clone().text());
  assert.ok(!poolOf(A).list().some((w) => w.key === "sys:zed"));
  const st = await A.app.request("/api/fs/stat?path=/hello.txt", { headers: hdr("zed", true) });
  assert.equal(st.status, 200, await st.clone().text());
  // without the switch the same name has no account here
  assert.equal((await A.app.request("/api/fs/stat?path=/hello.txt", { headers: hdr("zed", false) })).status, 403);
});

test("root only: under the switch, a file mode 0600 owned by root is read in the root process; without it the worker cannot", { skip: ROOT_ONLY }, async () => {
  clock = Date.now();
  const rootA = path.join(tmp, "root-A");
  fs.mkdirSync(path.join(rootA, "private"), { mode: 0o700 });
  fs.chownSync(path.join(rootA, "private"), 0, 0);
  fs.writeFileSync(path.join(rootA, "private", "secret.txt"), "root's own\n", { mode: 0o600 });
  fs.chownSync(path.join(rootA, "private", "secret.txt"), 0, 0);
  const alice = sysCookie(hub, "alice");
  const no = await call(hub, "/api/nodes/A/api/fs/text?path=/private/secret.txt", alice);
  assert.equal(no.status, 403);
  assert.deepEqual(await no.json(), { error: "permission denied" });
  assert.equal((await postJson(hub, "/api/auth/as-root", alice, { password: RIGHT })).status, 200);
  const before = poolOf(A).list().length;
  const yes = await call(hub, "/api/nodes/A/api/fs/text?path=/private/secret.txt", alice);
  assert.equal(yes.status, 200, await yes.clone().text());
  assert.match(JSON.stringify(await yes.json()), /root's own/);
  assert.equal(poolOf(A).list().length, before, "no worker started for it");
  await call(hub, "/api/auth/as-root", alice, { method: "DELETE" });
});
