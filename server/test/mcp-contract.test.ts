import { test } from "node:test";
import assert from "node:assert/strict";
import { changeIdOf, eventIdOf } from "../src/mcp/events.ts";
import { bodyOf, boot, job, sleep, until, type Boot } from "./mcp-support.ts";

// The client side of contract 2 (docs/mcp.md): the notification identity, the arming of list_changed, and the signals of a gap.

const JOBS = "filedeck://nodes/n/jobs";
const SCANS = "filedeck://nodes/n/scans";
const init = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "raw", version: "1" } } };

test("an event id is the same for the same audience, URI and revision, and different for any other", () => {
  assert.equal(eventIdOf("", JOBS, 5), eventIdOf("", JOBS, 5), "a replay has the id of the first notice");
  assert.equal(eventIdOf(undefined, JOBS, 5), eventIdOf("", JOBS, 5));
  assert.notEqual(eventIdOf("", JOBS, 5), eventIdOf("", JOBS, 6));
  assert.notEqual(eventIdOf("", JOBS, 5), eventIdOf("", SCANS, 5));
  assert.notEqual(eventIdOf("", JOBS, 5), eventIdOf("svc", JOBS, 5));
  assert.match(eventIdOf("", JOBS, 1795600012345), /^[0-9a-f]{12}\.1795600012345$/);
  assert.equal(changeIdOf(["a@1", "b@2"]), changeIdOf(["b@2", "a@1"]), "the order of the parts does not matter");
  assert.notEqual(changeIdOf(["a@1", "b@2"]), changeIdOf(["a@1", "b@3"]));
});

test("every notice has _meta.eventId equal to _meta.filedeck.eventId; one change gives one notice for each resource, each with its own id and a shared changeId", async (t) => {
  const b = await boot();
  t.after(() => b.close());
  b.agent.state.jobs.push(job("s1", "size", "running"));
  const c = await b.connect();
  for (const uri of ["filedeck://jobs/s1", JOBS, SCANS]) await c.client.subscribeResource({ uri });
  b.agent.state.jobs[0]!.state = "done";
  await until(() => c.updated.length >= 3);
  await sleep(300);
  assert.equal(c.updated.length, 3, "one notice for each resource");
  const metas = c.updated.map((u) => u._meta as { eventId?: string; filedeck: { eventId: string; revision: number; uri: string; changeId: string; streamId: string; seq: number } });
  for (const [i, m] of metas.entries()) {
    assert.equal(typeof m.eventId, "string");
    assert.ok(m.eventId!.length > 0);
    assert.equal(m.eventId, m.filedeck.eventId, "the same value at the top of _meta and in _meta.filedeck");
    assert.equal(m.filedeck.uri, c.updated[i]!.uri);
    assert.equal(typeof m.filedeck.revision, "number");
  }
  assert.equal(new Set(metas.map((m) => m.eventId)).size, 3, "each notice has its own id");
  assert.equal(new Set(metas.map((m) => m.filedeck.changeId)).size, 1, "the notices of one change share a changeId");
  assert.ok(metas[0]!.filedeck.changeId.length > 0);
  for (const m of metas) assert.equal(m.eventId, eventIdOf("", m.filedeck.uri, m.filedeck.revision), "the id is made of the audience, the URI and the revision");

  // a job appears: the list of jobs changes, and the notice of the list (list_changed) is part of the same change
  const before = c.updated.length;
  b.agent.state.jobs.push(job("s2", "compress", "running"));
  await until(() => c.listChanged.n >= 1 && c.updated.length > before);
  const list = c.listChanged.metas[0] as { eventId: string; filedeck: { eventId: string; revision: number; uri: string; changeId: string; streamId: string; seq: number } };
  assert.equal(typeof list.eventId, "string");
  assert.equal(list.eventId, list.filedeck.eventId);
  assert.equal(list.filedeck.uri, "filedeck://resources");
  const jobsNotice = c.updated.slice(before).find((u) => u.uri === JOBS)!._meta as unknown as typeof list;
  assert.equal(list.filedeck.changeId, jobsNotice.filedeck.changeId, "list_changed and the jobs notice are one change");
  assert.notEqual(list.eventId, jobsNotice.eventId);
  assert.equal(list.eventId, eventIdOf("", "filedeck://resources", list.filedeck.revision));
});

test("list_changed is armed from initialize: a fresh session that only subscribes gets it, and so does a replacement session", async (t) => {
  const b = await boot({ env: { FILEDECK_MCP_SESSIONS_PER_GRANT: "1" } });
  t.after(() => b.close());
  const first = await b.connect();
  await first.client.subscribeResource({ uri: "filedeck://nodes/n/status" }); // never lists resources
  b.agent.state.jobs.push(job("j1", "compress", "running"));
  await until(() => first.listChanged.n >= 1);
  assert.equal((first.listChanged.metas[0] as { filedeck: { uri: string } }).filedeck.uri, "filedeck://resources");

  // a second session takes the place of the first (one session for each grant); it only subscribes too
  const second = await b.connect();
  await assert.rejects(first.client.listResources(), "the first session was replaced");
  await second.client.subscribeResource({ uri: "filedeck://nodes/n/status" });
  b.agent.state.jobs.length = 0;
  await until(() => second.listChanged.n >= 1);
  assert.match(await (await b.hub.metrics.request("/metrics")).text(), /filedeck_mcp_watched_nodes 2/, "the watches of the replaced session ended, and those of the new one run");

  // a session that does nothing at all, not even a subscribe, is armed as well
  const idle = await boot({ env: { FILEDECK_MCP_SESSIONS_PER_GRANT: "1" } });
  t.after(() => idle.close());
  const quiet = await idle.connect();
  idle.agent.state.jobs.push(job("j2", "compress", "running"));
  await until(() => quiet.listChanged.n >= 1);
});

test("a baseline read is not an event: reads and a new session make no notification and no eventId", async (t) => {
  const b = await boot();
  t.after(() => b.close());
  b.agent.state.jobs.push(job("s1", "size", "running"));
  const c = await b.connect();
  for (const uri of [JOBS, SCANS]) await c.client.subscribeResource({ uri });
  await sleep(300);
  for (let i = 0; i < 3; i++) {
    for (const uri of [JOBS, SCANS, "filedeck://jobs/s1", "filedeck://nodes"]) {
      const body = bodyOf(await c.client.readResource({ uri }));
      assert.equal("eventId" in body, false, "a read body holds no event id");
    }
  }
  // the procedure after a gap: a new session, subscribe, read
  const again = await b.connect();
  for (const uri of [JOBS, SCANS]) await again.client.subscribeResource({ uri });
  for (const uri of [JOBS, SCANS]) bodyOf(await again.client.readResource({ uri }));
  await sleep(600);
  assert.equal(c.updated.length, 0);
  assert.equal(again.updated.length, 0);
  assert.equal(c.listChanged.n + again.listChanged.n, 0);
});

// ---- the gap signals of an event stream ----

interface Raw {
  sid: string;
  post(msg: object): Promise<string>;
  stream(extra?: Record<string, string>): Promise<{ events: any[]; stop(): void }>;
}

async function rawSession(b: Boot): Promise<Raw> {
  const headers = (extra: Record<string, string> = {}) => ({ authorization: `Bearer ${b.token}`, "content-type": "application/json", accept: "application/json, text/event-stream", ...extra });
  const open = await fetch(b.url + "/mcp", { method: "POST", headers: headers(), body: JSON.stringify(init) });
  const sid = open.headers.get("mcp-session-id")!;
  await open.text();
  const post = async (msg: object) => (await fetch(b.url + "/mcp", { method: "POST", headers: headers({ "mcp-session-id": sid, "mcp-protocol-version": "2025-06-18" }), body: JSON.stringify(msg) })).text();
  await post({ jsonrpc: "2.0", method: "notifications/initialized" });
  return {
    sid,
    post,
    async stream(extra = {}) {
      const ctl = new AbortController();
      const res = await fetch(b.url + "/mcp", { method: "GET", headers: headers({ "mcp-session-id": sid, "mcp-protocol-version": "2025-06-18", ...extra }), signal: ctl.signal });
      assert.equal(res.status, 200);
      const events: any[] = [];
      void (async () => {
        const dec = new TextDecoder();
        let buf = "";
        try {
          for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
            buf += dec.decode(chunk, { stream: true });
            for (let i = buf.indexOf("\n\n"); i >= 0; i = buf.indexOf("\n\n")) {
              const block = buf.slice(0, i);
              buf = buf.slice(i + 2);
              const data = block.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("");
              if (data) events.push(JSON.parse(data));
            }
          }
        } catch {
          /* aborted */
        }
      })();
      return { events, stop: () => ctl.abort() };
    },
  };
}

test("a stream has an id and a count from 1; a new stream has a new id; notices that no stream could take are counted in `missed`", async (t) => {
  const b = await boot();
  t.after(() => b.close());
  const s = await rawSession(b);
  await s.post({ jsonrpc: "2.0", id: 2, method: "resources/subscribe", params: { uri: JOBS } });
  const one = await s.stream();
  b.agent.state.jobs.push(job("j1", "compress", "running"));
  await sleep(350);
  b.agent.state.jobs[0]!.state = "done";
  await until(() => one.events.filter((e) => e.method === "notifications/resources/updated").length >= 2);
  const notices = (events: any[]) => events.filter((e) => String(e.method).startsWith("notifications/resources/"));
  const f1 = notices(one.events).map((e) => e.params._meta.filedeck);
  assert.equal(new Set(f1.map((f) => f.streamId)).size, 1, "one stream, one id");
  assert.match(f1[0].streamId, /^[0-9a-f]{8}$/);
  // list_changed and updated share the numbering of the stream, so every notice of the stream is counted
  assert.deepEqual(f1.map((f) => f.seq), f1.map((_, i) => i + 1), "the count starts at 1 and has no hole");
  for (const f of f1) assert.equal("missed" in f, false, "nothing was lost on this stream");
  const lastSeq = f1.at(-1).seq;

  // the stream ends (a broken connection); two changes happen while the client has no stream
  one.stop();
  await sleep(150);
  b.agent.state.jobs[0]!.state = "failed";
  await sleep(350);
  b.agent.state.jobs[0]!.state = "canceled";
  await sleep(350);

  // the client connects again with a Last-Event-ID: the header is ignored, and nothing is replayed
  const two = await s.stream({ "last-event-id": "999" });
  await sleep(200);
  assert.equal(notices(two.events).length, 0, "no replay");
  b.agent.state.jobs[0]!.state = "queued";
  await until(() => notices(two.events).length >= 1);
  const f2 = notices(two.events)[0].params._meta.filedeck;
  assert.notEqual(f2.streamId, f1[0].streamId, "a new stream has a new id: a gap is possible");
  assert.equal(f2.seq, 1, "the count of a new stream starts at 1");
  assert.equal(f2.missed, 2, "two notices had no stream to go to");
  assert.ok(lastSeq >= 2);
  // the next notice on the same stream says nothing is missed
  b.agent.state.jobs[0]!.state = "running";
  await until(() => notices(two.events).length >= 2);
  const f3 = notices(two.events)[1].params._meta.filedeck;
  assert.equal(f3.streamId, f2.streamId);
  assert.equal(f3.seq, 2);
  assert.equal("missed" in f3, false);
  two.stop();
});

test("status notices of a node whose job list never answers have one event id each", async (t) => {
  const b = await boot();
  t.after(() => b.close());
  b.agent.state.fail.add("/api/jobs");
  const c = await b.connect();
  await c.client.subscribeResource({ uri: "filedeck://nodes/n/status" });
  for (const running of [false, true, false]) {
    const n0 = c.updated.length;
    b.agent.state.watcherRunning = running;
    await until(() => c.updated.length > n0, 5000);
  }
  await sleep(300);
  const ids = c.updated.filter((u) => u.uri === "filedeck://nodes/n/status").map((u) => u._meta!.filedeck!);
  assert.equal(ids.length, 3);
  assert.equal(new Set(ids.map((x) => x.eventId)).size, 3, "three changes, three event ids");
  assert.equal(new Set(ids.map((x) => x.revision)).size, 3);
});
