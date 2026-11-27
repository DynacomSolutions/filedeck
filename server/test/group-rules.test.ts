import { test } from "node:test";
import assert from "node:assert/strict";
import { parseGroupRules } from "../src/group-rules.ts";

test("load and normalise only the local agent's rules", () => {
  const input = JSON.stringify({ studio: [{ name: "Builds", paths: ["/data/.//builds/", "/data/builds"],
    exclude: ["/data/builds/old"], labels: { container: "builder" } }], archive: "unused" });
  const rules = parseGroupRules(input, "studio");
  assert.deepEqual(rules[0]?.paths, ["/data/builds"]);
  assert.deepEqual(rules[0]?.exclude, ["/data/builds/old"]);
  assert.equal(rules[0]?.labels.container, "builder");
  assert.deepEqual(parseGroupRules(input, "another"), []);
  assert.deepEqual(parseGroupRules(input, "constructor"), []);
});

test("reject invalid, ambiguous and out-of-scope prefixes and labels", () => {
  const options = [
    [{ name: "A", paths: ["/a"] }, { name: "A", paths: ["/b"] }],
    [{ name: "A", paths: ["/a"] }, { name: "B", paths: ["/a/."] }],
    [{ name: "A", paths: ["/a/../b"] }],
    [{ name: "A", paths: ["a"] }],
    [{ name: "A", paths: [] }],
    [{ name: "A", paths: ["/a"], exclude: ["/ab"] }],
    [{ name: "A", paths: ["/a"], labels: { node: "another" } }],
    [{ name: "A", paths: ["/a"], labels: { container: "\nbuilder" } }],
  ];
  for (const studio of options) assert.throws(() => parseGroupRules(JSON.stringify({ studio }), "studio"));
});
