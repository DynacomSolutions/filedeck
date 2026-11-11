import assert from "node:assert/strict";
import test from "node:test";
import { errorText, isChunkError, keysChanged } from "../src/errorText.ts";

test("errorText gives one non-empty line", () => {
  assert.equal(errorText(new Error("boom\n    at x")), "boom");
  assert.equal(errorText("plain"), "plain");
  assert.equal(errorText(undefined), "Unknown error");
  assert.equal(errorText(new Error("")), "Unknown error");
  assert.equal(errorText(new Error("x".repeat(1000))).length, 300);
});

test("isChunkError recognises a stale lazy chunk", () => {
  assert.equal(isChunkError(new TypeError("Failed to fetch dynamically imported module: /assets/a-1.js")), true);
  assert.equal(isChunkError(new TypeError("error loading dynamically imported module")), true);
  assert.equal(isChunkError(new Error("Cannot read properties of undefined")), false);
});

test("keysChanged compares reset keys by value", () => {
  assert.equal(keysChanged(["a", "/x"], ["a", "/x"]), false);
  assert.equal(keysChanged(["a", "/x"], ["a", "/y"]), true);
  assert.equal(keysChanged(undefined, []), false);
  assert.equal(keysChanged([1], [1, 2]), true);
});
