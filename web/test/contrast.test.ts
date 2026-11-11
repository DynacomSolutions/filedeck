import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
// @ts-expect-error plain ES module shared with the browser checks
import { composite, contrastBetween, contrastRatio } from "./browser/contrast.mjs";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const accessibility = read("../src/accessibility.css");
const styles = read("../src/styles.css");
const columns = read("../src/columns.css");
const sidebar = read("../src/sidebar.css");
const theme = read("../public/assets/theme.css");

type Mode = "dark" | "light";
const DARK = ':root:not([data-theme="light"])';
const LIGHT = ':root[data-theme="light"]';

function block(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = css.match(new RegExp(`(?:^|\\n)\\s*${escaped}\\s*\\{([^}]*)\\}`));
  assert.ok(m, `selector ${selector} not found`);
  return m[1]!;
}
function token(css: string, selector: string, name: string): string {
  const m = block(css, selector).match(new RegExp(`${name}\\s*:\\s*([^;]+);`));
  assert.ok(m, `${name} not declared in ${selector}`);
  return m[1]!.trim();
}
const surfaces: Record<Mode, string[]> = {
  dark: ["--surface", "--surface-2", "--surface-3"].map((n) => token(theme, ":root", n)),
  light: ["--surface", "--surface-2", "--surface-3"].map((n) => token(theme, ':root[data-theme="light"]', n)),
};
const sel: Record<Mode, string> = { dark: DARK, light: LIGHT };
const fdLine = (mode: Mode) => styles.match(mode === "dark" ? /\n:root\{--fd-diff:[^}]*\}/ : /\n:root\[data-theme="light"\]\{--fd-diff:[^}]*\}/)![0];
const fd = (mode: Mode, name: string) => fdLine(mode).match(new RegExp(`${name}:(#[0-9a-f]{6})`))![1]!;

for (const mode of ["dark", "light"] as Mode[]) {
  test(`${mode}: control boundary and focus ring reach 3:1 on every surface`, () => {
    const boundary = token(accessibility, sel[mode], "--a11y-control-boundary");
    const ring = token(accessibility, sel[mode], "--focus-ring");
    for (const surface of surfaces[mode]) {
      assert.ok(contrastRatio(boundary, surface) >= 3, `boundary ${boundary} on ${surface}`);
      assert.ok(contrastRatio(ring, surface) >= 3, `ring ${ring} on ${surface}`);
    }
  });

  test(`${mode}: the selection mark reaches 3:1 against the selection fill on every surface`, () => {
    const mark = token(accessibility, sel[mode], "--sel-mark");
    const fill = token(accessibility, sel[mode], "--sel-bg");
    for (const surface of surfaces[mode]) {
      const filled = `#${composite(fill, surface).map((v: number) => Math.round(v).toString(16).padStart(2, "0")).join("")}`;
      assert.ok(contrastRatio(mark, filled) >= 3, `mark ${mark} on ${filled}`);
      assert.ok(contrastBetween(fill, surface, surface) < 3, "the fill alone stays subtle; the mark carries the state");
    }
  });

  test(`${mode}: compare status colours reach 4.5:1 on their own tints`, () => {
    for (const name of ["--fd-diff", "--fd-left", "--fd-right", "--fd-bad"]) {
      const colour = fd(mode, name);
      for (const surface of surfaces[mode].slice(0, 2)) {
        for (const alpha of [0.1, 0.12, 0.14]) {
          const [r, g, b] = [1, 3, 5].map((i) => parseInt(colour.slice(i, i + 2), 16));
          const tinted = `#${composite(`rgba(${r},${g},${b},${alpha})`, surface).map((v: number) => Math.round(v).toString(16).padStart(2, "0")).join("")}`;
          assert.ok(contrastRatio(colour, tinted) >= 4.5, `${name} ${colour} on ${tinted}`);
        }
      }
    }
  });
}

test("the light usage bar fill is drawn with the text accent, not the 2.6:1 brand blue", () => {
  assert.match(accessibility, /:root\[data-theme="light"\] \.side \.bar i\s*\{\s*background:\s*var\(--accent-text\)/);
  const fill = token(accessibility, LIGHT, "--sel-mark");
  assert.ok(contrastRatio(fill, surfaces.light[2]!) >= 3);
});

test("state is not carried by opacity or an undefined token", () => {
  assert.doesNotMatch(styles, /\.fd-tog\[aria-pressed=false\]\{[^}]*opacity/);
  assert.match(styles, /\.fd-tog\[aria-pressed=false\]\{[^}]*line-through/);
  assert.doesNotMatch(styles, /var\(--(?:ok|danger),#/);
  assert.match(styles, /\.pv-md a\{[^}]*text-decoration:underline/);
});

test("small controls have 24px targets", () => {
  assert.match(styles, /\.crumbs \.crumb-sep\{min-width:24px!important;width:24px/);
  assert.match(styles, /\.fp-grip\{[^}]*width:24px/);
  assert.match(columns, /\.colh-handle\{[^}]*width:24px/);
  assert.match(sidebar, /\.st-chev\{[^}]*width:24px;height:24px/);
  assert.match(styles, /\.fp \.sep\.horizontal\{width:24px/);
  assert.match(styles, /\.fp \.sep\.vertical\{height:24px/);
});

test("focus rings use the ring token, and forced colours get real outlines", () => {
  assert.match(theme, /:focus-visible \{ outline: 2px solid var\(--focus-ring, var\(--accent\)\)/);
  assert.match(styles, /outline: 2px solid var\(--focus-ring,var\(--accent\)\) !important/);
  assert.match(accessibility, /@media \(forced-colors: active\)[\s\S]*outline: 2px solid Highlight !important/);
  assert.match(accessibility, /@media \(forced-colors: active\)[\s\S]*\.ft tr\.sel[\s\S]*outline: 3px solid Highlight/);
});

test("text fields in dialogs keep a visible boundary", () => {
  assert.match(accessibility, /\.modal :is\(input, textarea\)[\s\S]*border: 1px solid var\(--a11y-control-boundary\)/);
});
