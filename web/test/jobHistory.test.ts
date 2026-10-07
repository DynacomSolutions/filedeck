import assert from "node:assert/strict";
import test from "node:test";
import { HISTORY_MAX, LINGER_ATTENTION_MS, LINGER_MS, addToHistory, nextExpiry, parseHistory, shouldAutoCollapse, stillLingering, type HistoryEntry } from "../src/jobHistory.ts";

const e = (key: string, at: number, extra: Partial<HistoryEntry> = {}): HistoryEntry => ({ key, title: key, outcome: "done", at, ...extra });

test("history is newest first, deduplicated and capped", () => {
  let h = addToHistory([], [e("a", 1), e("b", 3)]);
  assert.deepEqual(h.map((x) => x.key), ["b", "a"]);
  h = addToHistory(h, [e("a", 99), e("c", 2), e("c", 2)]);
  assert.deepEqual(h.map((x) => x.key), ["b", "c", "a"]);
  assert.equal(addToHistory(h, [e("a", 5)]), h); // nothing new: same reference, no re-render or write
  const big = addToHistory([], Array.from({ length: HISTORY_MAX + 20 }, (_, i) => e("k" + i, i)));
  assert.equal(big.length, HISTORY_MAX);
  assert.equal(big[0]!.key, "k" + (HISTORY_MAX + 19));
});

test("finished jobs linger briefly, longer when they need attention", () => {
  assert.equal(stillLingering(1000, 1000 + LINGER_MS - 1, false), true);
  assert.equal(stillLingering(1000, 1000 + LINGER_MS, false), false);
  assert.equal(stillLingering(1000, 1000 + LINGER_MS, true), true);
  assert.equal(stillLingering(1000, 1000 + LINGER_ATTENTION_MS, true), false);
});

test("nextExpiry finds the soonest departure", () => {
  assert.equal(nextExpiry([], 0), null);
  assert.equal(nextExpiry([{ at: 0, attention: false }], LINGER_MS), null);
  assert.equal(nextExpiry([{ at: 0, attention: true }, { at: 2000, attention: false }], 3000), LINGER_MS - 1000);
});

test("auto-collapse only after the idle delay", () => {
  assert.equal(shouldAutoCollapse(null, 1e9), false);
  assert.equal(shouldAutoCollapse(1000, 1000 + 14999), false);
  assert.equal(shouldAutoCollapse(1000, 1000 + 15000), true);
  assert.equal(shouldAutoCollapse(1000, 1500, 500), true);
});

test("parseHistory drops malformed entries", () => {
  assert.deepEqual(parseHistory("garbage"), []);
  assert.deepEqual(parseHistory(null), []);
  const raw = JSON.stringify([e("ok", 1, { where: "n1", detail: "x" }), { key: 1 }, { key: "k", title: "t", at: 1, outcome: "weird" }, null]);
  const p = parseHistory(raw);
  assert.equal(p.length, 1);
  assert.equal(p[0]!.where, "n1");
});
