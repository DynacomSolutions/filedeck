/**
 * Records the golden answers of the file routes from the TS agent, started as a child process (spawn mode).
 *   cd server && node --import tsx test/contract/fs-golden-capture.ts
 * Writes agent/tests/golden/fs.json. Run it again only when the TS agent's answers change on purpose.
 */
import fs from "node:fs";
import path from "node:path";
import { dropFixtureRoot, fixtureRoot, agentUnderTest } from "./agent-under-test.ts";
import { GOLDEN_FILE, buildFixture, exercise } from "./fs-golden-lib.ts";
import { TOKEN } from "./fs-fixture.ts";

process.env.FILEDECK_CONTRACT_MODE = "spawn";
delete process.env.FILEDECK_CONTRACT_SPAWN; // the TS agent, not another one

const root = fixtureRoot("filedeck-golden-");
try {
  buildFixture(root);
  const app = await agentUnderTest({ root, env: { FILEDECK_AGENT_TOKEN: TOKEN } });
  try {
    const got = await exercise(app);
    fs.mkdirSync(path.dirname(GOLDEN_FILE), { recursive: true });
    fs.writeFileSync(GOLDEN_FILE, JSON.stringify(got, null, 2) + "\n");
    console.log(`wrote ${Object.keys(got).length} answers to ${GOLDEN_FILE}`);
  } finally {
    await app.close();
  }
} finally {
  dropFixtureRoot(root);
}
