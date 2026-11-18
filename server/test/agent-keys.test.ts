import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { generateKeyPairSync, randomBytes, sign, type KeyObject } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createAgent } from "../src/agent.ts";
import { loadConfig } from "../src/config.ts";
import { KeyCheck, keyListed, readAsUser, logLine, MAX_AUTHORIZED_KEYS, MAX_READERS, ReaderTimeout } from "../src/agent-keys.ts";
import { loginMessage, parseLoginMessage } from "../src/auth/sshkey.ts";
import type { AccountResolver, LocalAccount } from "../src/local-accounts.ts";
import { resetSandbox } from "../src/sandbox.ts";
import { fakeResolver, privateTmpdir, withSignIn } from "./worker-env.ts";
import { useSandbox } from "./sandbox-env.ts";

/**
 * work-item: a system user signs in with an SSH key listed in their own `~/.ssh/authorized_keys`. The agent reads that file as the
 * user (their uid, gid and groups), inside the machine's root, never as root; a line with options never counts.
 */
const ROOT_ONLY = process.getuid?.() === 0 ? false : "sandbox live: skipped (not running as root)";

const str = (b: Buffer | string) => {
  const d = Buffer.isBuffer(b) ? b : Buffer.from(b);
  const l = Buffer.alloc(4);
  l.writeUInt32BE(d.length);
  return Buffer.concat([l, d]);
};
function edLine(pub: KeyObject, comment = ""): string {
  const raw = Buffer.from(pub.export({ format: "jwk" }).x as string, "base64url");
  return `ssh-ed25519 ${Buffer.concat([str("ssh-ed25519"), str(raw)]).toString("base64")}${comment}`;
}
function ecLine(pub: KeyObject): string {
  const j = pub.export({ format: "jwk" });
  const point = Buffer.concat([Buffer.from([4]), Buffer.from(j.x as string, "base64url"), Buffer.from(j.y as string, "base64url")]);
  return `ecdsa-sha2-nistp256 ${Buffer.concat([str("ecdsa-sha2-nistp256"), str("nistp256"), str(point)]).toString("base64")} other@host`;
}

const ed = generateKeyPairSync("ed25519");
const ec = generateKeyPairSync("ec", { namedCurve: "P-256" });
const ED_LINE = edLine(ed.publicKey, " alice@laptop");
const msgFor = (name: string) => loginMessage("hub1", name, randomBytes(32));
const signed = (name = "alice") => {
  const message = msgFor(name);
  return { message, signature: sign(null, message, ed.privateKey) };
};
const FILE = `# my keys\n\n${ecLine(ec.publicKey)}\n${ED_LINE}\n`;

/** A resolver that also hands out a uid-0 account (the real ones never do: KeyCheck must still refuse it). */
const resolverWith = (accounts: Record<string, Partial<LocalAccount>>): AccountResolver => withSignIn({
  async resolve(name) {
    if (!Object.hasOwn(accounts, name)) return null;
    return { name, uid: 1234, gid: 1234, groups: [1234], home: "/home/" + name, ...accounts[name] };
  },
});

/** A reader that answers `text`; like the real one it says when its (pretend) process is gone, after the answer. */
const fakeRead = (text: string | (() => Promise<string>)) => {
  const calls: { root: string; account: LocalAccount; file: string; maxBytes: number; timeoutMs: number }[] = [];
  const read: typeof readAsUser = async (root, account, file, maxBytes, o) => {
    calls.push({ root, account, file, maxBytes, timeoutMs: o?.timeoutMs });
    try {
      return await (typeof text === "function" ? text() : text);
    } finally {
      o?.closed();
    }
  };
  return { read, calls };
};
const str2 = (b: Buffer | string) => str(b);

test("listed key: a good signature gives ok, one over another name's message gives fail", async () => {
  const { read, calls } = fakeRead(FILE);
  const keys = new KeyCheck({ root: "/host", accounts: resolverWith({ alice: {} }), read });
  const good = signed("alice");
  assert.equal(await keys.check("alice", ED_LINE, good.message, good.signature), "ok");
  assert.deepEqual(calls.map((c) => [c.root, c.account.uid, c.file, c.maxBytes]), [["/host", 1234, "/home/alice/.ssh/authorized_keys", 256 * 1024]]);
  assert.equal(MAX_AUTHORIZED_KEYS, 256 * 1024);
  // the key without its comment is the same key
  assert.equal(await keys.check("alice", ED_LINE.split(" ").slice(0, 2).join(" "), good.message, good.signature), "ok");
  // a good signature over bob's login message, offered for alice
  const other = signed("bob");
  assert.equal(await keys.check("alice", ED_LINE, other.message, other.signature), "fail");
  // a good signature over bytes that are not a login message (a signed commit, say)
  const commit = Buffer.from("tree 4b825dc6\nauthor alice <a@b> 1 +0000\n\nfix\n");
  assert.equal(await keys.check("alice", ED_LINE, commit, sign(null, commit, ed.privateKey)), "fail");
  // a good signature over a login message with bytes after it
  const trailing = Buffer.concat([msgFor("alice"), Buffer.from([0])]);
  assert.equal(await keys.check("alice", ED_LINE, trailing, sign(null, trailing, ed.privateKey)), "fail");
  // other layouts, each well signed: wrong tag, empty or long hub id, short challenge, three strings, name case
  const build = (parts: (Buffer | string)[]) => Buffer.concat(parts.map(str2));
  for (const m of [
    build(["filedeck-login-v2", "hub1", "alice", randomBytes(32)]),
    build(["filedeck-login-v1", "", "alice", randomBytes(32)]),
    build(["filedeck-login-v1", "h".repeat(65), "alice", randomBytes(32)]),
    build(["filedeck-login-v1", "hub1", "alice", randomBytes(31)]),
    build(["filedeck-login-v1", "hub1", "alice"]),
    build(["filedeck-login-v1", "hub1", "Alice", randomBytes(32)]),
    build(["filedeck-login-v1", "hub1", "alice", randomBytes(32), ""]),
  ]) {
    assert.equal(await keys.check("alice", ED_LINE, m, sign(null, m, ed.privateKey)), "fail", m.toString("hex"));
  }
  assert.equal(calls.length, 2, "no reader for a message that is not alice's login message");
  // the parser itself
  const c = randomBytes(32);
  assert.deepEqual(parseLoginMessage(loginMessage("h".repeat(64), "alice", c)), { hubId: "h".repeat(64), name: "alice", challenge: c });
  assert.equal(parseLoginMessage(Buffer.concat([loginMessage("hub1", "alice", c), Buffer.from([0, 0, 0])])), null);
  // a key that is not listed, with a good signature of its own
  const stranger = generateKeyPairSync("ed25519");
  const m = msgFor("alice");
  assert.equal(await keys.check("alice", edLine(stranger.publicKey), m, sign(null, m, stranger.privateKey)), "fail");
  // a public key that is not one
  assert.equal(await keys.check("alice", "ssh-rsa AAAA", good.message, good.signature), "fail");
});

test("options make a key unusable", async () => {
  for (const prefix of ['command="x" ', 'from="10.0.0.0/8" ', "no-pty ", "restrict "]) {
    const { read } = fakeRead(`# keys\n${prefix}${ED_LINE}\n`);
    const keys = new KeyCheck({ root: "/", accounts: resolverWith({ alice: {} }), read });
    const s = signed();
    assert.equal(await keys.check("alice", ED_LINE, s.message, s.signature), "fail", prefix);
  }
  assert.equal(keyListed(`command="x" ${ED_LINE}`, ED_LINE), false);
  assert.equal(keyListed(`  ${ED_LINE}  `, ED_LINE), true);
  assert.equal(keyListed(`${ED_LINE}\r\n`, ED_LINE), true);
  assert.equal(keyListed("", ED_LINE), false);
  assert.equal(keyListed(ED_LINE, "garbage"), false);
});

test("unknown and refused: an unknown name gives unknown, a uid-0, gid-0 or group-0 account refused, and nothing is read", async () => {
  const { read, calls } = fakeRead(FILE);
  const keys = new KeyCheck({ root: "/", accounts: resolverWith({ toor: { uid: 0 }, wheel: { gid: 0 }, staff: { groups: [1234, 0] } }), read });
  for (const name of ["nobody-here", "-bad", "../x"]) {
    const s = signed(name);
    assert.equal(await keys.check(name, ED_LINE, s.message, s.signature), "unknown", name);
  }
  for (const name of ["toor", "wheel", "staff"]) {
    const s = signed(name);
    assert.equal(await keys.check(name, ED_LINE, s.message, s.signature), "refused", name);
  }
  assert.equal(calls.length, 0);
});

test("a file that cannot be read gives fail and one log line without the key or the signature", async () => {
  const log: string[] = [];
  const keys = new KeyCheck({ root: "/", accounts: resolverWith({ alice: {} }), read: fakeRead(() => Promise.reject(new Error("exit 1: Permission denied"))).read, log: (l) => log.push(l) });
  const s = signed();
  assert.equal(await keys.check("alice", ED_LINE, s.message, s.signature), "fail");
  assert.equal(log.length, 1);
  assert.match(log[0]!, /alice/);
  assert.match(log[0]!, /Permission denied/);
  const blob = ED_LINE.split(" ")[1]!;
  assert.ok(!log[0]!.includes(blob) && !log[0]!.includes(s.signature.toString("base64")));
  // a lookup that fails is not an answer: the caller says unavailable
  const broken = new KeyCheck({ root: "/", accounts: withSignIn({ resolve: () => Promise.reject(new Error("helper stopped")) }), read: fakeRead(FILE).read });
  await assert.rejects(broken.check("alice", ED_LINE, s.message, s.signature), /helper stopped/);
});

test("a home that is not absolute gives fail and one log line with the name only", async () => {
  const log: string[] = [];
  const { read, calls } = fakeRead(FILE);
  const keys = new KeyCheck({ root: "/", accounts: resolverWith({ alice: { home: "home/alice" } }), read, log: (l) => log.push(l) });
  const s = signed();
  assert.equal(await keys.check("alice", ED_LINE, s.message, s.signature), "fail");
  assert.equal(calls.length, 0);
  assert.deepEqual(log, ["keys: the home of alice is not an absolute path"]);
});

test("logged reasons are one line without control characters", () => {
  assert.equal(logLine("cat: x: Permission denied\r\nmore\x1b[31m"), "cat: x: Permission denied");
  assert.equal(logLine("a\tb\x7fc\x1bd"), "a b c d");
  assert.equal(logLine("x".repeat(300)).length, 200);
});

test("at most 4 readers at once; the place is given back when the reader is gone; a wait that runs out rejects", async () => {
  assert.equal(MAX_READERS, 4);
  const pending: { closed: () => void; answer: (s: string) => void }[] = [];
  let started = 0;
  const read: typeof readAsUser = (_root, _account, _file, _max, o) =>
    new Promise<string>((resolve) => {
      started++;
      pending.push({ closed: o.closed, answer: resolve });
    });
  const keys = new KeyCheck({ root: "/", accounts: resolverWith({ alice: {} }), read, timeoutMs: 300 });
  const s = signed();
  const first = Array.from({ length: 4 }, () => keys.check("alice", ED_LINE, s.message, s.signature));
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(started, 4);
  // the fifth waits; its time runs out while it waits: it rejects (the route says unavailable) and its reader never starts
  const t0 = Date.now();
  await assert.rejects(keys.check("alice", ED_LINE, s.message, s.signature), /no reader/);
  assert.ok(Date.now() - t0 >= 250);
  assert.equal(started, 4);
  // an answer without the process gone keeps the place
  pending[0]!.answer(FILE);
  assert.equal(await first[0], "ok");
  const sixth = keys.check("alice", ED_LINE, s.message, s.signature);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(started, 4);
  // the process is gone: the waiting call gets the place, with the rest of its time
  pending[0]!.closed();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(started, 5);
  assert.ok(pending[4]!, "the sixth started");
  pending[4]!.answer(FILE);
  pending[4]!.closed();
  assert.equal(await sixth, "ok");
  for (const p of pending.slice(1, 4)) {
    p.answer(FILE);
    p.closed();
  }
  assert.deepEqual(await Promise.all(first.slice(1)), ["ok", "ok", "ok"]);
  // a reader's own limit is what is left of the call's time
  const { read: r2, calls } = fakeRead(FILE);
  await new KeyCheck({ root: "/", accounts: resolverWith({ alice: {} }), read: r2 }).check("alice", ED_LINE, s.message, s.signature);
  assert.ok(calls[0]!.timeoutMs > 4000 && calls[0]!.timeoutMs <= 5000, String(calls[0]!.timeoutMs));
});

test("the reader's 5 s start after the account lookup; a reader that runs out of time gives unavailable, not fail", async () => {
  const s = signed();
  // a lookup that takes 300 ms leaves the reader its whole time
  const slow: AccountResolver = withSignIn({ resolve: async (name) => (await new Promise((r) => setTimeout(r, 300)), { name, uid: 1234, gid: 1234, groups: [1234], home: "/home/" + name }) });
  const { read, calls } = fakeRead(FILE);
  assert.equal(await new KeyCheck({ root: "/", accounts: slow, read, timeoutMs: 500 }).check("alice", ED_LINE, s.message, s.signature), "ok");
  assert.ok(calls[0]!.timeoutMs > 450 && calls[0]!.timeoutMs <= 500, String(calls[0]!.timeoutMs));
  // the reader's own limit: the call rejects (the route answers unavailable, and the hub asks the next machine)
  const log: string[] = [];
  const stuck = fakeRead(() => Promise.reject(new ReaderTimeout("no end within the 5 s limit")));
  await assert.rejects(new KeyCheck({ root: "/", accounts: resolverWith({ alice: {} }), read: stuck.read, log: (l) => log.push(l) }).check("alice", ED_LINE, s.message, s.signature), /5 s/);
  // any other read error is still a fail
  const denied = fakeRead(() => Promise.reject(new Error("exit 1: Permission denied")));
  assert.equal(await new KeyCheck({ root: "/", accounts: resolverWith({ alice: {} }), read: denied.read, log: () => {} }).check("alice", ED_LINE, s.message, s.signature), "fail");
});

test("the account lookup has its own limit: one that does not answer in time rejects (unavailable), and nothing is read", async () => {
  const s = signed();
  const { read, calls } = fakeRead(FILE);
  const hang: AccountResolver = withSignIn({ resolve: () => new Promise(() => {}) });
  const t0 = Date.now();
  await assert.rejects(new KeyCheck({ root: "/", accounts: hang, read, lookupTimeoutMs: 150 }).check("alice", ED_LINE, s.message, s.signature), /lookup/);
  const ms = Date.now() - t0;
  assert.ok(ms >= 140 && ms < 2000, `${ms} ms`);
  assert.equal(calls.length, 0);
});

// ------------------------------------------------------------------ the route

const T = "agent-secret-keys";
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "filedeck-keys-")));
fs.chmodSync(tmp, 0o755);
const apps: { close(): Promise<void> }[] = [];
const dropTmp = privateTmpdir();
after(async () => {
  for (const a of apps) await a.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  dropTmp();
});
const agent = (env: Record<string, string>, opts: { keys?: KeyCheck } = {}, sink?: (l: string) => void) => {
  const app = createAgent(loadConfig({ FILEDECK_ROOT: tmp, FILEDECK_NODE: "t", FILEDECK_AGENT_TOKEN: T, ...env } as never), sink, { accounts: fakeResolver({ alice: {} }), ...opts });
  apps.push(app as unknown as { close(): Promise<void> });
  return app;
};
const postKey = (app: ReturnType<typeof agent>, body: unknown, headers: Record<string, string> = { authorization: `Bearer ${T}` }) =>
  app.request("/api/auth/key", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
const goodBody = () => {
  const s = signed();
  return { name: "alice", publicKey: ED_LINE, message: s.message.toString("base64"), signature: s.signature.toString("base64") };
};

test("key route: the agent token and no user header give the result; the audit line has only the name", async () => {
  const lines: string[] = [];
  const keys = new KeyCheck({ root: "/", accounts: resolverWith({ alice: {} }), read: fakeRead(FILE).read });
  const app = agent({ FILEDECK_AUTH: "on" }, { keys }, (l) => lines.push(l));
  const body = goodBody();
  const r = await postKey(app, body);
  assert.deepEqual([r.status, await r.json()], [200, { result: "ok" }]);
  const line = lines.find((l) => l.includes("/api/auth/key"));
  assert.ok(line, lines.join("\n"));
  assert.deepEqual(JSON.parse(line).body, { name: "alice" });
  const all = lines.join("\n");
  assert.ok(!all.includes(body.signature) && !all.includes(body.message) && !all.includes(ED_LINE.split(" ")[1]!));
  const bad = await postKey(app, { ...body, signature: signed("bob").signature.toString("base64") });
  assert.deepEqual(await bad.json(), { result: "fail" });
  assert.deepEqual(await (await postKey(app, { ...body, name: "nobody-here" })).json(), { result: "unknown" });
});

test("key route: no token is 401, a bad body is 400 and echoes nothing, auth off has no route", async () => {
  const { read, calls } = fakeRead(FILE);
  const app = agent({ FILEDECK_AUTH: "on" }, { keys: new KeyCheck({ root: "/", accounts: resolverWith({ alice: {} }), read }) });
  const body = goodBody();
  assert.equal((await postKey(app, body, {})).status, 401);
  assert.equal((await postKey(app, body, { authorization: "Bearer wrong" })).status, 401);
  const bads: unknown[] = [
    [body.publicKey],
    { ...body, name: undefined },
    { ...body, name: "-alice" },
    { ...body, name: "a/b" },
    { ...body, name: "x".repeat(65) },
    { ...body, publicKey: 5 },
    { ...body, publicKey: "" },
    { ...body, publicKey: `${ED_LINE}\n${ED_LINE}` },
    { ...body, publicKey: `${ED_LINE}\0` },
    { ...body, publicKey: ED_LINE + " " + "c".repeat(5000) },
    { ...body, message: "not base64!" },
    { ...body, message: "" },
    { ...body, message: "A".repeat(8192) },
    { ...body, signature: "abc" },
    { ...body, signature: "A".repeat(1024) },
    { ...body, signature: randomBytes(129).toString("base64") },
    { ...body, message: randomBytes(1025).toString("base64") },
    { ...body, signature: undefined },
  ];
  for (const b of bads) {
    const r = await postKey(app, b);
    assert.equal(r.status, 400, JSON.stringify(b).slice(0, 200));
    const text = await r.text();
    assert.deepEqual(JSON.parse(text), { error: "name, publicKey, message and signature are needed" });
  }
  assert.equal(calls.length, 0);
  const off = agent({}, { keys: new KeyCheck({ root: "/", accounts: resolverWith({ alice: {} }), read }) });
  assert.equal((await postKey(off, body)).status, 404);
});

test("key route: no key check here, or a lookup that fails, gives unavailable", async () => {
  const none = agent({ FILEDECK_AUTH: "on" });
  assert.deepEqual(await (await postKey(none, goodBody())).json(), { result: "unavailable" });
  // a reader that runs out of time: unavailable, so the hub goes on to the next machine
  const late = new KeyCheck({ root: "/", accounts: resolverWith({ alice: {} }), read: fakeRead(() => Promise.reject(new ReaderTimeout("no end within the 5 s limit"))).read, log: () => {} });
  assert.deepEqual(await (await postKey(agent({ FILEDECK_AUTH: "on" }, { keys: late }), goodBody())).json(), { result: "unavailable" });
  const keys = new KeyCheck({ root: "/", accounts: withSignIn({ resolve: () => Promise.reject(new Error("helper stopped")) }), read: fakeRead(FILE).read, log: () => {} });
  const broken = agent({ FILEDECK_AUTH: "on" }, { keys });
  const r = await postKey(broken, goodBody());
  assert.deepEqual([r.status, await r.json()], [200, { result: "unavailable" }]);
});

// ------------------------------------------------------------------ live: the real read, as the user (root only)

const USER = 1234;
const GROUP = 4321;
let live: { dir: string } | undefined;
before(async () => {
  if (ROOT_ONLY) return;
  live = { dir: (await useSandbox()).dir };
});
after(() => {
  if (live) fs.rmSync(live.dir, { recursive: true, force: true });
  delete process.env.FILEDECK_SANDBOX_HELPER;
  resetSandbox();
});

/** A home for `alice` (uid 1234) below `base`, with `.ssh` 0700; returns the authorized_keys path (not made). */
function makeHome(base: string, home: string): string {
  const h = path.join(base, home);
  fs.mkdirSync(path.join(h, ".ssh"), { recursive: true, mode: 0o755 });
  fs.chownSync(h, USER, USER);
  fs.chmodSync(path.join(h, ".ssh"), 0o700);
  fs.chownSync(path.join(h, ".ssh"), USER, USER);
  return path.join(h, ".ssh/authorized_keys");
}
const writeAs = (file: string, text: string | Buffer, uid: number, gid: number, mode: number) => {
  fs.rmSync(file, { force: true });
  fs.writeFileSync(file, text);
  fs.chownSync(file, uid, gid);
  fs.chmodSync(file, mode);
};

/**
 * A small machine root below `base`: the container's `cat` (its real file, so a busybox `cat` still runs as `cat`) at `/bin/cat`, with
 * the libraries `ldd` names at the same paths. Nothing else from the container is in it.
 */
function machineRoot(base: string): string {
  const m = path.join(base, "machine");
  fs.mkdirSync(path.join(m, "bin"), { recursive: true });
  const cat = fs.realpathSync("/bin/cat");
  fs.copyFileSync(cat, path.join(m, "bin/cat"));
  fs.chmodSync(path.join(m, "bin/cat"), 0o755);
  const l = spawnSync("ldd", [cat], { encoding: "utf8" });
  for (const p of new Set(`${l.stdout ?? ""}`.match(/\/[^\s()]+/g) ?? [])) {
    if (!fs.existsSync(p)) continue;
    fs.mkdirSync(path.join(m, path.dirname(p)), { recursive: true });
    fs.copyFileSync(fs.realpathSync(p), path.join(m, p));
    fs.chmodSync(path.join(m, p), 0o755);
  }
  for (const d of ["", "bin", ...fs.readdirSync(m)]) fs.chmodSync(path.join(m, d), 0o755);
  return m;
}

const accountAt = (home: string, groups = [USER]): AccountResolver => resolverWith({ alice: { uid: USER, gid: USER, groups, home } });

test("read as the user: their own 0600 file gives ok; root's 0600 file gives fail; a group they are in can read", { skip: ROOT_ONLY }, async () => {
  const base = fs.mkdtempSync(path.join(tmp, "own-"));
  fs.chmodSync(base, 0o755);
  const file = makeHome(base, "home/alice");
  const home = path.join(base, "home/alice");
  writeAs(file, FILE, USER, USER, 0o600);
  const log: string[] = [];
  const keys = new KeyCheck({ root: "/", accounts: accountAt(home), log: (l) => log.push(l) });
  const s = signed();
  assert.equal(await keys.check("alice", ED_LINE, s.message, s.signature), "ok", log.join("\n"));
  writeAs(file, FILE, 0, 0, 0o600);
  assert.equal(await keys.check("alice", ED_LINE, s.message, s.signature), "fail");
  assert.equal(log.length, 1);
  assert.ok(!log[0]!.includes(ED_LINE.split(" ")[1]!));
  // root's file, readable by a group alice is in only as a supplementary group
  fs.chmodSync(path.join(home, ".ssh"), 0o755);
  writeAs(file, FILE, 0, GROUP, 0o640);
  assert.equal(await keys.check("alice", ED_LINE, s.message, s.signature), "fail");
  assert.equal(await new KeyCheck({ root: "/", accounts: accountAt(home, [USER, GROUP]) }).check("alice", ED_LINE, s.message, s.signature), "ok");
});

test("an absolute link in the machine's root reaches the machine's file; a link to root's file gives fail", { skip: ROOT_ONLY }, async () => {
  const base = fs.mkdtempSync(path.join(tmp, "link-"));
  fs.chmodSync(base, 0o755);
  const m = machineRoot(base);
  const file = makeHome(m, "home/alice");
  // the target exists only in the machine's root: resolved in the container's root, the read would fail
  const target = "/filedeck-test-keys/alice";
  assert.ok(!fs.existsSync(target));
  fs.mkdirSync(path.join(m, path.dirname(target)), { recursive: true, mode: 0o755 });
  writeAs(path.join(m, target), FILE, USER, USER, 0o600);
  fs.symlinkSync(target, file);
  const log: string[] = [];
  const keys = new KeyCheck({ root: m, accounts: accountAt("/home/alice"), log: (l) => log.push(l) });
  const s = signed();
  assert.equal(await keys.check("alice", ED_LINE, s.message, s.signature), "ok", log.join("\n"));
  // the same link to a file only root can read
  fs.chownSync(path.join(m, target), 0, 0);
  assert.equal(await keys.check("alice", ED_LINE, s.message, s.signature), "fail");
  assert.equal(log.length, 1);
});

test("a FIFO (unavailable), a large file, a file that is not UTF-8, a missing file and a missing cat (each fail)", { skip: ROOT_ONLY }, async () => {
  const base = fs.mkdtempSync(path.join(tmp, "odd-"));
  fs.chmodSync(base, 0o755);
  const m = machineRoot(base);
  const file = makeHome(m, "home/alice");
  const log: string[] = [];
  const keys = new KeyCheck({ root: m, accounts: accountAt("/home/alice"), log: (l) => log.push(l) });
  const s = signed();
  const check = () => keys.check("alice", ED_LINE, s.message, s.signature);
  // a FIFO nobody writes to: cat blocks in open; it is killed after 5 s
  execFileSync("mkfifo", ["-m", "0600", file]);
  fs.chownSync(file, USER, USER);
  const t0 = Date.now();
  await assert.rejects(check(), /5 s/); // (no answer in time: the route says unavailable, and the hub asks the next machine)
  const took = Date.now() - t0;
  assert.ok(took >= 4500 && took < 8000, `took ${took} ms`);
  // over the limit, even with the key in its first line
  writeAs(file, `${ED_LINE}\n${"#".repeat(MAX_AUTHORIZED_KEYS)}\n`, USER, USER, 0o600);
  assert.equal(await check(), "fail");
  assert.match(log.at(-1)!, /256 KiB/);
  // just under the limit is read
  writeAs(file, `${ED_LINE}\n${"#".repeat(MAX_AUTHORIZED_KEYS - ED_LINE.length - 2)}\n`, USER, USER, 0o600);
  assert.equal(await check(), "ok");
  // not UTF-8
  writeAs(file, Buffer.concat([Buffer.from(`${ED_LINE}\n# `), Buffer.from([0xff, 0xfe]), Buffer.from("\n")]), USER, USER, 0o600);
  assert.equal(await check(), "fail");
  assert.match(log.at(-1)!, /UTF-8/);
  // missing
  fs.rmSync(file);
  assert.equal(await check(), "fail");
  // the machine has no /bin/cat
  writeAs(file, FILE, USER, USER, 0o600);
  assert.equal(await check(), "ok");
  fs.rmSync(path.join(m, "bin/cat"));
  assert.equal(await check(), "fail");
  // a /bin/cat that is a folder
  fs.mkdirSync(path.join(m, "bin/cat"));
  assert.equal(await check(), "fail");
  for (const l of log) assert.ok(!l.includes(ED_LINE.split(" ")[1]!) && !l.includes(s.signature.toString("base64")), l);
  // readAsUser itself refuses root
  await assert.rejects(readAsUser(m, { name: "toor", uid: 0, gid: 0, groups: [], home: "/root" }, "/root/.ssh/authorized_keys", 1024, { timeoutMs: 5000, closed: () => {} }), /root/);
});
