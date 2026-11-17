import assert from "node:assert/strict";
import test from "node:test";
import { AsRootState, STOP_FAILED } from "../src/asRoot.ts";
import type { Account, Me } from "../src/auth.ts";

const MIN = 60_000;
const admin = (extra: Partial<Account> = {}): Account => ({ auth: true, kind: "sys", name: "alice", admin: true, ...extra });
/** A me() answer the test resolves by hand, in any order. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((a, b) => ((resolve = a), (reject = b)));
  return { promise, resolve, reject };
}
const flush = () => new Promise<void>((r) => setImmediate(r));

test("off for auth off, a virtual account and a system account that is not an administrator, whatever the hub says", () => {
  const me = async (): Promise<Me> => admin();
  const stop = async () => {};
  for (const a of [undefined, admin({ kind: "virt", admin: false, asRootEndsAt: Date.now() + MIN }), admin({ admin: false, asRootEndsAt: Date.now() + MIN })]) {
    const s = new AsRootState(a, { me, stop });
    assert.equal(s.get().endsAt, undefined);
    s.start(Date.now() + MIN);
    assert.equal(s.get().endsAt, undefined);
    s.dispose();
  }
});

test("the hub decides: an end that the browser clock thinks is past is still shown, and ends by the local timer", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: 1_000_000 });
  let answer: Me = admin();
  let calls = 0;
  // the account was read with 10 minutes left by the hub's clock; the browser clock is 20 minutes ahead of the hub,
  // so asRootUntil (hub time) is in the browser's past, but the local end is 10 minutes from now
  const s = new AsRootState(admin({ asRootUntil: 1_000_000 - 10 * MIN, asRootLeftMs: 10 * MIN, asRootEndsAt: 1_000_000 + 10 * MIN }), { me: async () => (calls++, answer), stop: async () => {} });
  assert.equal(s.get().endsAt, 1_000_000 + 10 * MIN);
  t.mock.timers.tick(10 * MIN - 1);
  assert.equal(s.get().endsAt, 1_000_000 + 10 * MIN, "still on 1 ms before the local end");
  const before = calls;
  t.mock.timers.tick(1);
  assert.equal(s.get().endsAt, undefined, "off at the local end");
  await flush();
  assert.equal(calls, before + 1, "the end asks the hub again");
  s.dispose();
});

test("while on, the hub is asked every 60 s, so an end it decides shows within a minute", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: 5_000_000 });
  let answer: Me = admin({ asRootLeftMs: 10 * MIN, asRootEndsAt: 5_000_000 + 10 * MIN });
  let calls = 0;
  const s = new AsRootState(admin({ asRootLeftMs: 10 * MIN, asRootEndsAt: 5_000_000 + 10 * MIN }), { me: async () => (calls++, answer), stop: async () => {} });
  t.mock.timers.tick(MIN);
  await flush();
  assert.equal(calls, 1);
  assert.ok(s.get().endsAt);
  answer = admin(); // the name left the admins: the hub no longer reports the switch
  t.mock.timers.tick(MIN);
  await flush();
  assert.equal(calls, 2);
  assert.equal(s.get().endsAt, undefined);
  t.mock.timers.tick(5 * MIN);
  await flush();
  assert.equal(calls, 2, "no polling once off");
  s.dispose();
});

test("Stop: confirmed by DELETE and a me() without the switch hides the banner, with no alert", async () => {
  const calls: string[] = [];
  const s = new AsRootState(admin({ asRootEndsAt: Date.now() + MIN }), { me: async () => (calls.push("me"), admin()), stop: async () => void calls.push("delete") });
  await s.stop();
  assert.deepEqual(calls, ["delete", "me"]);
  assert.deepEqual(s.get(), { endsAt: undefined, stopping: false, stopFailed: false });
  s.dispose();
});

test("Stop that the hub has not confirmed keeps the banner and says so", async () => {
  const on = () => admin({ asRootLeftMs: MIN, asRootEndsAt: Date.now() + MIN });
  const cases: [string, () => Promise<void>, () => Promise<Me>][] = [
    ["DELETE fails", async () => { throw new Error("500"); }, async () => on()],
    ["me() fails after DELETE", async () => {}, async () => { throw new TypeError("network"); }],
    ["me() still reports the switch", async () => {}, async () => on()],
  ];
  for (const [why, stop, me] of cases) {
    const s = new AsRootState(on(), { me, stop });
    await s.stop();
    assert.ok(s.get().endsAt, `${why}: the banner stays`);
    assert.equal(s.get().stopFailed, true, `${why}: the alert shows`);
    assert.equal(s.get().stopping, false);
    // the next Stop clears the alert while it runs
    s.dispose();
  }
  assert.equal(STOP_FAILED, "Could not stop acting as root. Try again.");
});

test("only the newest me() answer counts: an old 'on' after Stop is ignored", async () => {
  const old = deferred<Me>();
  let n = 0;
  const s = new AsRootState(admin({ asRootEndsAt: Date.now() + MIN }), { me: () => (n++ === 0 ? old.promise : Promise.resolve(admin())), stop: async () => {} });
  const pending = s.refresh(); // e.g. a focus check, still in flight
  await s.stop();
  assert.equal(s.get().endsAt, undefined);
  old.resolve(admin({ asRootLeftMs: MIN, asRootEndsAt: Date.now() + MIN }));
  await pending;
  assert.equal(s.get().endsAt, undefined, "the old answer does not turn the banner back on");
  s.dispose();
});

test("only the newest me() answer counts: an old 'off' after a renewal is ignored", async () => {
  const old = deferred<Me>();
  const s = new AsRootState(admin({ asRootEndsAt: Date.now() + MIN }), { me: () => old.promise, stop: async () => {} });
  const pending = s.refresh();
  s.start(Date.now() + 15 * MIN); // the dialog turned it on again meanwhile
  old.resolve(admin());
  await pending;
  assert.ok(s.get().endsAt, "the old answer does not hide the renewed switch");
  s.dispose();
});

test("subscribers hear every change; dispose stops the timers", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: 9_000_000 });
  let calls = 0;
  const s = new AsRootState(admin(), { me: async () => (calls++, admin()), stop: async () => {} });
  let heard = 0;
  const off = s.subscribe(() => heard++);
  s.start(9_000_000 + MIN);
  assert.equal(heard, 1);
  off();
  s.dispose();
  t.mock.timers.tick(10 * MIN);
  await flush();
  assert.equal(calls, 0, "no timer runs after dispose");
});
