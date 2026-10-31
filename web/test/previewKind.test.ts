import assert from "node:assert/strict";
import { test } from "node:test";
import { extOf, looksLikeText, previewKind } from "../src/previewKind";

const enc = (s: string) => new TextEncoder().encode(s);

test("known extensions pick their viewer by name", () => {
  assert.equal(previewKind("notes.txt", 100), "text");
  assert.equal(previewKind("README.md", 100), "markdown");
  assert.equal(previewKind("data.json", 100), "text");
  assert.equal(previewKind("index.ts", 100), "text");
  assert.equal(previewKind("server.log", 100), "text");
  assert.equal(previewKind("photo.PNG", 100), "image");
  assert.equal(previewKind("doc.pdf", 100), "pdf");
  assert.equal(previewKind("bundle.tar.gz", 100), "archive");
  assert.equal(previewKind("clip.mp4", 100), "video");
  assert.equal(previewKind("song.mp3", 100), "audio");
});

test("a name without an extension is not mistaken for one", () => {
  assert.equal(extOf("pdf"), "");
  assert.equal(previewKind("pdf", 100), "unknown");
  assert.equal(previewKind("png", 100), "unknown");
  assert.equal(previewKind("md", 100), "unknown");
  assert.equal(previewKind("Makefile", 100), "text");
});

test("unknown or missing extensions need a byte sniff; an empty file is text", () => {
  assert.equal(previewKind("notes", 100), "unknown");
  assert.equal(previewKind("data.xyz", 100), "unknown");
  assert.equal(previewKind("notes", 0), "text");
});

test("sniff: text without NULs is text, including non-ASCII UTF-8", () => {
  assert.equal(looksLikeText(enc("plain text\nsecond line\n")), true);
  assert.equal(looksLikeText(enc("café – 日本語 😀")), true);
});

test("sniff: NUL bytes and invalid UTF-8 are binary", () => {
  assert.equal(looksLikeText(new Uint8Array([0x68, 0x69, 0x00, 0x21])), false);
  assert.equal(looksLikeText(new Uint8Array([0xff, 0xfe, 0x41])), false);
  assert.equal(looksLikeText(Uint8Array.from({ length: 256 }, (_, i) => i)), false);
  // PNG signature: 0x89 is not valid UTF-8.
  assert.equal(looksLikeText(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), false);
});

test("sniff: a character cut by the end of the sample still counts as text", () => {
  const whole = enc("ab日");
  const cut = whole.subarray(0, whole.length - 1);
  assert.equal(looksLikeText(cut), false);
  assert.equal(looksLikeText(cut, true), true);
  // A genuinely invalid byte before the end is still binary when truncated.
  assert.equal(looksLikeText(new Uint8Array([0x61, 0xff, 0x62]), true), false);
});
