import assert from "node:assert/strict";
import test from "node:test";
import { clearDraft, detectEol, draftCount, eolNotice, getDraft, joinBom, plainNameError, setDraft, splitBom, syncDraft } from "../src/editDrafts.ts";

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

test("line endings: counts each kind of line break", () => {
  assert.deepEqual(
    { ...detectEol("a\r\nb\nc\rd\n") },
    { crlf: 1, lf: 2, cr: 1, mixed: true, written: "LF" },
  );
});
test("line endings: leaves a file with one kind of line ending alone", () => {
  assert.equal(detectEol("a\r\nb\r\nc\r\n").mixed, false);
  assert.equal(detectEol("a\nb\nc\n").mixed, false);
  assert.equal(detectEol("no line break").mixed, false);
  assert.equal(detectEol("").mixed, false);
  assert.equal(eolNotice(detectEol("a\r\nb\r\n")), "");
  assert.equal(eolNotice(detectEol("a\nb\n")), "");
});
test("line endings: finds a mix and names what a save writes (measured with Monaco in a browser)", () => {
  assert.equal(detectEol("a\r\nb\r\nc\nd\r\ne\n").written, "CRLF"); // more CRLF than LF
  assert.equal(detectEol("a\nb\nc\r\nd\ne\r\n").written, "LF"); // more LF than CRLF
  assert.equal(detectEol("a\r\nb\nc\r\nd\n").written, "LF"); // equal counts
  assert.equal(detectEol("a\r\nb\nc\rd\n").written, "LF");
  assert.equal(detectEol("a\r\nb\nc\r\nd\n").mixed, true);
});
test("line endings: treats a lone CR as a mix, and Monaco writes CRLF for a file made of lone CR", () => {
  const cr = detectEol("a\rb\rc\r");
  assert.equal(cr.mixed, true);
  assert.equal(cr.written, "CRLF");
  assert.equal(eolNotice(cr), "This file uses old Mac (CR) line endings. A save changes all of them to CRLF.");
});
test("line endings: words the notice with the ending the model reports", () => {
  const info = detectEol("a\r\nb\r\nc\nd\r\ne\n");
  assert.equal(eolNotice(info), "This file mixes Windows (CRLF) and Unix (LF) line endings. A save changes all of them to CRLF.");
  assert.equal(eolNotice(info, "LF"), "This file mixes Windows (CRLF) and Unix (LF) line endings. A save changes all of them to LF.");
});
