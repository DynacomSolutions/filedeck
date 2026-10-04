import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Contributor rule: every action is a real button (icon + label, standard button
// style), never a link-styled element. Anchors are for real navigation only, or
// for downloads rendered with the button look (`className="btn-a"`).
const SRC = join(import.meta.dirname, "../../web/src");
const read = (n: string) => readFileSync(join(SRC, n), "utf8");
const tsx = readdirSync(SRC).filter((n) => n.endsWith(".tsx"));
const css = readdirSync(SRC).filter((n) => n.endsWith(".css"));

test("no anchor renders an action unless it is a button-styled download or marked data-nav", () => {
  const bad: string[] = [];
  for (const n of tsx) {
    const src = read(n);
    for (const m of src.matchAll(/<a(\s[^>]*)?>/g)) {
      const tag = m[1] ?? "";
      const nav = /data-nav\b/.test(tag);
      const btn = /className="btn-a"/.test(tag) && /role="button"/.test(tag) && /\bdownload\b/.test(tag);
      if (!nav && !btn) bad.push(`${n}: <a${tag.slice(0, 60)}`);
    }
  }
  assert.deepEqual(bad, [], "use <button> (or the btn-a download button); see Contributing in README");
});

test("no link-styled buttons: no className=\"link\" and no underline or link-coloured button rules", () => {
  const bad: string[] = [];
  for (const n of tsx) {
    for (const m of read(n).matchAll(/className=\{?["'`][^"'`]*\blink\b[^"'`]*["'`]/g)) bad.push(`${n}: ${m[0]}`);
  }
  for (const n of css) {
    for (const rule of read(n).matchAll(/([^{}]+)\{([^}]*)\}/g)) {
      const sel = rule[1]!.trim();
      const body = rule[2]!;
      if (/text-decoration\s*:\s*underline/.test(body) && !/^\.pv-md a\b/.test(sel)) bad.push(`${n}: ${sel} underlines`);
      if (/(^|,)\s*(button)?\.link\b/.test(sel)) bad.push(`${n}: ${sel}`);
    }
  }
  assert.deepEqual(bad, []);
});

test("the button-styled download anchor shares the standard button metrics", () => {
  const css0 = read("styles.css");
  assert.match(css0, /a\.btn-a\{[^}]*border-radius:var\(--radius-btn\)/);
  assert.match(css0, /a\.btn-a\{[^}]*text-decoration:none/);
});
