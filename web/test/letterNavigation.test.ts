import assert from "node:assert/strict";
import test from "node:test";
import { nextLetterMatch } from "../src/letterNavigation.ts";

const files = [
  { name: "Alpha.txt", path: "/Alpha.txt" },
  { name: "amber.txt", path: "/amber.txt" },
  { name: "Beta.txt", path: "/Beta.txt" },
  { name: "Aardvark.txt", path: "/Aardvark.txt" },
];

test("letter navigation is case-insensitive, advances from the current item, and wraps", () => {
  assert.equal(nextLetterMatch(files, null, "a")?.path, "/Alpha.txt");
  assert.equal(nextLetterMatch(files, "/Alpha.txt", "A")?.path, "/amber.txt", "uppercase input should advance without range-selection semantics");
  assert.equal(nextLetterMatch(files, "/amber.txt", "a")?.path, "/Aardvark.txt");
  assert.equal(nextLetterMatch(files, "/Aardvark.txt", "a")?.path, "/Alpha.txt", "the last match should wrap to the first");
});

test("letter navigation leaves selection stable when there is no match or key is not one letter", () => {
  assert.equal(nextLetterMatch(files, "/Beta.txt", "z"), null);
  assert.equal(nextLetterMatch(files, "/Beta.txt", "ArrowDown"), null);
  assert.equal(nextLetterMatch(files, "/Beta.txt", "1"), null);
});
