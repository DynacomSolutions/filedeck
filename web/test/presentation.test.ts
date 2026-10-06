import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { cssColourToHex, DEFAULT_PRESENTATION, minimumParagraphSpace, normalizePresentation } from "../src/presentation.ts";

const presentationSettingsSource = readFileSync(new URL("../src/PresentationSettings.tsx", import.meta.url), "utf8");

test("presentation preferences preserve chosen reading adjustments", () => {
  assert.deepEqual(normalizePresentation({ foreground: "#102030", background: "#fefefe", font: "serif", fontSize: 20, lineHeight: 1.8, paragraphSpace: 2.7, lineMeasure: 95 }), {
    foreground: "#102030", background: "#fefefe", font: "serif", fontSize: 20, lineHeight: 1.8, paragraphSpace: 2.7, lineMeasure: 95,
  });
});

test("presentation preferences clamp stored values and reject invalid colours", () => {
  assert.deepEqual(normalizePresentation({ foreground: "red", background: "#fff", font: "comic", fontSize: 100, lineHeight: 1, paragraphSpace: 0, lineMeasure: 20 }), {
    ...DEFAULT_PRESENTATION, fontSize: 32, lineHeight: 1.5, paragraphSpace: 2.3, lineMeasure: 45,
  });
});

test("default presentation normalizes unchanged and paragraph spacing rounds cleanly", () => {
  assert.deepEqual(normalizePresentation(DEFAULT_PRESENTATION), DEFAULT_PRESENTATION);
  assert.equal(normalizePresentation({ lineHeight: 1.6, paragraphSpace: 0 }).paragraphSpace, 2.4);
  assert.equal(normalizePresentation({ lineHeight: 1.7, paragraphSpace: 0 }).paragraphSpace, 2.6);
  assert.equal(minimumParagraphSpace(1.6), 2.4);
  assert.equal(minimumParagraphSpace(1.7), 2.6);
});

test("presentation range controls have explicit labels and reset to defaults", () => {
  for (const id of ["presentation-size", "presentation-line-height", "presentation-paragraph-space", "presentation-line-measure"]) {
    assert.match(presentationSettingsSource, new RegExp(`<label htmlFor="${id}">`));
    assert.match(presentationSettingsSource, new RegExp(`<input id="${id}"`));
  }
  assert.match(presentationSettingsSource, /min=\{minimumParagraphSpace\(s\.lineHeight\)\}/);
  assert.match(presentationSettingsSource, /value=\{s\.paragraphSpace\}/);
  assert.match(presentationSettingsSource, /setPresentation\(DEFAULT_PRESENTATION\)/);
});

test("paragraph spacing remains at least 1.5 times the selected line height", () => {
  for (const lineHeight of [1.5, 1.6, 1.7, 1.8, 1.9, 2]) {
    const settings = normalizePresentation({ lineHeight, paragraphSpace: 0 });
    assert.ok(settings.paragraphSpace >= Math.ceil(lineHeight * 15) / 10);
  }
});

test("computed RGB and hex theme colours become valid colour input values", () => {
  assert.equal(cssColourToHex("rgb(20, 60, 120)"), "#143c78");
  assert.equal(cssColourToHex("rgba(255, 128, 0, 0.5)"), "#ff8000");
  assert.equal(cssColourToHex("rgb(100% 50% 0% / 50%)"), "#ff8000");
  assert.equal(cssColourToHex("#abc"), "#aabbcc");
  assert.equal(cssColourToHex("oklch(65% 0.2 20)", "#101010"), "#101010");
});
