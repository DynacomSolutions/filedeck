import assert from "node:assert/strict";
import test from "node:test";
import { PHONE_BTN, phoneActionsFit } from "../src/phoneBar";

test("the phone bar keeps room for More and Clear, and shows the other actions that fit", () => {
  assert.equal(phoneActionsFit(PHONE_BTN * 2 + 60, 60, 4), 0);
  assert.equal(phoneActionsFit(PHONE_BTN * 3 + 60, 60, 4), 1);
  assert.equal(phoneActionsFit(PHONE_BTN * 6 + 60, 60, 4), 4);
  assert.equal(phoneActionsFit(PHONE_BTN * 20, 60, 4), 4);
});

test("a wide count is capped and a tiny bar never gives a negative number", () => {
  assert.equal(phoneActionsFit(PHONE_BTN * 4 + 88, 300, 4), 2);
  assert.equal(phoneActionsFit(40, 60, 4), 0);
});
