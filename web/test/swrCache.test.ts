import assert from "node:assert/strict";
import test from "node:test";
import { MAX_PERSIST_BYTES, cacheOwner, isPersistKey, parsePersisted, serialisePersisted } from "../src/swrCache.ts";
import { listState } from "../src/sidebarState.ts";

const A = "virt:alice";
const saved = (owner: unknown, entries: unknown) => JSON.stringify({ owner, entries });

test("parsePersisted survives corrupt or hostile storage", () => {
  for (const raw of [null, "", "{", "null", "42", '{"a":1}', "[1,2]", saved(A, null), saved(A, [["nodes"]]), saved(A, [["nodes", null]]), saved(A, [["dirs", { data: [] }]]), "x".repeat(MAX_PERSIST_BYTES + 1)]) assert.deepEqual(parsePersisted(raw, A), []);
});

test("parsePersisted keeps only allow-listed object entries", () => {
  const raw = saved(A, [["nodes", { data: [{ name: "a" }] }], ["dirs", { data: [] }], ["mounts", { data: [] }]]);
  assert.deepEqual(parsePersisted(raw, A), [["nodes", { data: [{ name: "a" }] }]]);
});

test("the saved cache belongs to one account: another account, sign-in off, or a list saved before accounts get nothing", () => {
  const raw = saved(A, [["nodes", { data: [{ name: "a", roots: ["/srv/a"] }] }]]);
  assert.deepEqual(parsePersisted(raw, A), [["nodes", { data: [{ name: "a", roots: ["/srv/a"] }] }]]);
  assert.deepEqual(parsePersisted(raw, "virt:bob"), []);
  assert.deepEqual(parsePersisted(raw, "sys:alice"), []);
  assert.deepEqual(parsePersisted(raw, "anon"), []);
  // the format before accounts: a bare list of entries, with no owner
  assert.deepEqual(parsePersisted(JSON.stringify([["nodes", { data: [{ name: "a" }] }]]), A), []);
  assert.deepEqual(parsePersisted(saved(undefined, [["nodes", { data: [] }]]), "anon"), []);
});

test("cacheOwner: kind and name when signed in, anon with sign-in off", () => {
  assert.equal(cacheOwner({ auth: false }), "anon");
  assert.equal(cacheOwner({ auth: true, kind: "virt", name: "alice" }), "virt:alice");
  assert.equal(cacheOwner({ auth: true, kind: "sys", name: "alice" }), "sys:alice");
});

test("serialisePersisted round-trips with its owner, drops errors, state and file listings", () => {
  const cache = new Map<string, unknown>([
    ["nodes", { data: [{ name: "a" }], error: new Error("x"), isValidating: true }],
    ["dirs", { data: [1] }],
  ]);
  const s = serialisePersisted(cache, A)!;
  assert.deepEqual(parsePersisted(s, A), [["nodes", { data: [{ name: "a" }] }]]);
  assert.deepEqual(parsePersisted(s, "anon"), []);
  assert.ok(!s.includes("isValidating"));
});

test("serialisePersisted returns null for nothing, errors-only or oversized data", () => {
  assert.equal(serialisePersisted(new Map(), A), null);
  assert.equal(serialisePersisted(new Map([["nodes", { error: new Error("x") }]]), A), null);
  assert.equal(serialisePersisted(new Map([["nodes", { data: ["y".repeat(MAX_PERSIST_BYTES)] }]]), A), null);
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
