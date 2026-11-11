import assert from "node:assert/strict";
import test from "node:test";
import { clearDraft, draftCount, getDraft, joinBom, plainNameError, setDraft, splitBom, syncDraft } from "../src/editDrafts.ts";

test("unsaved text is held while it differs from the saved text and dropped when it matches", () => {
  syncDraft("n", "/a.txt", "typed", "saved", "e1");
  assert.deepEqual(getDraft("n", "/a.txt"), { text: "typed", etag: "e1" });
  syncDraft("n", "/a.txt", "saved", "saved", "e1");
  assert.equal(getDraft("n", "/a.txt"), undefined);
});

test("drafts are per node and path, so another file or node never gets them", () => {
  setDraft("n", "/a.txt", { text: "x", etag: "1" });
  assert.equal(getDraft("n", "/b.txt"), undefined);
  assert.equal(getDraft("m", "/a.txt"), undefined);
  assert.equal(draftCount(), 1);
  clearDraft("n", "/a.txt");
  assert.equal(draftCount(), 0);
});

test("a byte-order mark is split off for editing and put back on save", () => {
  assert.deepEqual(splitBom("﻿hello"), { bom: true, text: "hello" });
  assert.deepEqual(splitBom("hello"), { bom: false, text: "hello" });
  assert.equal(joinBom(true, "hello"), "﻿hello");
  assert.equal(joinBom(false, "hello"), "hello");
  const { bom, text } = splitBom("﻿a\r\nb\n");
  assert.equal(joinBom(bom, text), "﻿a\r\nb\n");
});

test("a typed name must be one plain path segment", () => {
  for (const bad of ["", ".", "..", "a/b", "/abs", "../x", "a\0b"]) assert.notEqual(plainNameError(bad), "", JSON.stringify(bad));
  for (const ok of ["a", "a.b", "...", ".hidden", "a b"]) assert.equal(plainNameError(ok), "", ok);
});
