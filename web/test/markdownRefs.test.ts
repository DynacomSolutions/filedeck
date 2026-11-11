import assert from "node:assert/strict";
import test from "node:test";
import { isRemoteRef, MD_FORBID_ATTR, MD_FORBID_TAGS } from "../src/MarkdownView.tsx";

test("markdown: addresses that make the browser fetch on render are recognised", () => {
  for (const v of ["http://x.example/a.png", "HTTPS://x.example", "//x.example/a", "  //x.example", "data:image/png;base64,AAAA", "javascript:alert(1)"]) assert.equal(isRemoteRef(v), true, v);
  for (const v of ["a.png", "./a.png", "../a/b.png", "/docs/a.png", "#top", "", "http-notes.md"]) assert.equal(isRemoteRef(v), false, v);
});

test("markdown: media tags and background attributes are forbidden", () => {
  for (const t of ["video", "audio", "source", "track", "picture", "link", "svg"]) assert.ok(MD_FORBID_TAGS.includes(t), t);
  for (const a of ["background", "poster", "srcset", "style"]) assert.ok(MD_FORBID_ATTR.includes(a), a);
  assert.ok(!MD_FORBID_TAGS.includes("input"), "task list checkboxes stay");
});
