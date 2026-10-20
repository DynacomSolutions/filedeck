import { test } from "node:test";
import assert from "node:assert/strict";
import { backoff, classify, gaveUp, GIVE_UP_MS } from "../src/jobPoll.ts";

const http = (status: number) => Object.assign(new Error("x"), { status });

test("backoff: 400 ms, 1 s, 2 s, then 5 s", () => {
  assert.deepEqual([1, 2, 3, 4, 5, 50].map(backoff), [400, 1000, 2000, 5000, 5000, 5000]);
});

test("classify: network and gateway errors are unreachable, 404 is gone", () => {
  assert.equal(classify(new TypeError("Failed to fetch")), "unreachable");
  for (const s of [499, 502, 503, 504]) assert.equal(classify(http(s)), "unreachable");
  assert.equal(classify(http(404)), "gone");
  assert.equal(classify(http(400)), "other");
  assert.equal(classify(http(500)), "other");
  assert.equal(classify(new Error("boom")), "other");
  assert.equal(classify(null), "other");
});

test("gaveUp: after five minutes", () => {
  assert.equal(gaveUp(1000, 1000 + GIVE_UP_MS - 1), false);
  assert.equal(gaveUp(1000, 1000 + GIVE_UP_MS), true);
});
