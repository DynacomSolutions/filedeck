/**
 * Helpers for the file route contract files (`fs-*.test.ts`): a fixture folder, a folder outside it, and one agent per test.
 * The agent always gets a token, because the Rust agent has no open mode.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { agentUnderTest, contractMode, dropFixtureRoot, fixtureRoot, type AgentUnderTest } from "./agent-under-test.ts";

export const TOKEN = "contract-fs-token-0123456789abcdef";

export interface Setup {
  /** fills the folder served as "/" and the folder beside it that a test must never reach */
  setup?: (root: string, outside: string) => void;
  /** more settings (not available in url mode: the test is skipped there) */
  env?: Record<string, string>;
  prefix?: string;
}

export async function withAgent(o: Setup, fn: (app: AgentUnderTest, root: string, outside: string) => Promise<void>): Promise<void> {
  const root = fixtureRoot(o.prefix ?? "filedeck-fs-");
  const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "filedeck-fs-outside-")));
  fs.writeFileSync(path.join(outside, "secret"), "top secret");
  let app: AgentUnderTest | undefined;
  try {
    o.setup?.(root, outside);
    const env = { ...(contractMode() === "url" ? {} : { FILEDECK_AGENT_TOKEN: TOKEN }), ...o.env };
    app = await agentUnderTest({ root, env });
    await fn(app, root, outside);
  } finally {
    await app?.close();
    dropFixtureRoot(root);
    fs.rmSync(outside, { recursive: true, force: true });
  }
}

/** GET a JSON answer: the status and the parsed body */
export async function getJson(app: AgentUnderTest, url: string): Promise<{ status: number; body: any }> {
  const r = await app.request(url);
  const text = await r.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: r.status, body };
}

export const q = (p: string) => encodeURIComponent(p);

/** a streamed listing: its lines, parsed */
export async function streamLines(app: AgentUnderTest, url: string): Promise<any[]> {
  const r = await app.request(url);
  if (r.status !== 200) throw new Error(`stream list ${url}: status ${r.status} ${await r.text()}`);
  return (await r.text()).split("\n").filter(Boolean).map((l) => JSON.parse(l));
}
