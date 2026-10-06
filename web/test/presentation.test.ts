import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_PRESENTATION, normalizePresentation } from "../src/presentation.ts";

test("presentation preferences preserve chosen reading adjustments", () => {
  assert.deepEqual(normalizePresentation({ foreground: "#102030", background: "#fefefe", font: "serif", fontSize: 20, lineHeight: 1.8, paragraphSpace: 1.5, lineMeasure: 95 }), {
    foreground: "#102030", background: "#fefefe", font: "serif", fontSize: 20, lineHeight: 1.8, paragraphSpace: 1.5, lineMeasure: 95,
  });
});

test("presentation preferences clamp stored values and reject invalid colours", () => {
  assert.deepEqual(normalizePresentation({ foreground: "red", background: "#fff", font: "comic", fontSize: 100, lineHeight: 1, paragraphSpace: 0, lineMeasure: 20 }), {
    ...DEFAULT_PRESENTATION, fontSize: 32, lineHeight: 1.5, lineMeasure: 45,
  });
});
