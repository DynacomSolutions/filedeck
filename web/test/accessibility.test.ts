import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const accessibility = readFileSync(new URL("../src/accessibility.css", import.meta.url), "utf8");
const styles = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
const filePanel = readFileSync(new URL("../src/FilePanel.tsx", import.meta.url), "utf8");
const addressBar = readFileSync(new URL("../src/AddressBar.tsx", import.meta.url), "utf8");
const theme = readFileSync(new URL("../public/assets/theme.css", import.meta.url), "utf8");

function declaration(css: string, selector: string, name: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const block = css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`))?.[1];
  const value = block?.match(new RegExp(`(?:^|;)\\s*${name}\\s*:\\s*([^;]+)`))?.[1]?.trim();
  assert.ok(value, `expected ${name} declaration for ${selector}`);
  return value;
}

function luminance(hex: string): number {
  const channels = hex.slice(1).match(/.{2}/g)!.map((part) => parseInt(part, 16) / 255);
  const linear = channels.map((v) => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  return 0.2126 * linear[0]! + 0.7152 * linear[1]! + 0.0722 * linear[2]!;
}

function contrast(foreground: string, background: string): number {
  const a = luminance(foreground);
  const b = luminance(background);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

test("dark AAA muted token wins over the dark-theme legacy override", () => {
  const darkSelector = ':root:not([data-theme="light"])';
  assert.match(styles, /:root:not\(\[data-theme="light"\]\)\s*\{[^}]*--muted:\s*#8c8c8c/s);
  assert.equal(declaration(accessibility, darkSelector, "--muted"), "#b8b8c2");

  const backgrounds = [
    declaration(theme, ":root", "--surface"),
    declaration(theme, ":root", "--surface-2"),
    declaration(theme, ":root", "--surface-3"),
  ];
  for (const background of backgrounds) {
    assert.ok(contrast("#b8b8c2", background) >= 7, `muted text must reach 7:1 on ${background}`);
  }
});

test("address edit target keeps its 44px minimum when breadcrumbs shrink", () => {
  assert.match(styles, /\.addr>\.tip:has\(\.addr-fill\)\{[^}]*min-width:44px/);
  assert.match(styles, /\.addr-fill\{[^}]*flex:1 1 44px;min-width:44px/);
});

test("narrow panel header wraps pane actions while keeping navigation and address targets visible", () => {
  assert.match(styles, /@media\(max-width:360px\)\{\.fp-bar\{height:132px\}\.fp-row\{height:88px;flex-wrap:wrap;align-content:flex-start\}\.fp-row \.addr\{min-width:88px\}\}/);
  for (const label of ["Back", "Forward", "Up one folder"]) {
    assert.ok(filePanel.includes(`aria-label="${label}"`), `${label} remains rendered at narrow widths`);
  }
  assert.ok(filePanel.includes('label: "Split right"'), "Split right remains rendered at narrow widths");
  assert.ok(addressBar.includes('aria-label="Recent locations"'), "Recent locations remains rendered at narrow widths");
  assert.match(styles, /\.fp-up, \.fp-actions button,[\s\S]*?min-width: 44px !important/);
  assert.match(styles, /\.addr-recent,[\s\S]*?min-width: 44px !important/);
});
