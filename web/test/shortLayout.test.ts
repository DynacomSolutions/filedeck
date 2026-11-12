import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const css = readFileSync(new URL("../src/phone.css", import.meta.url), "utf8");
const panel = readFileSync(new URL("../src/FilePanel.tsx", import.meta.url), "utf8");

test("a short, narrow window collapses the panel toolbar into one 44 px row so the list keeps its rows", () => {
  const block = css.match(/@media\(max-height:500px\) and \(max-width:1000px\)\{([^@]*?\.fp>\.fp-bar\{[^}]*\}[^@]*?)\}\s*(?=@media|$)/s)?.[1] ?? "";
  assert.match(block, /\.fp>\.fp-bar\{height:44px;flex-direction:row;[^}]*overflow-x:auto/);
  assert.match(block, /\.fp>\.fp-bar>\.fp-row\{[^}]*height:44px;[^}]*flex-wrap:nowrap/);
});

test("the top bar and page padding are tighter in a short window", () => {
  assert.match(css, /\.site-header__inner\{height:36px\}/);
  assert.match(css, /\.main\{padding:\.15rem\}/);
});

test("the panel header keeps the .fp > .fp-bar structure the short-window rules select, and the list stays directly under the group", () => {
  assert.match(panel, /<header\s+ref=\{barRef\}\s+className="fp-bar"/);
  assert.match(panel, /<div className="fp-row">/);
  // windowing must not add rendered chrome around the list: only spacers inside it
  assert.doesNotMatch(panel, /className="fp-window"/);
});
