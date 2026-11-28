import assert from "node:assert/strict";
import fs from "node:fs";
import { contractTest } from "./agent-under-test.ts";
import { GOLDEN_FILE, REQUESTS, buildFixture, exercise } from "./fs-golden-lib.ts";
import { withAgent } from "./fs-fixture.ts";

// The answers of the file routes on one fixture tree are the ones the TS agent gave when they were recorded
// (fs-golden-capture.ts). The TS agent must still give them, and so must the Rust agent.
contractTest("the file routes answer as the recorded TS agent did", () =>
  withAgent({ setup: (root) => buildFixture(root), prefix: "fd-golden-" }, async (app) => {
    const golden = JSON.parse(fs.readFileSync(GOLDEN_FILE, "utf8")) as Record<string, unknown>;
    assert.deepEqual(Object.keys(golden), Object.keys(REQUESTS), "the golden file lists the same requests");
    const got = await exercise(app);
    for (const name of Object.keys(REQUESTS)) assert.deepEqual(got[name], golden[name], name);
  }),
);
