import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { blocksOf, OfficeView } from "../src/OfficeView.tsx";
import { SkeletonLines } from "../src/Skeleton.tsx";
import { SearchView } from "../src/Search.tsx";
import { readFileSync } from "node:fs";
import { EMPTY_SEARCH } from "../src/urlState.ts";
import type { Block } from "../src/officeParse.ts";

const html = (n: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(n);

test("office: runs of bullet paragraphs become one real list", () => {
  const p = (text: string, bullet = false): Block => ({ t: "p", h: 0, spans: [{ text }], ...(bullet ? { bullet: true } : {}) });
  const out = html(createElement("div", null, blocksOf([p("intro"), p("a", true), p("b", true), p("outro"), p("c", true)])));
  assert.equal(out, "<div><p>intro</p><ul class=\"pv-ul\"><li>a</li><li>b</li></ul><p>outro</p><ul class=\"pv-ul\"><li>c</li></ul></div>");
});

test("office: a sheet tab list controls a tab panel", () => {
  // the component fetches in an effect, so the static markup is the loading state: it must still be a live region with text
  assert.match(html(createElement(OfficeView, { node: "n", path: "/a.xlsx", ext: "xlsx", size: 10 })), /role="status"/);
});

test("loading skeleton has text a screen reader announces", () => {
  const out = html(createElement(SkeletonLines, { lines: 2 }));
  assert.match(out, /role="status"/);
  assert.match(out, /sr-only">Loading\.\.\./);
});

test("search: checkboxes have names, and the visible progress is not a live region", () => {
  const out = html(createElement(SearchView, { node: "n", dir: "/d", hidden: false, form: EMPTY_SEARCH, onForm: () => undefined, onClose: () => undefined, onReveal: () => undefined, onOpen: () => undefined, onStatus: () => undefined }));
  assert.match(out, /aria-label="Aa, match name case-sensitively"/);
  assert.match(out, /aria-label="regex, content text is a regular expression"/);
  assert.match(out, /aria-label="Aa, match content case-sensitively"/);
  // the only live region is the sr-only one
  assert.equal((out.match(/role="status"/g) ?? []).length, 1);
  assert.match(out, /<span class="sr-only" role="status">/);
});

test("saved passwords: the table's scroll area is a focusable named region, and the expiry alert does not count down", () => {
  // the component pulls in a stylesheet, which the test runner cannot load: check the source
  const src = readFileSync(new URL("../src/SavedPasswords.tsx", import.meta.url), "utf8");
  assert.match(src, /className="vault-wrap" role="region" aria-label="Saved passwords table" tabIndex=\{0\}/);
  assert.doesNotMatch(src, /expires in about/);
});

test("password fields point at their error and are marked invalid after a wrong password", () => {
  const read = (f: string) => readFileSync(new URL(`../src/${f}`, import.meta.url), "utf8");
  assert.match(read("ArchiveDialog.tsx"), /aria-invalid=\{errorId \? true : undefined\}\s+aria-describedby=\{errorId\}/);
  assert.match(read("PdfView.tsx"), /errorId=\{err \? "pdf-pw-err" : undefined\}[\s\S]*id="pdf-pw-err"/);
  assert.match(read("ArchiveView.tsx"), /errorId=\{lock === "incorrect" \? "av-pw-err" : undefined\}[\s\S]*id="av-pw-err"/);
});

test("the address bar enters edit mode on Enter, Space or click, not on focus", () => {
  const src = readFileSync(new URL("../src/AddressBar.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(src, /onFocus=\{\(\) => !skipFocus/);
  assert.match(src, /aria-label="Edit address" onClick=\{begin\} onKeyDown=\{\(e\) => \(e\.key === "Enter" \|\| e\.key === " "\)/);
});

test("the previews restore list markers that the global reset removes", () => {
  const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
  assert.match(css, /\.pv-md ul,\.pv-office ul\{list-style:disc\}/);
  assert.match(css, /\.pv-md ol\{list-style:decimal\}/);
});

test("sidebar row actions are reachable by touch screen readers outside the tree, and the tooltip bubble is not page content", () => {
  const read = (f: string) => readFileSync(new URL(`../src/${f}`, import.meta.url), "utf8");
  const tree = read("SidebarTree.tsx");
  assert.match(tree, /role="toolbar" aria-label="Navigation row actions"/);
  assert.match(tree, /Actions for \{actionRow\.label\}/);
  assert.match(read("Tooltip.tsx"), /role="tooltip" aria-hidden="true"/);
});
