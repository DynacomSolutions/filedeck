import assert from "node:assert/strict";
import test from "node:test";
import { TYPEAHEAD_TIMEOUT_MS, typeAheadMatch, type TypeAheadState } from "../src/letterNavigation.ts";

const files = [
  { name: "Alpha.txt", path: "/Alpha.txt" },
  { name: "amber.txt", path: "/amber.txt" },
  { name: "Beta.txt", path: "/Beta.txt" },
  { name: "Aardvark.txt", path: "/Aardvark.txt" },
  { name: "hello.txt", path: "/hello.txt" },
  { name: "help.txt", path: "/help.txt" },
  { name: "2024-notes.txt", path: "/2024-notes.txt" },
  { name: "file.a", path: "/file.a" },
];
const type = (cur: string | null, key: string, prev: TypeAheadState | null, now: number) => typeAheadMatch(files, cur, key, prev, now);

test("single letter is case-insensitive, advances from the current item, and wraps", () => {
  assert.equal(type(null, "a", null, 0)?.match?.path, "/Alpha.txt");
  assert.equal(type("/Alpha.txt", "A", null, 0)?.match?.path, "/amber.txt");
  assert.equal(type("/amber.txt", "a", null, 0)?.match?.path, "/Aardvark.txt");
  assert.equal(type("/Aardvark.txt", "a", null, 0)?.match?.path, "/Alpha.txt");
});

test("unusable keys return null; digits start a search", () => {
  assert.equal(type("/Beta.txt", "ArrowDown", null, 0), null);
  assert.equal(type("/Beta.txt", " ", null, 0), null);
  assert.equal(type("/Beta.txt", ".", null, 0), null);
  assert.equal(type("/Beta.txt", "2", null, 0)?.match?.path, "/2024-notes.txt");
});

test("multi-char prefix keeps the current item (inclusive start)", () => {
  const h = type("/Beta.txt", "h", null, 0)!;
  assert.equal(h.match?.path, "/hello.txt");
  const he = type("/hello.txt", "e", h.state, 100)!;
  assert.equal(he.match?.path, "/hello.txt");
  const hel = type("/hello.txt", "l", he.state, 200)!;
  assert.equal(hel.match?.path, "/hello.txt");
  assert.equal(type("/hello.txt", "p", hel.state, 300)?.match?.path, "/help.txt");
});

test("repeated letter without a matching prefix cycles", () => {
  const a = type("/Beta.txt", "a", null, 0)!;
  assert.equal(a.match?.path, "/Aardvark.txt");
  const aa = type("/Aardvark.txt", "a", a.state, 100)!;
  assert.equal(aa.match?.path, "/Aardvark.txt", "Aardvark really starts with aa");
  const aaa = type("/Aardvark.txt", "a", aa.state, 200)!;
  assert.equal(aaa.match?.path, "/Alpha.txt", "no aaa*: advance to the next a*");
});

test("no match returns null match, keeps the buffer and consumes the key", () => {
  const h = type("/hello.txt", "h", null, 0)!;
  const bad = type("/hello.txt", "z", h.state, 100)!;
  assert.equal(bad.match, null);
  assert.equal(bad.continued, true);
  assert.equal(bad.state.buffer, "hz");
});

test("punctuation and space continue a live buffer", () => {
  const f = type(null, "f", null, 0)!;
  const fi = type("/file.a", "i", f.state, 10)!;
  const file = type("/file.a", "e", type("/file.a", "l", fi.state, 20)!.state, 30)!;
  assert.equal(type("/file.a", ".", file.state, 40)?.match?.path, "/file.a");
  assert.equal(type("/file.a", " ", file.state, 40)?.continued, true);
});

test("buffer resets after the timeout", () => {
  const h = type("/Beta.txt", "h", null, 0)!;
  const late = type("/hello.txt", "e", h.state, TYPEAHEAD_TIMEOUT_MS + 1)!;
  assert.equal(late.state.buffer, "e");
  assert.equal(late.continued, false);
  assert.equal(type("/hello.txt", "e", h.state, TYPEAHEAD_TIMEOUT_MS)?.state.buffer, "he");
});
