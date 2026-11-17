import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createAgent } from "../src/agent.ts";
import { loadConfig } from "../src/config.ts";
import { HostPam } from "../src/host-pam.ts";
import { signClaim, USER_HEADER, type UserClaim } from "../src/auth/identity.ts";
import { SignInLookups, type AccountResolver, type LocalAccount } from "../src/local-accounts.ts";
import { fakeResolver, privateTmpdir } from "./worker-env.ts";

/**
 * work-item: the hub asks an agent to check a system user's password. The agent's root process answers `/api/auth/password` behind the
 * agent token but before any user exists (no signed user header), and the password never reaches an audit line.
 */
const T = "agent-secret-auth-routes";
const SECRET = "hunter2 but longer";
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "filedeck-authroutes-")));
const apps: { close(): Promise<void> }[] = [];
const dropTmp = privateTmpdir();
after(async () => {
  for (const a of apps) await a.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  dropTmp();
});

const fakePam = (code: number) => {
  const calls: { name: string; stdin: string; address?: string }[] = [];
  return { calls, pam: new HostPam({ run: async (name, stdin, o) => (calls.push({ name, stdin: stdin.toString(), ...(o.address === undefined ? {} : { address: o.address }) }), { code }) }) };
};
const FROM = "203.0.113.7";
const agent = (env: Record<string, string>, opts: { pam?: HostPam } = {}, sink?: (l: string) => void) => {
  const app = createAgent(loadConfig({ FILEDECK_ROOT: tmp, FILEDECK_NODE: "t", FILEDECK_AGENT_TOKEN: T, ...env } as never), sink, { accounts: fakeResolver({ alice: {} }), ...opts });
  apps.push(app as unknown as { close(): Promise<void> });
  return app;
};
const post = (app: ReturnType<typeof agent>, body: unknown, headers: Record<string, string> = { authorization: `Bearer ${T}` }) =>
  app.request("/api/auth/password", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

test("password route: the agent token and no user header give the PAM result", async () => {
  const lines: string[] = [];
  const { pam, calls } = fakePam(0);
  const app = agent({ FILEDECK_AUTH: "on" }, { pam }, (l) => lines.push(l));
  const r = await post(app, { name: "alice", password: SECRET, address: FROM });
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { result: "ok" });
  assert.deepEqual(calls, [{ name: "alice", stdin: SECRET, address: FROM }]);
  // the audit line names the route and the name, never the password
  const line = lines.find((l) => l.includes("/api/auth/password"));
  assert.ok(line, lines.join("\n"));
  assert.ok(!line.includes(SECRET));
  assert.ok(!("password" in (JSON.parse(line).body ?? {})));
  assert.ok(!lines.join("\n").includes(SECRET));
  // a wrong password is a 200 with fail (the hub decides what the person sees)
  const wrong = await post(agent({ FILEDECK_AUTH: "on" }, { pam: fakePam(1).pam }), { name: "alice", password: "x", address: FROM });
  assert.deepEqual([wrong.status, await wrong.json()], [200, { result: "fail" }]);
  // the helper sees uid 0 or gid 0 (exit 6) though the account lookup (perhaps cached) saw an ordinary account: refused
  const stale = await post(agent({ FILEDECK_AUTH: "on" }, { pam: fakePam(6).pam }), { name: "alice", password: SECRET, address: FROM });
  assert.deepEqual([stale.status, await stale.json()], [200, { result: "refused" }]);
  // a signed user header changes nothing here
  const claim: UserClaim = { kind: "sys", name: "alice", epoch: 1, iat: Date.now() };
  const withUser = await post(app, { name: "alice", password: SECRET, address: FROM }, { authorization: `Bearer ${T}`, [USER_HEADER]: signClaim(claim, T) });
  assert.deepEqual(await withUser.json(), { result: "ok" });
});

test("password route: no agent token is 401, a bad body is 400 without the password", async () => {
  const lines: string[] = [];
  const { pam, calls } = fakePam(0);
  const app = agent({ FILEDECK_AUTH: "on" }, { pam }, (l) => lines.push(l));
  assert.equal((await post(app, { name: "alice", password: SECRET, address: FROM }, {})).status, 401);
  assert.equal((await post(app, { name: "alice", password: SECRET, address: FROM }, { authorization: "Bearer wrong" })).status, 401);
  for (const body of [{ name: "alice" }, { password: SECRET }, { name: 1, password: SECRET }, { name: "alice", password: 5 }, [SECRET], { name: "alice", password: SECRET }]) {
    const r = await post(app, body);
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.ok(!(await r.text()).includes(SECRET));
  }
  assert.equal(calls.length, 0);
  assert.ok(!lines.join("\n").includes(SECRET));
  // the other routes still need a user
  assert.equal((await app.request("/api/fs/stat?path=/", { headers: { authorization: `Bearer ${T}` } })).status, 401);
});

test("password route: no PAM here gives unavailable; auth off has no route", async () => {
  const none = agent({ FILEDECK_AUTH: "on" });
  const r = await post(none, { name: "alice", password: SECRET, address: FROM });
  assert.deepEqual([r.status, await r.json()], [200, { result: "unavailable" }]);
  const off = agent({}, { pam: fakePam(0).pam });
  assert.equal((await post(off, { name: "alice", password: SECRET, address: FROM })).status, 404);
});

test("password route: the client's address goes to PAM as an argument; without a valid one the attempt is refused and PAM never runs", async () => {
  const { pam, calls } = fakePam(0);
  const app = agent({ FILEDECK_AUTH: "on" }, { pam });
  for (const address of ["203.0.113.7", "2001:db8::5", "::ffff:198.51.100.2"]) {
    const r = await post(app, { name: "alice", password: SECRET, address });
    assert.deepEqual([r.status, await r.json()], [200, { result: "ok" }], address);
  }
  assert.deepEqual(
    calls.map((c) => c.address),
    ["203.0.113.7", "2001:db8::5", "::ffff:198.51.100.2"],
  );
  calls.length = 0;
  for (const address of [undefined, "", "localhost", "203.0.113", "fe80::1%eth0", "1.2.3.4 -x", "-1.2.3.4", 7, ["1.2.3.4"], "a".repeat(46)]) {
    const r = await post(app, { name: "alice", password: SECRET, address });
    assert.equal(r.status, 400, JSON.stringify(address));
    assert.ok(!(await r.text()).includes(SECRET));
  }
  assert.equal(calls.length, 0);
});

/** A resolver whose sign-in lookups wait until `release` is called; it counts how many run at once. */
function heldResolver() {
  const st = { running: 0, most: 0, calls: 0, waiting: [] as (() => void)[] };
  const r: AccountResolver = {
    resolve: async () => null,
    forSignIn: async (name) => {
      st.calls++;
      st.running++;
      st.most = Math.max(st.most, st.running);
      await new Promise<void>((res) => st.waiting.push(res));
      st.running--;
      return { name, uid: 1234, gid: 1234, groups: [1234], home: "/home/" + name } as LocalAccount;
    },
  };
  const release = () => {
    for (const w of st.waiting.splice(0)) w();
  };
  return { r, st, release };
}

test("sign-in lookups: at most 4 at once; a call over that waits a short time in the queue, then is refused", async () => {
  const { r, st, release } = heldResolver();
  const gate = new SignInLookups(r, { waitMs: 150 });
  const first = Array.from({ length: 4 }, () => gate.forSignIn("alice"));
  const fifth = gate.forSignIn("alice");
  await new Promise((res) => setTimeout(res, 20));
  assert.equal(st.calls, 4, "the fifth waits");
  // a place comes free within the wait: the fifth runs
  release();
  await Promise.all(first);
  await new Promise((res) => setTimeout(res, 10));
  assert.equal(st.calls, 5);
  release();
  assert.equal(((await fifth) as LocalAccount).name, "alice");
  // all places held for longer than the wait: refused at its end, and its lookup never runs
  const held = Array.from({ length: 4 }, () => gate.forSignIn("alice"));
  const t0 = Date.now();
  await assert.rejects(gate.forSignIn("alice"), /too many account lookups/);
  assert.ok(Date.now() - t0 >= 140);
  assert.equal(st.calls, 9);
  assert.equal(st.most, 4);
  release();
  await Promise.all(held);
  // `resolve` (worker starts) is not counted
  assert.equal(await gate.resolve("alice"), null);
});

test("sign-in lookups on the agent: the password and lookup routes share the cap of 4; over it the password check is unavailable", async () => {
  const { r, st, release } = heldResolver();
  const { pam, calls } = fakePam(0);
  const app = createAgent(loadConfig({ FILEDECK_ROOT: tmp, FILEDECK_NODE: "t", FILEDECK_AGENT_TOKEN: T, FILEDECK_AUTH: "on" } as never), () => {}, { accounts: r, pam });
  apps.push(app as unknown as { close(): Promise<void> });
  const lookup = () => app.request("/api/auth/lookup", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${T}` }, body: JSON.stringify({ name: "alice" }) });
  const held = [post(app, { name: "alice", password: SECRET, address: FROM }), post(app, { name: "alice", password: SECRET, address: FROM }), lookup(), lookup()];
  await new Promise((res) => setTimeout(res, 50));
  assert.equal(st.calls, 4);
  const t0 = Date.now();
  const over = await post(app, { name: "alice", password: SECRET, address: FROM });
  assert.deepEqual([over.status, await over.json()], [200, { result: "unavailable" }]);
  assert.ok(Date.now() - t0 >= 500, "it waited in the queue first");
  assert.equal(st.calls, 4);
  release();
  const answers = await Promise.all(held.map(async (x) => (await x).json()));
  assert.deepEqual(answers, [{ result: "ok" }, { result: "ok" }, { exists: true }, { exists: true }]);
  assert.equal(st.most, 4);
  assert.equal(calls.length, 2);
});
