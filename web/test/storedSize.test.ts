import assert from "node:assert/strict";
import test from "node:test";
import { storedSizeText } from "../src/Properties.tsx";

test("storedSizeText: stored folder shows size, counts and time; nothing stored shows nothing", () => {
  const row = { path: "/a", bytes: 10, diskBytes: 2048, files: 3, dirs: 1, scannedAt: Date.UTC(2026, 9, 20, 12, 30) };
  assert.equal(storedSizeText([row, { ...row, path: "/a/x" }], "/a"), "2.0 KiB on disk · 3 file(s), 1 folder(s) · measured 2026-10-20 12:30");
  assert.equal(storedSizeText(null, "/a"), null); // 204
  assert.equal(storedSizeText([{ ...row, path: "/a/x" }], "/a"), null);
});
