import assert from "node:assert/strict";
import test from "node:test";
import { repeatCount, rowIndex, MAX_ROWS } from "../src/officeParse.ts";

test("rowIndex: a sheet row number is trusted only when it is a sane number", () => {
  assert.equal(rowIndex("3", 0), 2);
  assert.equal(rowIndex(null, 7), 7);
  assert.equal(rowIndex("abc", 7), 7);
  assert.equal(rowIndex("0", 7), 7);
  assert.equal(rowIndex("-4", 7), 7);
  assert.equal(rowIndex("Infinity", 7), 7);
  // a huge row number stays huge here: the parser compares it with MAX_ROWS and stops, never allocating that many rows
  assert.ok(rowIndex("4000000000", 0) >= MAX_ROWS);
});

test("repeatCount: counts from a document are clamped", () => {
  assert.equal(repeatCount(null, 5), 1);
  assert.equal(repeatCount("3", 5), 3);
  assert.equal(repeatCount("1048576", 5), 5);
  assert.equal(repeatCount("Infinity", 200), 200);
  assert.equal(repeatCount("abc", 5), 1);
  assert.equal(repeatCount("-2", 5), 1);
  assert.equal(repeatCount("0", 5), 1);
  assert.equal(repeatCount("2.9", 5), 2);
});
