/**
 * The contract harness: one way for a test to talk to "the agent", whichever agent it is.
 *
 * Mode comes from FILEDECK_CONTRACT_MODE:
 *   inprocess (default)  the Hono app of this repository, called in the test process (`app.request`).
 *   spawn                a child process on loopback, started per call with the given settings.
 *                        FILEDECK_CONTRACT_SPAWN is the command line; the default starts the TS agent.
 *   url                  one agent that already runs. FILEDECK_CONTRACT_AGENT_URL, FILEDECK_CONTRACT_AGENT_TOKEN
 *                        and FILEDECK_CONTRACT_ROOT (the folder that agent serves as "/") are required.
 *
 * See docs/contract-tests.md.
 */
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test as baseTest, type TestContext } from "node:test";
import { serve } from "@hono/node-server";
import { createAgent } from "../../src/agent.ts";
import { loadConfig } from "../../src/config.ts";

export type ContractMode = "inprocess" | "spawn" | "url";

export const contractMode = (): ContractMode => {
  const m = process.env.FILEDECK_CONTRACT_MODE ?? (process.env.FILEDECK_CONTRACT_AGENT_URL ? "url" : "inprocess");
  if (m !== "inprocess" && m !== "spawn" && m !== "url") throw new Error(`FILEDECK_CONTRACT_MODE: "${m}" is not inprocess, spawn or url`);
  return m;
};

/** Thrown when the agent under test cannot be set up the way a test needs. `contractTest` turns it into a skip. */
export class ContractUnsupported extends Error {}

export interface AgentUnderTest {
  readonly mode: ContractMode;
  /** the folder the agent serves as "/" */
  readonly root: string;
  /** base URL when the agent listens (spawn and url modes). For a URL in every mode, call `listen()`. */
  readonly url?: string;
  /** the base URL of the agent on loopback. In process it starts a listener on first use. The hub tests point their node list at it. */
  listen(): Promise<string>;
  /** the bearer token the agent wants, when it wants one */
  readonly token?: string;
  /** like Hono's `app.request`: a path or URL, a method, headers and a body; the bearer token is added when the agent has one and the call has none */
  request(input: string, init?: RequestInit): Promise<Response>;
  /** the same call, never with a token: for tests of what an unknown caller gets */
  anon(input: string, init?: RequestInit): Promise<Response>;
  /** the in-process Hono app, for tests that read internals. Undefined for any other mode. */
  readonly raw?: ReturnType<typeof createAgent> & { close(): Promise<void> };
  close(): Promise<void>;
}

export interface AgentOptions {
  /** the folder served as "/". Default: a new one. In url mode it must be the agent's own root. */
  root?: string;
  /** settings as for `loadConfig` (FILEDECK_NODE, FILEDECK_AGENT_TOKEN, FILEDECK_JOBS_FILE and so on) */
  env?: Record<string, string>;
}

const withAuth = (token: string | undefined, init?: RequestInit): RequestInit | undefined => {
  if (!token) return init;
  const h = new Headers(init?.headers);
  if (!h.has("authorization")) h.set("authorization", `Bearer ${token}`);
  return { ...init, headers: h };
};

/** A fixture folder for a test. In url mode that is the agent's own folder, emptied first; otherwise a new temporary one. */
export function fixtureRoot(prefix = "filedeck-contract-"): string {
  if (contractMode() !== "url") return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  const root = urlRoot();
  for (const n of fs.readdirSync(root)) fs.rmSync(path.join(root, n), { recursive: true, force: true });
  return root;
}
/** Removes what `fixtureRoot` made. In url mode it empties the agent's folder and keeps the folder. */
export function dropFixtureRoot(root: string): void {
  if (contractMode() !== "url") return void fs.rmSync(root, { recursive: true, force: true });
  for (const n of fs.readdirSync(root)) fs.rmSync(path.join(root, n), { recursive: true, force: true });
}

function urlRoot(): string {
  const r = process.env.FILEDECK_CONTRACT_ROOT;
  if (!r) throw new Error("FILEDECK_CONTRACT_ROOT is required in url mode (the folder the agent serves as /)");
  return fs.realpathSync(r);
}

export async function agentUnderTest(opts: AgentOptions = {}): Promise<AgentUnderTest> {
  const mode = contractMode();
  const env = opts.env ?? {};
  if (mode === "inprocess") {
    const root = opts.root ?? fixtureRoot();
    const raw = createAgent(loadConfig({ FILEDECK_ROOT: root, FILEDECK_NODE: "t", ...env } as never)) as ReturnType<typeof createAgent> & { close(): Promise<void> };
    const token = env.FILEDECK_AGENT_TOKEN;
    let server: ReturnType<typeof serve> | undefined;
    let listening: Promise<string> | undefined;
    return {
      mode, root, token, raw,
      listen: () => (listening ??= new Promise<string>((res) => {
        server = serve({ fetch: raw.fetch as never, port: 0, hostname: "127.0.0.1" }, (i) => res(`http://127.0.0.1:${i.port}`));
      })),
      request: async (input, init) => (await raw.request(input, withAuth(token, init))) as Response,
      anon: async (input, init) => (await raw.request(input, init)) as Response,
      close: async () => {
        server?.close();
        await raw.close();
      },
    };
  }
  if (mode === "url") {
    const url = process.env.FILEDECK_CONTRACT_AGENT_URL;
    const token = process.env.FILEDECK_CONTRACT_AGENT_TOKEN || undefined;
    if (!url) throw new Error("FILEDECK_CONTRACT_AGENT_URL is required in url mode");
    // one running agent cannot take the settings of one test
    if (Object.keys(env).length) throw new ContractUnsupported(`needs settings ${Object.keys(env).join(", ")}`);
    const root = urlRoot();
    if (opts.root && fs.realpathSync(opts.root) !== root) throw new Error("in url mode a test must use the agent's own root (fixtureRoot())");
    return { mode, root, url, token, listen: async () => url, request: (input, init) => fetch(new URL(input, url), withAuth(token, init)), anon: (input, init) => fetch(new URL(input, url), init), close: async () => {} };
  }
  return startSpawned(opts);
}

const here = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.resolve(here, "../..");

async function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const s = net.createServer();
    s.once("error", rej);
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => res(p));
    });
  });
}

async function startSpawned(opts: AgentOptions): Promise<AgentUnderTest> {
  const root = opts.root ?? fixtureRoot();
  const env = opts.env ?? {};
  const port = await freePort();
  const cmd = process.env.FILEDECK_CONTRACT_SPAWN?.trim();
  const argv = cmd ? cmd.split(/\s+/) : [process.execPath, "--import", "tsx", path.join(serverDir, "src/main.ts")];
  const child: ChildProcess = spawn(argv[0]!, argv.slice(1), {
    cwd: serverDir,
    env: { ...process.env, FILEDECK_MODE: "agent", FILEDECK_NODE: "t", ...env, FILEDECK_ROOT: root, PORT: String(port), FILEDECK_HOST: "127.0.0.1" },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let err = "";
  child.stderr!.on("data", (d) => { err = (err + d).slice(-4000); });
  let exited = false;
  child.once("exit", () => { exited = true; });
  const url = `http://127.0.0.1:${port}`;
  const token = env.FILEDECK_AGENT_TOKEN;
  const t0 = Date.now();
  for (;;) {
    if (exited) throw new Error(`the agent exited at start: ${err}`);
    try {
      if ((await fetch(`${url}/healthz`)).ok) break;
    } catch { /* not listening yet */ }
    if (Date.now() - t0 > 30_000) {
      child.kill("SIGKILL");
      throw new Error(`the agent did not answer /healthz within 30 s: ${err}`);
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  return {
    mode: "spawn", root, url, token,
    listen: async () => url,
    request: (input, init) => fetch(new URL(input, url), withAuth(token, init)),
    anon: (input, init) => fetch(new URL(input, url), init),
    close: async () => {
      if (exited) return;
      const gone = new Promise<void>((r) => child.once("exit", () => r()));
      child.kill("SIGTERM");
      const hard = setTimeout(() => child.kill("SIGKILL"), 10_000);
      await gone;
      clearTimeout(hard);
    },
  };
}

/** `test` that skips, instead of failing, when the agent under test cannot take the settings the test needs. */
export function contractTest(name: string, fn: (t: TestContext) => unknown | Promise<unknown>): void {
  baseTest(name, async (t) => {
    try {
      await fn(t);
    } catch (e) {
      if (e instanceof ContractUnsupported) return void t.skip(e.message);
      throw e;
    }
  });
}

/** Tests that read internals (`raw`) run in process only. */
export const inProcessOnly = (): boolean => contractMode() === "inprocess";
