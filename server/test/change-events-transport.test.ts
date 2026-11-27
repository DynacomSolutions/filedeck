import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import type { AddressInfo } from "node:net";
import { createAgent as makeAgent } from "../src/agent.ts";
import { createHub } from "../src/hub.ts";
import { loadConfig } from "../src/config.ts";
import { EventBus } from "../src/events/bus.ts";
import { DirWatchers } from "../src/events/dirwatch.ts";
import { fanIn } from "../src/events/fanin.ts";
import { registerChangeRoutes } from "../src/events/routes.ts";
import { startEventSocket } from "../src/events/socket.ts";
import { isChangesPath } from "../src/events/guard.ts";
import { agentError, registerFileRoutes } from "../src/agent-routes.ts";
import { makeAgentJobs } from "../src/archive-routes.ts";
import { localReader } from "../src/diff-routes.ts";

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "events-transport-")));
const cleanups: (() => void | Promise<void>)[] = [];
after(async () => {
  for (const c of cleanups.reverse()) await Promise.resolve(c()).catch(() => {});
  fs.rmSync(tmp, { recursive: true, force: true });
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (f: () => boolean, ms = 10_000) => {
  for (const t0 = Date.now(); !f() && Date.now() - t0 < ms; ) await sleep(10);
};
const dir = () => fs.mkdtempSync(path.join(tmp, "d-"));
/** A folder with a short path, for a Unix socket (its address holds about 100 bytes): the temporary folder when it is short enough, else the user's runtime folder. */
const shortDir = () => {
  const base = path.join(tmp, "s-").length < 60 ? tmp : (process.env.XDG_RUNTIME_DIR ?? tmp);
  const d = fs.mkdtempSync(path.join(base, "s-"));
  cleanups.push(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
};

function newBus(o: Partial<ConstructorParameters<typeof EventBus>[0]> = {}) {
  const b = new EventBus({ node: "n1", journal: { dir: null }, ...o });
  cleanups.push(() => b.close());
  return b;
}
const pub = (b: EventBus, kind: string, p: string, extra: Record<string, unknown> = {}) => b.publish({ kind, path: p, dir: false, ...extra } as never);

/** NDJSON lines of a fetch body, as parsed objects, pulled as they come. */
function lines(res: Response) {
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  const out: Record<string, unknown>[] = [];
  const done = (async () => {
    for (;;) {
      const { value, done } = await reader.read().catch(() => ({ value: undefined, done: true }));
      if (done) return;
      buf += dec.decode(value);
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        out.push(JSON.parse(buf.slice(0, i)));
        buf = buf.slice(i + 1);
      }
    }
  })();
  return { out, done, cancel: () => reader.cancel().catch(() => {}) };
}

const listen = (app: { fetch: never }) =>
  new Promise<ReturnType<typeof serve>>((res) => {
    const s: ReturnType<typeof serve> = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, () => res(s));
    cleanups.push(() => {
      s.close();
      (s as unknown as { closeAllConnections?(): void }).closeAllConnections?.();
    });
  });
const urlOf = (s: ReturnType<typeof serve>) => `http://127.0.0.1:${(s.address() as AddressInfo).port}`;

// ---- Unix socket ----

test("socket: the folder is 0750 and the socket 0660; a client sends one JSON line and reads NDJSON; the filter and since work", async () => {
  const b = newBus({ pingMs: 40 }); // (a client that vanished is found when the next line, a ping at the latest, cannot be written)
  for (let i = 1; i <= 3; i++) pub(b, "create", `/old${i}`);
  await b.whenServing();
  const sock = path.join(shortDir(), "run", "e.sock");
  const s = await startEventSocket(b, { path: sock });
  cleanups.push(() => s.close());
  assert.equal(fs.statSync(path.dirname(sock)).mode & 0o777, 0o750);
  assert.equal(fs.statSync(sock).mode & 0o777, 0o660);
  const c = net.connect(sock);
  const got: Record<string, unknown>[] = [];
  let buf = "";
  c.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const x = JSON.parse(buf.slice(0, i)) as Record<string, unknown>;
      if (x.kind !== "ping") got.push(x);
      buf = buf.slice(i + 1);
    }
  });
  c.write(JSON.stringify({ filter: { kind: ["create"], glob: ["*.md"] }, since: b.cursorOf(1) }) + "\n");
  pub(b, "create", "/new.md");
  pub(b, "modify", "/new.md");
  pub(b, "create", "/new.txt");
  await until(() => got.length >= 1);
  await sleep(50);
  assert.deepEqual(got.map((x) => x.path), ["/new.md"], "the old events had no .md name; the filter is applied in the agent");
  assert.equal(b.subscribers().socket, 1);
  c.destroy();
  await until(() => b.subscribers().socket === 0);
  assert.equal(b.subscribers().socket, 0, "the subscriber is released when the client goes");
});

test("socket: a bad request gets one error line and is closed; an idle client gets a ping", async () => {
  const b = newBus({ pingMs: 40 });
  const sock = path.join(shortDir(), "e.sock");
  const s = await startEventSocket(b, { path: sock });
  cleanups.push(() => s.close());
  const ask = (req: string) =>
    new Promise<string>((res) => {
      const c = net.connect(sock);
      let out = "";
      c.on("data", (d) => ((out += d), out.includes("\n") && c.destroy()));
      c.on("close", () => res(out));
      c.write(req + "\n");
    });
  assert.match(await ask("not json"), /"error"/);
  assert.match(await ask(JSON.stringify({ filter: { kind: ["nope"] } })), /unknown kind/);
  assert.match(await ask(JSON.stringify({ since: "garbage" })), /not a cursor/);
  assert.match(await ask(JSON.stringify({ filter: [] })), /filter is an object/);
  const ping = JSON.parse((await ask("{}")).split("\n")[0]!) as { kind: string };
  assert.equal(ping.kind, "ping");
});

test("socket: a stale socket file from an earlier process is replaced; close removes it", async () => {
  const b = newBus();
  const sock = path.join(shortDir(), "e.sock");
  const stale = net.createServer(); // the socket of an earlier process
  await new Promise<void>((res) => stale.listen(sock, () => res()));
  cleanups.push(() => void stale.close());
  const s = await startEventSocket(b, { path: sock });
  assert.ok(fs.statSync(sock).isSocket());
  await s.close();
  assert.equal(fs.existsSync(sock), false);
});

// ---- agent HTTP ----

test("agent GET /api/v1/changes: NDJSON, filters from the query, since, 400 for a bad filter or cursor; the subscriber goes with the client", async () => {
  const b = newBus();
  const app = new Hono();
  app.onError(agentError);
  registerChangeRoutes(app, b);
  const srv = await listen(app as never);
  pub(b, "create", "/a.md");
  pub(b, "create", "/b.txt");
  await b.whenServing();
  const ctl = new AbortController();
  const res = await fetch(`${urlOf(srv)}/api/v1/changes?glob=*.md&kind=create&kind=delete&since=${encodeURIComponent(b.cursorOf(0))}`, { signal: ctl.signal });
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type")!, /application\/x-ndjson/);
  const l = lines(res);
  pub(b, "create", "/c.md");
  pub(b, "modify", "/c.md");
  await until(() => l.out.length >= 2);
  assert.deepEqual(l.out.map((x) => x.path), ["/a.md", "/c.md"]);
  assert.equal(b.subscribers().http, 1);
  ctl.abort();
  await until(() => b.subscribers().http === 0);
  assert.equal(b.subscribers().http, 0);
  for (const q of ["kind=nope", "type=link", "prefix=relative", "label=x", "since=garbage", "since=other:x:1"]) {
    const r = await fetch(`${urlOf(srv)}/api/v1/changes?${q}`);
    assert.equal(r.status, 400, q);
    await r.text();
  }
});

test("agent GET /api/v1/changes: a process that is not the writer answers 503, not a stream that never speaks", async () => {
  const b = newBus({ journal: { dir: dir() }, writer: () => false, writerWaitMs: 50 });
  const app = new Hono();
  app.onError(agentError);
  registerChangeRoutes(app, b);
  const r = await app.request("/api/v1/changes");
  assert.equal(r.status, 503);
});

// ---- fan-in ----

/** A fake agent: serves the NDJSON a script gives, and records what it was asked. */
function fakeNode(node: string, script: (n: number, query: URLSearchParams) => Response | Promise<Response>) {
  const asked: URLSearchParams[] = [];
  return {
    node,
    asked,
    fetch: async (rest: string) => {
      const u = new URL(rest, "http://x");
      assert.equal(u.pathname, "/api/v1/changes");
      asked.push(u.searchParams);
      return script(asked.length, u.searchParams);
    },
  };
}
const ndjson = (ls: object[], keepOpen = false) => {
  const enc = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(ctl) {
        for (const l of ls) ctl.enqueue(enc.encode(JSON.stringify(l) + "\n"));
        if (!keepOpen) ctl.close();
      },
    }),
    { status: 200, headers: { "content-type": "application/x-ndjson" } },
  );
};
const evt = (node: string, seq: number, p: string) => ({ cursor: `${node}:e1:${seq}`, time: 1, node, kind: "create", dir: false, path: p });
const collect = async (stream: ReadableStream<Uint8Array>, n: number, ms = 5000) => {
  const reader = stream.getReader();
  const dec = new TextDecoder();
  const out: Record<string, unknown>[] = [];
  let buf = "";
  const t0 = Date.now();
  while (out.length < n && Date.now() - t0 < ms) {
    const r = await Promise.race([reader.read(), sleep(ms).then(() => ({ done: true, value: undefined }))]);
    if (r.done) break;
    buf += dec.decode(r.value);
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      out.push(JSON.parse(buf.slice(0, i)));
      buf = buf.slice(i + 1);
    }
  }
  await reader.cancel().catch(() => {});
  return out;
};

test("fan-in: lines of every node come through as written, the filter and each node's cursor go down to the agent", async () => {
  const a = fakeNode("a", () => ndjson([evt("a", 5, "/x"), evt("a", 6, "/y")], true));
  const b = fakeNode("b", () => ndjson([evt("b", 9, "/z")], true));
  const filter = new URLSearchParams("prefix=/srv&kind=create");
  const body = fanIn({ targets: [a, b], filter, since: new Map([["a", "a:e1:4"]]), retryMs: 20 });
  const got = await collect(body, 3);
  assert.deepEqual(got.map((x) => x.path).sort(), ["/x", "/y", "/z"]);
  assert.equal(a.asked[0]!.get("since"), "a:e1:4");
  assert.equal(b.asked[0]!.get("since"), null);
  assert.equal(a.asked[0]!.get("prefix"), "/srv");
  assert.equal(b.asked[0]!.get("kind"), "create");
  assert.deepEqual(got.filter((x) => x.node === "a").map((x) => x.cursor), ["a:e1:5", "a:e1:6"], "order is kept per node");
});

test("fan-in: a node that goes away is asked again from the last cursor it gave; its own lagged line is not passed on; an offline note comes once", async () => {
  let n = 0;
  const a = fakeNode("a", (call) => {
    n = call;
    if (call === 1) return ndjson([evt("a", 1, "/1"), evt("a", 2, "/2")]); // ends
    if (call === 2) return Promise.reject(new Error("down"));
    if (call === 3) return ndjson([{ kind: "lagged", node: "a", cursor: "a:e1:2" }]);
    return ndjson([evt("a", 3, "/3")], true);
  });
  const body = fanIn({ targets: [a], filter: new URLSearchParams(), retryMs: 10 });
  const got = await collect(body, 4);
  assert.deepEqual(got.map((x) => x.kind), ["create", "create", "offline", "create"]);
  assert.deepEqual(got.filter((x) => x.kind === "create").map((x) => x.path), ["/1", "/2", "/3"]);
  assert.equal(a.asked[0]!.get("since"), null);
  assert.equal(a.asked[1]!.get("since"), "a:e1:2");
  assert.equal(a.asked[3]!.get("since"), "a:e1:2");
  assert.ok(n >= 4);
});

test("fan-in: a node that refuses (4xx) is reported and left alone, the others go on", async () => {
  const a = fakeNode("a", () => new Response("no", { status: 403 }));
  const b = fakeNode("b", () => ndjson([evt("b", 1, "/ok")], true));
  const got = await collect(fanIn({ targets: [a, b], filter: new URLSearchParams(), retryMs: 10 }), 2);
  assert.ok(got.some((x) => x.kind === "error" && x.node === "a" && x.status === 403));
  assert.ok(got.some((x) => x.path === "/ok"));
  assert.equal(a.asked.length, 1, "no retry on a refusal");
});

test("fan-in: a client that does not read is ended with a lagged line that holds a cursor per node", async () => {
  const many = Array.from({ length: 300 }, (_, i) => evt("a", i + 1, "/" + "p".repeat(200) + i));
  const a = fakeNode("a", () => ndjson(many, true));
  const body = fanIn({ targets: [a], filter: new URLSearchParams(), since: new Map([["a", "a:e1:0"]]), maxQueueBytes: 20_000, pingMs: 10_000 });
  const reader = body.getReader();
  await sleep(100); // nothing is read yet
  const dec = new TextDecoder();
  let text = "";
  for (;;) {
    const r = await reader.read();
    if (r.done) break;
    text += dec.decode(r.value);
  }
  const ls = text.trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
  const last = ls.at(-1)!;
  assert.equal(last.kind, "lagged");
  // nothing had been given to the client yet: its own `since` is where it resumes (it must not lose the node's starting cursor)
  assert.deepEqual(last.cursors, { a: "a:e1:0" });
});

// ---- hub end to end ----

async function agentApp(name: string, env: Record<string, string> = {}) {
  const root = dir();
  const app = makeAgent(loadConfig({ FILEDECK_ROOT: root, FILEDECK_NODE: name, FILEDECK_AGENT_TOKEN: "agent-secret", ...env } as never));
  cleanups.push(() => (app as unknown as { close(): Promise<void> }).close());
  const srv = await listen(app as never);
  return { app: app as unknown as Hono & { events: EventBus }, srv, root };
}

test("hub GET /api/v1/changes?node=a,b merges the agents' streams, pushes the filter down, resumes per node with since", async () => {
  const a = await agentApp("a");
  const b = await agentApp("b");
  const hub = createHub(loadConfig({ FILEDECK_MODE: "hub", FILEDECK_STATIC: tmp, FILEDECK_AGENT_TOKEN: "agent-secret", NODES: `a=${urlOf(a.srv)},b=${urlOf(b.srv)}` } as never));
  cleanups.push(() => (hub as unknown as { close(): Promise<void> }).close());
  const hs = await listen(hub as never);
  pub(a.app.events, "create", "/one.md");
  pub(b.app.events, "create", "/two.md");
  await a.app.events.whenServing();
  await b.app.events.whenServing();
  const ctl = new AbortController();
  const res = await fetch(`${urlOf(hs)}/api/v1/changes?node=a,b&glob=*.md&kind=create`, { signal: ctl.signal });
  assert.equal(res.status, 200);
  const l = lines(res);
  await sleep(100);
  pub(a.app.events, "create", "/three.md");
  pub(a.app.events, "create", "/skipped.txt");
  pub(b.app.events, "delete", "/gone.md");
  pub(b.app.events, "create", "/four.md");
  await until(() => l.out.filter((x) => x.kind === "create").length >= 2);
  const got = l.out.filter((x) => x.kind === "create");
  assert.deepEqual(got.map((x) => `${x.node}:${x.path}`).sort(), ["a:/four.md".replace("a:", "b:"), "a:/three.md"].sort());
  assert.ok(a.app.events.subscribers().http === 1 && b.app.events.subscribers().http === 1, "one stream per agent");
  const last = got.find((x) => x.node === "a")!.cursor as string;
  ctl.abort();
  await until(() => a.app.events.subscribers().http === 0 && b.app.events.subscribers().http === 0);
  assert.equal(a.app.events.subscribers().http, 0, "the agents' streams end with the client's");
  // resume node a from the cursor: only what came after
  pub(a.app.events, "create", "/five.md");
  const res2 = await fetch(`${urlOf(hs)}/api/v1/changes?node=a&since=${encodeURIComponent(last)}`);
  const l2 = lines(res2);
  await until(() => l2.out.length >= 2);
  assert.deepEqual(l2.out.slice(0, 2).map((x) => x.path), ["/skipped.txt", "/five.md"]);
  await l2.cancel();
  // errors
  assert.equal((await fetch(`${urlOf(hs)}/api/v1/changes?node=nope`)).status, 404);
  assert.equal((await fetch(`${urlOf(hs)}/api/v1/changes?kind=nope`)).status, 400);
  assert.equal((await fetch(`${urlOf(hs)}/api/v1/changes?since=garbage`)).status, 400);
});

test("hub: the proxy path of one node streams too; an encoded path cannot dodge the check", async () => {
  const a = await agentApp("a");
  const hub = createHub(loadConfig({ FILEDECK_MODE: "hub", FILEDECK_STATIC: tmp, FILEDECK_AGENT_TOKEN: "agent-secret", NODES: `a=${urlOf(a.srv)}` } as never));
  cleanups.push(() => (hub as unknown as { close(): Promise<void> }).close());
  const hs = await listen(hub as never);
  const ctl = new AbortController();
  const res = await fetch(`${urlOf(hs)}/api/nodes/a/api/v1/changes?kind=create`, { signal: ctl.signal });
  assert.equal(res.status, 200);
  const l = lines(res);
  await sleep(100);
  pub(a.app.events, "create", "/p");
  await until(() => l.out.some((x) => x.path === "/p"));
  assert.ok(l.out.some((x) => x.path === "/p"));
  ctl.abort();
  for (const p of ["/api/v1/changes", "/api/v1/changes/", "/api/v1/%63hanges", "/api/v1/CHANGES", "/api//v1/./changes", "/api\\v1\\changes", "/api/v1/x/../changes"]) assert.equal(isChangesPath(p + "?x=1"), true, p);
  for (const p of ["/api/v1/changes2", "/api/fs/list", "/api/v1", "/api/v1/%zz"]) assert.equal(isChangesPath(p), false, p);
});

test("api token: the `changes` scope opens the change stream and nothing else; the default scope does not open it", async () => {
  const a = await agentApp("a");
  const mk = (scopes?: string) =>
    createHub(loadConfig({ FILEDECK_MODE: "hub", FILEDECK_STATIC: tmp, FILEDECK_AGENT_TOKEN: "agent-secret", FILEDECK_API_TOKEN: "tok-" + "z".repeat(30), ...(scopes ? { FILEDECK_API_TOKEN_SCOPES: scopes } : {}), NODES: `a=${urlOf(a.srv)}` } as never));
  const get = async (h: ReturnType<typeof mk>, p: string) => {
    const ctl = new AbortController();
    const r = await h.request(p, { headers: { "x-filedeck-token": "tok-" + "z".repeat(30) }, signal: ctl.signal });
    const status = r.status;
    ctl.abort();
    await r.body?.cancel().catch(() => {});
    return status;
  };
  const dflt = mk();
  cleanups.push(() => (dflt as unknown as { close(): Promise<void> }).close());
  assert.equal(await get(dflt, "/api/v1/changes"), 403, "default scope: du only");
  assert.equal(await get(dflt, "/api/nodes/a/api/du?path=/"), 200);
  const both = mk("du,changes");
  cleanups.push(() => (both as unknown as { close(): Promise<void> }).close());
  assert.equal(await get(both, "/api/v1/changes"), 200);
  assert.equal(await get(both, "/api/nodes/a/api/v1/changes"), 200);
  assert.equal(await get(both, "/api/nodes/a/api/du?path=/"), 200);
  assert.equal(await get(both, "/api/nodes/a/api/fs/list?path=/"), 403);
  const only = mk("changes");
  cleanups.push(() => (only as unknown as { close(): Promise<void> }).close());
  assert.equal(await get(only, "/api/v1/changes"), 200);
  assert.equal(await get(only, "/api/nodes/a/api/du?path=/"), 403);
  const post = await only.request("/api/v1/changes", { method: "POST", headers: { "x-filedeck-token": "tok-" + "z".repeat(30) } });
  assert.equal(post.status, 403, "read only");
  const bad = await only.request("/api/v1/changes", { headers: { "x-filedeck-token": "wrong" } });
  assert.equal(bad.status, 401);
});

test("config: scopes, socket, journal limits and label templates come from the environment, with safe defaults", () => {
  const c = loadConfig({ FILEDECK_MODE: "hub" } as never);
  assert.deepEqual(c.apiScopes, ["du"]);
  assert.equal(c.eventsSocket, "");
  assert.equal(c.eventsJournalBytes, 2 * 1024 ** 3);
  assert.equal(c.eventsJournalHours, 24);
  const d = loadConfig({ FILEDECK_API_TOKEN_SCOPES: " du , changes,du", FILEDECK_EVENTS_SOCKET: "/run/x/e.sock", FILEDECK_EVENTS_SOCKET_GROUP: "events", FILEDECK_EVENTS_JOURNAL_BYTES: "1000", FILEDECK_EVENTS_JOURNAL_HOURS: "2", FILEDECK_EVENTS_LABELS: "/srv/{a}" } as never);
  assert.deepEqual(d.apiScopes, ["du", "changes"]);
  assert.equal(d.eventsSocket, "/run/x/e.sock");
  assert.equal(d.eventsSocketGroup, "events");
  assert.equal(d.eventsJournalBytes, 1000);
  assert.equal(d.eventsJournalHours, 2);
  assert.equal(d.eventsLabels, "/srv/{a}");
});

// ---- the folder feed ----

test("folder feed: a callback fires for entries of its folder (and for a move on both sides), not for other folders; a reset fires every one", async () => {
  const b = newBus();
  b.ready = true;
  const feed = new DirWatchers(b, (v) => v.startsWith("/watched"));
  cleanups.push(() => feed.close());
  const hits: string[] = [];
  const off1 = feed.watch("/watched/a", () => hits.push("a"));
  const off2 = feed.watch("/watched/b", () => hits.push("b"));
  assert.ok(off1 && off2);
  assert.equal(feed.watch("/elsewhere", () => {}), null, "a folder the watcher does not cover is not watched");
  pub(b, "create", "/watched/a/f");
  pub(b, "modify", "/watched/a/deep/f");
  pub(b, "move", "/watched/b/new", { from: "/watched/a/old" });
  await sleep(20);
  assert.deepEqual(hits, ["a", "b", "a"]);
  hits.length = 0;
  b.publish({ kind: "overflow", scope: "node" });
  assert.deepEqual(hits.sort(), ["a", "b"]);
  hits.length = 0;
  off1!();
  pub(b, "create", "/watched/a/g");
  assert.deepEqual(hits, [], "after the closer");
  assert.equal(feed.count, 1);
  b.ready = false;
  assert.equal(feed.watch("/watched/c", () => {}), null, "no watcher: no watch");
  assert.equal(feed.alive(), false);
});

// ---- handover ----

test("journal: a clean hand-over between two processes loses nothing and makes no reset; the events both saw are not lost either", async () => {
  const d = dir();
  const first = newBus({ journal: { dir: d, flushMs: 5 } });
  pub(first, "ready", "");
  pub(first, "create", "/before");
  await first.whenServing();
  // the new process started its watcher before the old one stopped
  const second = newBus({ journal: { dir: d, flushMs: 5 }, writer: () => writerNow === "second" });
  let writerNow = "first";
  second.publish({ kind: "ready", scope: "node" });
  pub(second, "create", "/during-overlap");
  pub(first, "create", "/during-overlap");
  await first.close();
  writerNow = "second";
  assert.ok(await second.whenServing());
  pub(second, "create", "/after");
  const sub = await second.subscribe(new (await import("../src/events/filter.ts")).Filter(), `n1:${second.journal.epoch}:0`, "http");
  const out: Record<string, unknown>[] = [];
  const l0 = Date.now();
  while (out.length < 6 && Date.now() - l0 < 3000) {
    const batch = await Promise.race([sub.next(), sleep(500).then(() => null)]);
    if (!batch) break;
    for (const x of batch) out.push(JSON.parse(x.toString("utf8")));
  }
  const kinds = out.map((x) => x.kind);
  assert.ok(!kinds.includes("reset"), `no reset: ${kinds.join(",")}`);
  const paths = out.filter((x) => x.kind === "create").map((x) => x.path);
  assert.ok(paths.includes("/before") && paths.includes("/during-overlap") && paths.includes("/after"), paths.join(","));
});

test("live change feed (/api/events): through the folder feed when the watcher covers the folder (no watch of its own), ends when the watcher stops, falls back when it does not cover", async () => {
  const root = dir();
  const cfg = loadConfig({ FILEDECK_ROOT: root, FILEDECK_NODE: "t" } as never);
  const jobs = makeAgentJobs(cfg);
  const watched: string[] = [];
  const callbacks = new Set<() => void>();
  let alive = true;
  let covers = true;
  const feed = {
    watch(v: string, cb: () => void) {
      if (!covers) return null;
      watched.push(v);
      callbacks.add(cb);
      return () => void callbacks.delete(cb);
    },
    alive: () => alive,
  };
  const app = new Hono();
  app.onError(agentError);
  const files = registerFileRoutes(app, cfg, jobs, { feed });
  cleanups.push(() => files.close());
  const srv = await listen(app as never);
  const ctl = new AbortController();
  const res = await fetch(`${urlOf(srv)}/api/events?path=/`, { signal: ctl.signal });
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let text = "";
  const pump = (async () => {
    for (;;) {
      const x = await reader.read().catch(() => ({ done: true, value: undefined }));
      if (x.done) return;
      text += dec.decode(x.value);
    }
  })();
  await until(() => text.includes("event: ready"));
  assert.deepEqual(watched, ["/"]);
  assert.equal(files.watches.size, 0, "no fs.watch of its own");
  for (const cb of callbacks) cb();
  await until(() => text.includes("event: change"));
  assert.match(text, /event: change/);
  alive = false;
  await Promise.race([pump, sleep(3000)]);
  assert.equal(callbacks.size, 0, "the stream ended when the watcher stopped, and let go of its watch");
  ctl.abort();
  // a folder the watcher does not cover: the bounded fallback serves it
  covers = false;
  const ctl2 = new AbortController();
  const fb = await fetch(`${urlOf(srv)}/api/events?path=/`, { signal: ctl2.signal });
  const r2 = fb.body!.getReader();
  assert.match(new TextDecoder().decode((await r2.read()).value), /event: ready/);
  assert.equal(files.watches.size, 1, "the fallback watch");
  ctl2.abort();
  await r2.cancel().catch(() => {});
});

test("compare index reader: a folder is watched through the event bus while the watcher covers it, and by a watch of its own where it does not", async () => {
  const root = dir();
  fs.mkdirSync(path.join(root, "sub"));
  const callbacks: (() => void)[] = [];
  let covers = true;
  const feed = {
    watch(v: string, cb: () => void) {
      if (!covers) return null;
      assert.equal(v, "/sub", "the feed is asked with the agent's path, not the machine's");
      callbacks.push(cb);
      return () => void callbacks.splice(callbacks.indexOf(cb), 1);
    },
    alive: () => true,
  };
  const reader = localReader(root, { feed });
  let told = 0;
  const close = reader.watch!(path.join(root, "sub"), () => told++)!;
  assert.equal(callbacks.length, 1, "no watch of its own was made");
  callbacks[0]!();
  assert.equal(told, 1);
  close();
  assert.equal(callbacks.length, 0);
  covers = false;
  const close2 = reader.watch!(path.join(root, "sub"), () => told++)!;
  assert.equal(callbacks.length, 0);
  fs.writeFileSync(path.join(root, "sub", "x"), "x");
  await until(() => told >= 2);
  assert.ok(told >= 2, "the folder's own watch told it");
  close2();
});

test("folder feed: when the watcher stops every watch is told and dropped, so the callers fall back to their own way of noticing changes", async () => {
  const b = newBus();
  b.ready = true;
  const feed = new DirWatchers(b, () => true);
  cleanups.push(() => feed.close());
  const told: string[] = [];
  feed.watch("/a", () => told.push("a"));
  feed.watch("/b", () => told.push("b"));
  assert.equal(feed.count, 2);
  b.ready = false; // the helper exited and does not come back (no capability, an old kernel)
  assert.deepEqual(told.sort(), ["a", "b"]);
  assert.equal(feed.count, 0);
  pub(b, "create", "/a/x");
  assert.deepEqual(told.sort(), ["a", "b"], "a dropped watch hears nothing more");
  assert.equal(feed.watch("/a", () => {}), null, "and no new one is made while the watcher is away");
  b.ready = true;
  assert.ok(feed.watch("/a", () => {}), "the watcher is back");
});

test("folder feed: a process that is not the writer still gets the kernel events of its folders", async () => {
  const b = newBus({ journal: { dir: dir() }, writer: () => false, writerWaitMs: 20 });
  b.ready = true;
  const feed = new DirWatchers(b, () => true);
  cleanups.push(() => feed.close());
  let told = 0;
  feed.watch("/a", () => told++);
  pub(b, "create", "/a/x");
  assert.equal(b.serving, false);
  assert.equal(told, 1);
});

test("socket: it does not touch a folder it does not own, and does not remove a path that is not a socket", async () => {
  const b = newBus();
  // a folder that belongs to someone else: refused, and its mode is not changed
  const foreign = shortDir();
  fs.chmodSync(foreign, 0o755);
  await assert.rejects(startEventSocket(b, { path: path.join(foreign, "e.sock"), uid: (process.getuid?.() ?? 0) + 1 }), /not owned/);
  assert.equal(fs.statSync(foreign).mode & 0o777, 0o755);
  // a regular file at the socket's place is kept
  const d = shortDir();
  const f = path.join(d, "e.sock");
  fs.writeFileSync(f, "precious");
  await assert.rejects(startEventSocket(b, { path: f }), /not a socket/);
  assert.equal(fs.readFileSync(f, "utf8"), "precious");
  // a link in place of the folder is refused
  const real = path.join(d, "real");
  fs.mkdirSync(real);
  fs.symlinkSync(real, path.join(d, "link"));
  fs.chmodSync(real, 0o755);
  await assert.rejects(startEventSocket(b, { path: path.join(d, "link", "e.sock") }), /not a folder/);
  assert.equal(fs.statSync(real).mode & 0o777, 0o755, "the folder behind the link was not changed");
  // an old socket of a dead process is replaced, and close removes only a socket
  const old = path.join(d, "old.sock");
  const stale = net.createServer();
  await new Promise<void>((res) => stale.listen(old, () => res()));
  cleanups.push(() => void stale.close());
  const s = await startEventSocket(b, { path: old });
  assert.ok(fs.lstatSync(old).isSocket());
  await s.close();
  assert.equal(fs.existsSync(old), false);
});
