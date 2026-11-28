import { test } from "node:test";
import assert from "node:assert/strict";
import { normaliseAgentPath } from "../src/agent-auth.ts";

// The agent's token checks run against any agent in test/contract/agent-auth.test.ts.

test("normaliseAgentPath decodes and standardises paths for the hub guards", () => {
  for (const input of ["/api/v1/changes", "/api/v1/%63hanges", "/api/v1/CHANGES", "/api//v1/./changes", "/api\\v1\\changes", "/api/v1/x/../changes"]) {
    assert.equal(normaliseAgentPath(input + "?x=1"), "/api/v1/changes", input);
  }
  assert.equal(normaliseAgentPath("/api/v1/changes/?x=1"), "/api/v1/changes/");
  for (const input of ["/api/v1/changes2", "/api/fs/list", "/api/v1", "/api/v1/%zz"]) {
    assert.equal(normaliseAgentPath(input), input);
  }
});
