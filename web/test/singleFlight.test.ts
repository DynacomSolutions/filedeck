import assert from "node:assert/strict";
import test from "node:test";
import { singleFlight } from "../src/singleFlight.ts";

test("singleFlight ignores calls while one is running and reports busy", async () => {
  let calls = 0;
  let release: () => void = () => undefined;
  const states: boolean[] = [];
  const run = singleFlight(() => (calls++, new Promise<void>((r) => (release = r))), (b) => states.push(b));
  const first = run();
  void run();
  void run();
  assert.equal(calls, 1);
  release();
  await first;
  assert.deepEqual(states, [true, false]);
  const second = run();
  assert.equal(calls, 2, "usable again once the first call finished");
  release();
  await second;
});

test("singleFlight frees the guard when the action throws", async () => {
  let calls = 0;
  const run = singleFlight(async () => {
    calls++;
    throw new Error("boom");
  });
  await assert.rejects(run());
  await assert.rejects(run());
  assert.equal(calls, 2);
});
