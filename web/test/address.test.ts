import assert from "node:assert/strict";
import test from "node:test";
import { crumbsOverflow } from "../src/address.ts";

test("breadcrumbs that are about one pixel too wide count as overflowing, in fractional pixels", () => {
  // Firefox at 390 px: content 245.65 px in a 244.4 px box. scrollWidth 245 and clientWidth 244 hid this from a whole-number test.
  assert.equal(crumbsOverflow(245.65, 244.4), true);
  assert.equal(crumbsOverflow(244.5, 244.4), true);
});

test("breadcrumbs that fit, or differ only by layout rounding, do not fold", () => {
  assert.equal(crumbsOverflow(245.65, 245.65), false);
  assert.equal(crumbsOverflow(245.65 + 1 / 64, 245.65), false);
  assert.equal(crumbsOverflow(120, 300), false);
});
