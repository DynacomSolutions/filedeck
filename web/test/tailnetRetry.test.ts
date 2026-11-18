import assert from "node:assert/strict";
import test from "node:test";
import { TailnetUnavailableError, type Me } from "../src/auth.ts";
import { TailnetRetry, type RetryView } from "../src/tailnetRetry.ts";

type Answer = Me | "signed-out" | Error;
/** A retry loop with a scripted `me`: each call takes the next answer, and stays pending when `hold` is set. */
function rig(answers: Answer[]) {
  const views: RetryView[] = [];
  const results: (Me | "signed-out")[] = [];
  let calls = 0;
  const pending: (() => void)[] = [];
  let hold = false;
  const r = new TailnetRetry({
    me: () => {
      calls++;
      const a = answers.shift() ?? new TailnetUnavailableError("down");
      const settle = <T,>(ok: (v: Me | "signed-out") => void, no: (e: Error) => void) => () => (a instanceof Error ? no(a) : ok(a));
      return new Promise((ok, no) => (hold ? pending.push(settle(ok, no)) : settle(ok, no)()));
    },
    onView: (v) => views.push(v),
    onResult: (m) => results.push(m),
  });
  return { r, views, results, calls: () => calls, pending, setHold: (h: boolean) => (hold = h) };
}
const flush = () => new Promise<void>((ok) => setImmediate(ok));
const ME: Me = { auth: true, kind: "virt", name: "alice", admin: false };

test("retry: asks again after 1 s, 2 s, 4 s while tailscaled does not answer, then reports the answer and stops", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { r, views, results, calls } = rig([new TailnetUnavailableError("down"), new TailnetUnavailableError("down"), ME]);
  r.start();
  assert.deepEqual(views.at(-1), { trying: false, failures: 0 });
  t.mock.timers.tick(999);
  await flush();
  assert.equal(calls(), 0, "not before 1 s");
  t.mock.timers.tick(1);
  await flush();
  assert.equal(calls(), 1);
  assert.deepEqual(views.at(-1), { trying: false, failures: 1 }, "a failed try changes the view, so the status text changes");
  t.mock.timers.tick(1999);
  await flush();
  assert.equal(calls(), 1, "the second wait is 2 s");
  t.mock.timers.tick(1);
  await flush();
  assert.equal(calls(), 2);
  t.mock.timers.tick(4000);
  await flush();
  assert.equal(calls(), 3);
  assert.deepEqual(results, [ME]);
  assert.equal(r.running, false);
  t.mock.timers.tick(60_000);
  await flush();
  assert.equal(calls(), 3, "nothing more once it answered");
});

test("retry: start while running does nothing (every request of the app reports the same 503)", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { r, calls } = rig([ME]);
  r.start();
  r.start();
  r.start();
  t.mock.timers.tick(1000);
  await flush();
  assert.equal(calls(), 1);
});

test("retry: a sign-out answer is reported; other failures keep asking", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { r, results, calls } = rig([new Error("network"), "signed-out"]);
  r.start();
  t.mock.timers.tick(1000);
  await flush();
  t.mock.timers.tick(2000);
  await flush();
  assert.equal(calls(), 2);
  assert.deepEqual(results, ["signed-out"]);
  assert.equal(r.running, false);
});

test("retry: Try now asks at once, shows trying, ignores presses meanwhile, and keeps the backoff", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const x = rig([new TailnetUnavailableError("down"), ME]);
  x.r.start();
  x.setHold(true);
  x.r.tryNow();
  assert.equal(x.calls(), 1);
  assert.deepEqual(x.views.at(-1), { trying: true, failures: 0 });
  x.r.tryNow();
  x.r.tryNow();
  assert.equal(x.calls(), 1, "presses while a try is in flight are ignored");
  t.mock.timers.tick(5000);
  await flush();
  assert.equal(x.calls(), 1, "the timer does not ask while a try is in flight");
  x.setHold(false);
  x.pending.shift()!();
  await flush();
  assert.deepEqual(x.views.at(-1), { trying: false, failures: 1 });
  t.mock.timers.tick(1999);
  await flush();
  assert.equal(x.calls(), 1, "after a failed Try now the wait is 2 s");
  t.mock.timers.tick(1);
  await flush();
  assert.deepEqual(x.results, [ME]);
});

test("retry: stop ends the loop and drops a late answer", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const x = rig([ME]);
  x.r.start();
  x.setHold(true);
  x.r.tryNow();
  x.r.stop();
  x.pending.shift()!();
  await flush();
  t.mock.timers.tick(60_000);
  await flush();
  assert.deepEqual(x.results, []);
  assert.equal(x.calls(), 1);
});
