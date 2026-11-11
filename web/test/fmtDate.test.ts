import assert from "node:assert/strict";
import test from "node:test";
import { fmtDate } from "../src/fmtDate.ts";

test("fmtDate shows local time in the existing format", () => {
  const d = new Date(2026, 10, 12, 5, 3, 59);
  assert.equal(fmtDate(d.getTime()), "2026-11-12 05:03");
});

test("fmtDate is empty for unknown times", () => {
  for (const v of [null, undefined, 0, -5, Number.NaN, Infinity, 8.7e15]) assert.equal(fmtDate(v as number), "");
});
