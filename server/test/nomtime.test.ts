import test from "node:test";
import assert from "node:assert/strict";
import { fmtDate } from "../../web/src/fmtDate.ts";

test("fmtDate: an unknown modification time is empty, never 1970-01-01", () => {
  for (const v of [null, undefined, 0, -1, NaN, Infinity]) assert.equal(fmtDate(v), "");
  assert.equal(fmtDate(Date.UTC(2026, 9, 5, 16, 30)), "2026-10-05 16:30");
});
