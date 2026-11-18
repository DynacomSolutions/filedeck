import assert from "node:assert/strict";
import test from "node:test";
import type { Identity } from "../src/auth/identity.ts";
import { PushStore } from "../src/push/store.ts";
import { PushWatch, endsToSend, payloadFor, type SourcedJob } from "../src/push/watch.ts";

const H = 3600_000;
const job = (id: string, state: string, finishedAt: number | undefined, extra: Partial<SourcedJob> = {}): SourcedJob => ({ source: "ops", id, title: `Copy ${id}`, state, finishedAt, ...extra });

test("only done or failed jobs from the app, ended after the subscription and in the last day, are sent", () => {
  const now = 100 * H;
  const jobs = [
    job("a", "done", now - 1000),
    job("b", "failed", now - 1000, { error: "No space left on device\nmore" }),
    job("c", "canceled", now - 1000),
    job("d", "running", undefined),
    job("e", "done", 10 * H), // before the subscription
    job("f", "done", now - 1000, { origin: "watcher" }),
    job("g", "done", now - 1000, { origin: "cli" }),
    job("h", "done", now - 1000, { origin: "ui" }),
    job("i", "waiting", undefined),
  ];
  assert.deepEqual(endsToSend(jobs, 50 * H, now).map((j) => j.id), ["a", "b", "h"]);
  // never more than a day back, even for an old subscription
  assert.deepEqual(endsToSend([job("x", "done", now - 25 * H)], 0, now), []);
});

test("one end is its title and outcome; several fold into one, failures counted", () => {
  assert.deepEqual(payloadFor([job("a", "done", 1)]), { title: "Copy a finished", body: "", tag: "filedeck-job:ops:a" });
  assert.deepEqual(payloadFor([job("b", "failed", 1, { error: "No space left on device\nstack" })]), { title: "Copy b failed", body: "No space left on device", tag: "filedeck-job:ops:b" });
  assert.deepEqual(payloadFor([job("a", "done", 1), job("b", "failed", 1), job("c", "done", 1, { source: "node:x" })]), {
    title: "3 jobs ended, 1 failed",
    body: "Copy a finished\nCopy b failed\nCopy c finished",
    tag: "filedeck-jobs",
  });
  assert.equal(payloadFor([job("a", "done", 1), job("b", "done", 1)]).title, "2 jobs finished");
  // a long title or error is cut
  assert.ok(payloadFor([job("a".repeat(500), "failed", 1, { error: "e".repeat(2000) })]).body.length <= 300);
});

const alice: Identity = { kind: "sys", name: "alice", admin: false, epoch: 1 };

function setup(o: { holds?: (s: string) => boolean; jobs?: SourcedJob[]; status?: number; identity?: Identity | null }) {
  let t = 100 * H;
  const store = new PushStore(":memory:", () => t);
  const sent: { endpoint: string; payload: unknown }[] = [];
  const asked: (Identity | undefined)[] = [];
  const w = new PushWatch({
    store,
    subject: "https://example.test",
    signIn: !!o.holds,
    sessionHolds: o.holds,
    identityOf: () => (o.identity === undefined ? alice : o.identity ?? undefined),
    listJobs: async (id) => {
      asked.push(id);
      return o.jobs ?? [];
    },
    send: async (x) => {
      sent.push({ endpoint: x.endpoint, payload: x.payload });
      return o.status ?? 201;
    },
    now: () => t,
    log: () => undefined,
  });
  const add = (n: number, owner = "sys:alice", session: string | null = "s1") =>
    store.add({ endpoint: `https://fcm.googleapis.com/fcm/send/e${n}`, p256dh: "p", auth: "a", owner, session });
  return { store, sent, asked, w, add, at: (v: number) => (t = v), now: () => t };
}

test("a tick sends each end once to every subscription of the account, asking as the account", async () => {
  const s = setup({ holds: () => true, jobs: [job("a", "done", 100 * H + 5)] });
  s.add(1);
  s.add(2, "sys:alice", "s2");
  s.at(100 * H + 10);
  await s.w.tick();
  assert.equal(s.sent.length, 2);
  assert.deepEqual(s.asked, [alice]);
  await s.w.tick();
  assert.equal(s.sent.length, 2, "not sent again");
});

test("a subscription whose session no longer holds is removed before anything is sent", async () => {
  const s = setup({ holds: (k) => k !== "s1", jobs: [job("a", "done", 100 * H + 5)] });
  s.add(1, "sys:alice", "s1");
  s.at(100 * H + 10);
  await s.w.tick();
  assert.equal(s.sent.length, 0);
  assert.equal(s.store.of("sys:alice").length, 0);
  assert.equal(s.asked.length, 0, "the account's jobs are not even asked for");
});

test("an account that is gone loses its subscriptions", async () => {
  const s = setup({ holds: () => true, identity: null, jobs: [job("a", "done", 100 * H + 5)] });
  s.add(1);
  await s.w.tick();
  assert.equal(s.sent.length, 0);
  assert.deepEqual(s.store.owners(), []);
});

test("404 or 410 from the push service removes the subscription", async () => {
  const s = setup({ holds: () => true, status: 410, jobs: [job("a", "done", 100 * H + 5)] });
  s.add(1);
  s.at(100 * H + 10);
  await s.w.tick();
  assert.equal(s.sent.length, 1);
  assert.deepEqual(s.store.owners(), []);
});

test("sign-in off: the shared subscriptions get the ends, asked with no account", async () => {
  const s = setup({ jobs: [job("a", "failed", 100 * H + 5)] });
  s.add(1, "", null);
  s.at(100 * H + 10);
  await s.w.tick();
  assert.equal(s.sent.length, 1);
  assert.deepEqual(s.asked, [undefined]);
});

test("a subscription made after a job ended does not get that end", async () => {
  const s = setup({ holds: () => true, jobs: [job("a", "done", 100 * H - 5)] });
  s.add(1);
  await s.w.tick();
  assert.equal(s.sent.length, 0);
});
