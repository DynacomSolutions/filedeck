#!/usr/bin/env node
import { run } from "./du-cli.ts";

const [cmd, ...args] = process.argv.slice(2);
if (cmd !== "du") {
  process.stderr.write("usage: filedeck du [-s] [-h] [-d N] [-a] [--apparent-size] [--fresh] [--json] [--timeout SECONDS] node:/path...\n");
  process.exit(2);
}
const ac = new AbortController();
process.once("SIGINT", () => ac.abort());
process.exitCode = await run(args, process.env, {
  fetch,
  out: (s) => void process.stdout.write(s),
  err: (s) => void process.stderr.write(s),
  sleep: (ms) => new Promise((r) => (AbortSignal.any([ac.signal, AbortSignal.timeout(ms)]).addEventListener("abort", () => r(), { once: true }))),
  signal: ac.signal,
  now: Date.now,
});
