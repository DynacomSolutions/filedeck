import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { createHub } from "../src/hub.ts";
import { loadConfig } from "../src/config.ts";
import { LiveStreams } from "../src/auth/streams.ts";
import type { NodeAccess } from "../src/auth/identity.ts";

/**
 * Event streams end with their session (part 2b, Task 7). A change feed is a request that never ends on its own, so the gate's check at
 * its start is not enough: sign-out, ending an account's sessions, expiry, an epoch rise and the end of the act-as-root switch must end
 * the streams opened under them, on the client's side and on the agent's (the agent's watcher is released).
 */

const T = "agent-secret-streams";
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "filedeck-streams-")));
fs.writeFileSync(path.join(tmp, "index.html"), "<!doctype html><title>t</title>");

/** A fake agent: `/api/events` answers a change feed that stays open; it counts the feeds it serves and the ones the hub cut off. */
interface Fake {
  url: string;
  opened: number;
  /** feeds closed by the other side (the hub) */
  aborted: number;
  /** ends every open feed from the agent's side */
  endAll(): void;
  /** while set, a feed waits for it before it answers (the hub's call is still in flight) */
  hold?: Promise<void>;
  /** called when a feed request arrives */
  onArrive?: () => void;
}
const servers: http.Server[] = [];
const hubs: { close(): Promise<void> }[] = [];
after(async () => {
  for (const h of hubs) await h.close().catch(() => {});
  for (const s of servers) {
    s.close();
    s.closeAllConnections();
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function fakeAgent(): Promise<Fake> {
  const open = new Set<http.ServerResponse>();
  const f: Fake = {
    url: "",
    opened: 0,
    aborted: 0,
    endAll: () => {
      for (const r of open) r.end();
      open.clear();
    },
  };
  const srv = http.createServer(async (req, res) => {
    // a change feed, and (for the API token test) a folder-size answer that asks for one
    if (req.url?.startsWith("/api/events") || (req.url?.startsWith("/api/du") && req.url.includes("feed=1"))) {
      f.onArrive?.();
      if (f.hold) await f.hold;
      f.opened++;
      open.add(res);
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
      res.write(": open\n\n");
      res.on("close", () => {
        if (open.delete(res)) f.aborted++;
      });
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  servers.push(srv);
  f.url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  return f;
}

const agent = await fakeAgent();
const ACCESS: Record<string, NodeAccess> = { a: { runAs: "guest", grants: [{ path: "/", write: true }] } };

type Hub = ReturnType<typeof createHub>;
let clock = Date.now();
function makeHub(env: Record<string, string> = {}, streamCheckMs = 50): Hub {
  const h = createHub(
    loadConfig({ FILEDECK_MODE: "hub", FILEDECK_AUTH: "on", FILEDECK_AGENT_TOKEN: T, FILEDECK_STATIC: tmp, NODES: `a=${agent.url}`, FILEDECK_ADMINS: "alice", FILEDECK_DIFF_DIR: path.join(tmp, `diff-${hubs.length}`), FILEDECK_AUTH_FILE: path.join(tmp, `auth-${hubs.length}.db`), ...env } as never),
    undefined,
    () => {},
    { now: () => clock, streamCheckMs },
  );
  hubs.push(h);
  return h;
}
const peer = { incoming: { socket: { remoteAddress: "127.0.0.1", encrypted: false } } };
const call = (h: Hub, p: string, cookie: string, init: RequestInit = {}) => h.request("http://localhost" + p, { ...init, headers: { ...(init.headers as Record<string, string>), cookie } }, peer as never);

/** A cookie for a virtual account (made straight in the store), and the raw session value. */
function virt(h: Hub, name: string): { cookie: string; raw: string } {
  if (!h.auth!.accounts.get(name)) h.auth!.accounts.create({ name, password: `pw-${name}-123`, admin: false, nodes: ACCESS });
  const raw = h.auth!.sessions.create("virt", name);
  return { cookie: `__Host-filedeck=${raw}`, raw };
}

/** Opens the change feed through the hub and reads its first chunk; `ended` resolves true when the body ends, false if it is still open after `ms`. */
async function openFeed(h: Hub, cookie: string) {
  const before = agent.opened;
  // as EventSource asks for it
  const r = await call(h, "/api/nodes/a/api/events?path=/", cookie, { headers: { accept: "text/event-stream" } });
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-type") ?? "", /^text\/event-stream/);
  const reader = r.body!.getReader();
  const first = await reader.read();
  assert.equal(first.done, false);
  assert.equal(agent.opened, before + 1);
  const end = (async () => {
    for (;;) {
      const x = await reader.read().catch(() => ({ done: true }));
      if (x.done) return true;
    }
  })();
  return {
    reader,
    ended: (ms = 1000) => Promise.race([end, new Promise<boolean>((res) => setTimeout(() => res(false), ms))]),
  };
}

async function waitFor(fn: () => boolean, ms = 2000) {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) assert.fail("timeout");
    await new Promise((r) => setTimeout(r, 10));
  }
}

test("sign-out ends streams: the body ends within 1 s, the agent sees its request cut, and the old cookie gets the signed-out 401", async () => {
  const h = makeHub();
  const { cookie } = virt(h, "g1");
  const feed = await openFeed(h, cookie);
  assert.equal(h.streams!.size(), 1);
  const cut = agent.aborted;
  const out = await call(h, "/api/auth/logout", cookie, { method: "POST" });
  assert.equal(out.status, 200);
  assert.equal(await feed.ended(1000), true, "the stream ended");
  await waitFor(() => agent.aborted === cut + 1);
  assert.equal(h.streams!.size(), 0);
  const again = await call(h, "/api/nodes/a/api/events?path=/", cookie, { headers: { accept: "text/event-stream" } });
  assert.equal(again.status, 401);
  assert.equal(again.headers.get("x-filedeck-auth"), "signed-out");
});

test("endAll for an account ends its streams and leaves another account's stream open", async () => {
  const h = makeHub();
  const g1 = await openFeed(h, virt(h, "g1").cookie);
  const g2 = await openFeed(h, virt(h, "g2").cookie);
  assert.equal(h.streams!.size(), 2);
  h.auth!.sessions.endAll("virt", "g1");
  assert.equal(await g1.ended(1000), true);
  assert.equal(await g2.ended(200), false, "the other account's stream stays open");
  assert.equal(h.streams!.size(), 1);
  await g2.reader.cancel();
  await waitFor(() => h.streams!.size() === 0);
});

test("a session that expires (idle) ends its stream at the next check", async () => {
  clock = Date.now();
  const h = makeHub();
  const feed = await openFeed(h, virt(h, "g1").cookie);
  assert.equal(await feed.ended(150), false, "still open while the session holds");
  clock += 9 * 3600_000; // past the 8 h idle limit
  assert.equal(await feed.ended(1000), true);
  assert.equal(h.streams!.size(), 0);
  clock = Date.now();
});

test("an epoch rise made outside the hub (as the CLI does) ends the stream at the next check", async () => {
  const h = makeHub();
  const feed = await openFeed(h, virt(h, "g1").cookie);
  h.auth!.accounts.bumpEpoch("virt", "g1");
  assert.equal(await feed.ended(1000), true);
  assert.equal(h.streams!.size(), 0);
});

test("a deleted virtual account ends its stream at the next check", async () => {
  const h = makeHub();
  const feed = await openFeed(h, virt(h, "g1").cookie);
  h.auth!.db.db.prepare("DELETE FROM accounts WHERE name = ?").run("g1");
  assert.equal(await feed.ended(1000), true);
});

test("client closes and the agent ends: the entry is removed either way, and the agent's request is cut when the client closes", async () => {
  const h = makeHub();
  const { cookie } = virt(h, "g1");
  const a = await openFeed(h, cookie);
  const cut = agent.aborted;
  await a.reader.cancel();
  await waitFor(() => h.streams!.size() === 0);
  await waitFor(() => agent.aborted === cut + 1);
  const b = await openFeed(h, cookie);
  assert.equal(h.streams!.size(), 1);
  agent.endAll();
  assert.equal(await b.ended(1000), true);
  assert.equal(h.streams!.size(), 0);
});

/** alice, a system administrator, with the act-as-root switch on (set straight in the store). */
function rootSession(h: Hub) {
  const raw = h.auth!.sessions.create("sys", "alice");
  const until = clock + 15 * 60_000;
  h.auth!.sessions.setAsRoot(raw, until);
  return { cookie: `__Host-filedeck=${raw}`, raw, until };
}

test("act as root: DELETE /api/auth/as-root ends streams opened under the switch; the session stays signed in", async () => {
  clock = Date.now();
  const h = makeHub();
  const { cookie } = rootSession(h);
  const feed = await openFeed(h, cookie);
  const cut = agent.aborted;
  const off = await call(h, "/api/auth/as-root", cookie, { method: "DELETE" });
  assert.equal(off.status, 200);
  assert.equal(await feed.ended(1000), true);
  await waitFor(() => agent.aborted === cut + 1);
  assert.equal(h.streams!.size(), 0);
  assert.equal((await call(h, "/api/auth/me", cookie)).status, 200, "still signed in");
});

test("act as root: a stream opened under the switch ends when its end passes", async () => {
  clock = Date.now();
  const h = makeHub();
  const { cookie, until } = rootSession(h);
  const feed = await openFeed(h, cookie);
  assert.equal(await feed.ended(150), false);
  clock = until + 1;
  assert.equal(await feed.ended(1000), true);
  assert.equal(h.streams!.size(), 0);
  clock = Date.now();
});

test("act as root: sign-out ends streams opened under the switch", async () => {
  clock = Date.now();
  const h = makeHub();
  const { cookie } = rootSession(h);
  const feed = await openFeed(h, cookie);
  await call(h, "/api/auth/logout", cookie, { method: "POST" });
  assert.equal(await feed.ended(1000), true);
  assert.equal(h.streams!.size(), 0);
});

test("hub close ends every stream", async () => {
  const h = makeHub();
  const feed = await openFeed(h, virt(h, "g1").cookie);
  await h.close();
  assert.equal(await feed.ended(1000), true);
  assert.equal(h.streams!.size(), 0);
});

test("auth off: no stream tracking at all, and the feed passes as before", async () => {
  const h = createHub(loadConfig({ FILEDECK_MODE: "hub", FILEDECK_STATIC: tmp, NODES: `a=${agent.url}`, FILEDECK_DIFF_DIR: path.join(tmp, "diff-off") } as never), undefined, () => {});
  hubs.push(h);
  assert.equal(h.streams, undefined);
  const r = await h.request("http://localhost/api/nodes/a/api/events?path=/", { headers: { accept: "text/event-stream" } }, peer as never);
  assert.equal(r.status, 200);
  const reader = r.body!.getReader();
  assert.equal((await reader.read()).done, false);
  await reader.cancel();
});

/** A body that stays open until cancelled, and notes the cancel. */
function upstream() {
  const u = { cancelled: false, res: undefined as unknown as Response };
  u.res = new Response(
    new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode(": open\n\n"));
      },
      cancel() {
        u.cancelled = true;
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  );
  return u;
}

test("LiveStreams: told to end, it cancels the upstream and calls abort; endSession and endAccount pick only their own; close ends all", async () => {
  const valid = new Set(["k1", "k2", "k3"]);
  const ls = new LiveStreams({ peek: (k) => valid.has(k), checkMs: 60_000 });
  const aborts: string[] = [];
  const u1 = upstream();
  const u2 = upstream();
  const u3 = upstream();
  const r1 = ls.track("k1", "virt", "g1", u1.res, { abort: () => aborts.push("k1") });
  ls.track("k2", "virt", "g1", u2.res, { abort: () => aborts.push("k2") });
  const r3 = ls.track("k3", "sys", "bob", u3.res, { abort: () => aborts.push("k3") });
  assert.equal(ls.size(), 3);
  ls.endSession("k1");
  assert.equal(ls.size(), 2);
  assert.equal(u1.cancelled, true);
  assert.deepEqual(aborts, ["k1"]);
  const rd = r1.body!.getReader();
  for (let i = 0; i < 3 && !(await rd.read()).done; i++); // a chunk already queued may still be read, then the body ends
  assert.equal((await rd.read()).done, true);
  ls.endAccount("virt", "g1");
  assert.equal(ls.size(), 1);
  assert.equal(u2.cancelled, true);
  ls.close();
  assert.equal(ls.size(), 0);
  assert.equal(u3.cancelled, true);
  assert.deepEqual(aborts.sort(), ["k1", "k2", "k3"]);
  void r3;
});

test("LiveStreams: endAsRoot ends only the streams opened under the switch; a check that finds the switch gone ends them too", async () => {
  let rootOk = true;
  const ls = new LiveStreams({ peek: () => true, checkMs: 20 });
  const plain = upstream();
  const root = upstream();
  const root2 = upstream();
  ls.track("k", "sys", "alice", plain.res);
  ls.track("k", "sys", "alice", root.res, { asRoot: { until: Date.now() + 60_000, ok: () => true } });
  ls.endAsRoot("k");
  assert.equal(root.cancelled, true);
  assert.equal(plain.cancelled, false);
  assert.equal(ls.size(), 1);
  ls.track("k", "sys", "alice", root2.res, { asRoot: { until: Date.now() + 60_000, ok: () => rootOk } });
  rootOk = false;
  await waitFor(() => root2.cancelled);
  assert.equal(ls.size(), 1);
  assert.equal(plain.cancelled, false);
  ls.close();
  assert.equal(ls.size(), 0);
});

test("LiveStreams: the switch's end in real time ends a root stream without waiting for the check", async () => {
  const ls = new LiveStreams({ peek: () => true, checkMs: 60_000 });
  const root = upstream();
  ls.track("k", "sys", "alice", root.res, { asRoot: { until: Date.now() + 50, ok: () => true } });
  await waitFor(() => root.cancelled, 1000);
  assert.equal(ls.size(), 0);
  ls.close();
});

test("LiveStreams: a stream whose session (or switch) already ended when it is tracked ends at once", () => {
  const ls = new LiveStreams({ peek: (k) => k === "ok", checkMs: 60_000 });
  const gone = upstream();
  const rootGone = upstream();
  ls.track("gone", "virt", "g1", gone.res);
  ls.track("ok", "sys", "alice", rootGone.res, { asRoot: { until: Date.now() + 60_000, ok: () => false } });
  assert.equal(gone.cancelled, true);
  assert.equal(rootGone.cancelled, true);
  assert.equal(ls.size(), 0);
  ls.close();
});

test("a session's absolute end ends its stream on time, by its own timer (not the check)", async () => {
  clock = Date.now();
  const h = makeHub({ FILEDECK_SESSION_MAX_SECONDS: "1" }, 60_000);
  const feed = await openFeed(h, virt(h, "g1").cookie);
  assert.equal(await feed.ended(500), false, "open before the end");
  assert.equal(await feed.ended(1500), true, "ended at the session's absolute end");
  assert.equal(h.streams!.size(), 0);
});

test("LiveStreams: endsAt ends the stream at that time without waiting for the check, and the timer goes with the entry", async () => {
  const ls = new LiveStreams({ peek: () => true, checkMs: 60_000 });
  const u = upstream();
  ls.track("k", "virt", "g1", u.res, { endsAt: Date.now() + 50 });
  await waitFor(() => u.cancelled, 1000);
  assert.equal(ls.size(), 0);
  const v = upstream();
  ls.track("k", "virt", "g1", v.res, { endsAt: Date.now() - 1 });
  assert.equal(v.cancelled, true, "already past: ended at once");
  ls.close();
});

test("a feed made with the API token is not tied to a session: nothing is tracked, even with a cookie beside it", async () => {
  const h = makeHub({ FILEDECK_API_TOKEN: "du-token-123456", FILEDECK_API_TOKEN_ACCOUNT: "g1" });
  const { cookie } = virt(h, "g1");
  const r = await call(h, "/api/nodes/a/api/du?path=/&feed=1", cookie, { headers: { accept: "text/event-stream", "x-filedeck-token": "du-token-123456" } });
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-type") ?? "", /^text\/event-stream/);
  const reader = r.body!.getReader();
  assert.equal((await reader.read()).done, false);
  assert.equal(h.streams!.size(), 0);
  await reader.cancel();
});

test("a feed opened without Accept: text/event-stream (not EventSource) is passed on untracked", async () => {
  const h = makeHub();
  const r = await call(h, "/api/nodes/a/api/events?path=/", virt(h, "g1").cookie);
  assert.equal(r.status, 200);
  const reader = r.body!.getReader();
  assert.equal((await reader.read()).done, false);
  assert.equal(h.streams!.size(), 0);
  await reader.cancel();
});

test("a new sign-in that replaces the session ends the old session's feed", async () => {
  const h = makeHub();
  const { cookie } = virt(h, "g1");
  const feed = await openFeed(h, cookie);
  const r = await call(h, "/api/auth/login", cookie, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "g1", password: "pw-g1-123" }) });
  assert.equal(r.status, 200);
  assert.equal(await feed.ended(1000), true);
  assert.equal(h.streams!.size(), 0);
});

test("the race: the session ends while the agent call is in flight; the stream ends at once when it is tracked", async () => {
  const h = makeHub({}, 60_000); // no check to fall back on: only the check at track time can end it
  const { cookie, raw } = virt(h, "g1");
  let release!: () => void;
  agent.hold = new Promise<void>((r) => (release = r));
  const arrived = new Promise<void>((r) => (agent.onArrive = r));
  const cut = agent.aborted;
  try {
    const pending = call(h, "/api/nodes/a/api/events?path=/", cookie, { headers: { accept: "text/event-stream" } });
    await arrived; // the gate let it through and the agent has it
    h.auth!.sessions.destroy(raw); // signed out meanwhile: its end is told before the stream exists
    release();
    const r = await pending;
    assert.equal(r.status, 200);
    const reader = r.body!.getReader();
    const end = (async () => {
      while (!(await reader.read()).done);
      return true;
    })();
    assert.equal(await Promise.race([end, new Promise<boolean>((res) => setTimeout(() => res(false), 1000))]), true, "ended at once, not at the next check");
    assert.equal(h.streams!.size(), 0);
    await waitFor(() => agent.aborted === cut + 1);
  } finally {
    agent.hold = undefined;
    agent.onArrive = undefined;
  }
});

test("LiveStreams: an absolute end further away than a timer can hold does not end the stream at once", async () => {
  const ls = new LiveStreams({ peek: () => true, checkMs: 60_000 });
  const u = upstream();
  ls.track("k", "virt", "g1", u.res, { endsAt: Date.now() + 40 * 24 * 3600_000 });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(u.cancelled, false);
  assert.equal(ls.size(), 1);
  ls.close();
});
