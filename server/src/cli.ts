#!/usr/bin/env node
import { run } from "./du-cli.ts";

const [cmd, ...args] = process.argv.slice(2);
if (cmd !== "du") {
  process.stderr.write("usage: filedeck du [-s] [-h] [-d N] [-a] [--apparent-size] [--fresh] [--json] node:/path...\n");
  process.exit(2);
}
process.exitCode = await run(args, process.env, {
  fetch,
  out: (s) => void process.stdout.write(s),
  err: (s) => void process.stderr.write(s),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  now: Date.now,
});
