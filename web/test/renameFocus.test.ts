import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const filePanel = readFileSync(new URL("../src/FilePanel.tsx", import.meta.url), "utf8");
const styles = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");

test("rename input is an uncropped overlay that can extend over the other columns", () => {
  assert.match(filePanel, /className="rn-input"/);
  assert.match(filePanel, /"name" \+ \(renaming === en\.path \? " renaming" : ""\)/);
  const cell = styles.match(/\.ft td\.name\.renaming\s*\{([^}]*)\}/)?.[1] ?? "";
  assert.match(cell, /overflow:\s*visible/);
  assert.match(cell, /position:\s*relative/);
  assert.match(cell, /z-index:\s*\d+/);
  const input = styles.match(/\.ft td\.name \.rn-input\s*\{([^}]*)\}/)?.[1] ?? "";
  assert.match(input, /position:\s*absolute/);
  assert.match(input, /overflow-wrap:\s*anywhere/);
  assert.match(input, /white-space:\s*pre-wrap/);
  assert.match(input, /min-width:\s*12rem/);
  assert.doesNotMatch(input, /ellipsis/);
});

test("rename editor is a wrapping textarea that never takes newlines, in the grid too", () => {
  assert.match(filePanel, /<textarea\s+className="rn-input"/);
  assert.match(filePanel, /replace\(\/\[\\r\\n\]\+\/g, ""\)/);
  assert.match(filePanel, /className="tile-name renaming"/);
  assert.match(styles, /\.tile-name \.rn-input\s*\{[^}]*white-space:\s*pre-wrap/);
});

test("rename input selects the name stem without the extension", () => {
  assert.match(filePanel, /setSelectionRange\(0, dot > 0 && en\.type !== "dir" \? dot : en\.name\.length\)/);
});
