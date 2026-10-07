import assert from "node:assert/strict";
import test from "node:test";
import { MAX_PERSIST_BYTES, isPersistKey, parsePersisted, serialisePersisted } from "../src/swrCache.ts";
import { listState } from "../src/sidebarState.ts";

test("parsePersisted survives corrupt or hostile storage", () => {
  for (const raw of [null, "", "{", "null", "42", '{"a":1}', "[1,2]", '[["nodes"]]', '[["nodes",null]]', '[["dirs",{"data":[]}]]', "x".repeat(MAX_PERSIST_BYTES + 1)]) assert.deepEqual(parsePersisted(raw), []);
});

test("parsePersisted keeps only allow-listed object entries", () => {
  const raw = JSON.stringify([["nodes", { data: [{ name: "a" }] }], ["dirs", { data: [] }], ["mounts", { data: [] }]]);
  assert.deepEqual(parsePersisted(raw), [["nodes", { data: [{ name: "a" }] }]]);
});

test("serialisePersisted round-trips, drops errors, state and file listings", () => {
  const cache = new Map<string, unknown>([
    ["nodes", { data: [{ name: "a" }], error: new Error("x"), isValidating: true }],
    ["dirs", { data: [1] }],
  ]);
  const s = serialisePersisted(cache)!;
  assert.deepEqual(parsePersisted(s), [["nodes", { data: [{ name: "a" }] }]]);
  assert.ok(!s.includes("isValidating"));
});

test("serialisePersisted returns null for nothing, errors-only or oversized data", () => {
  assert.equal(serialisePersisted(new Map()), null);
  assert.equal(serialisePersisted(new Map([["nodes", { error: new Error("x") }]])), null);
  assert.equal(serialisePersisted(new Map([["nodes", { data: ["y".repeat(MAX_PERSIST_BYTES)] }]])), null);
  assert.equal(isPersistKey("dirs"), false);
  assert.equal(isPersistKey(["nodes"]), false);
});

test("listState: loading until a request has finished", () => {
  assert.equal(listState({ data: undefined, error: undefined, isLoading: true }), "loading");
  assert.equal(listState({ data: undefined, error: undefined, isLoading: false }), "loading");
});

test("listState: empty only after a successful load with zero items", () => {
  assert.equal(listState({ data: [], error: undefined, isLoading: false }), "empty");
  assert.equal(listState({ data: [], error: new Error("x"), isLoading: true }), "empty");
});

test("listState: error without data, cached data wins over a failed refresh", () => {
  assert.equal(listState({ data: undefined, error: new Error("x"), isLoading: false }), "error");
  assert.equal(listState({ data: [1], error: new Error("x"), isLoading: false }), "ready");
  assert.equal(listState({ data: [1], error: undefined, isLoading: true }), "ready");
});
