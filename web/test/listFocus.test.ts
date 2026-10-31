import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const filePanel = readFileSync(new URL("../src/FilePanel.tsx", import.meta.url), "utf8");

test("a primary-button release in the column header returns focus to the file list", () => {
  assert.match(filePanel, /<thead\s+onPointerUp=\{\(e\) => \{[\s\S]*?e\.button === 0\) listRef\.current\?\.focus\(\{ preventScroll: true \}\)/);
  assert.match(filePanel, /ref=\{listRef\}\s+className="fp-scroll"\s+tabIndex=\{0\}/);
});
