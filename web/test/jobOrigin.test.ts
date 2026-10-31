import assert from "node:assert/strict";
import test from "node:test";
import { isBackground, splitByOrigin } from "../src/jobOrigin.ts";

test("isBackground: only ui (or no origin, an older agent) is foreground", () => {
  assert.equal(isBackground({ origin: "ui" }), false);
  assert.equal(isBackground({}), false);
  for (const o of ["cli", "watcher", "adopted"] as const) assert.equal(isBackground({ origin: o }), true, o);
});

test("splitByOrigin keeps order within each side", () => {
  const jobs = [{ id: "a", origin: "cli" as const }, { id: "b", origin: "ui" as const }, { id: "c" }, { id: "d", origin: "watcher" as const }];
  const { fore, back } = splitByOrigin(jobs);
  assert.deepEqual(fore.map((j) => j.id), ["b", "c"]);
  assert.deepEqual(back.map((j) => j.id), ["a", "d"]);
});
