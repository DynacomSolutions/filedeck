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
  // A ref'd timer: AbortSignal.timeout is unref'd, so sleeping on it alone lets the event loop empty (exit 13).
  sleep: (ms) =>
    new Promise((r) => {
      const t = setTimeout(r, ms);
      ac.signal.addEventListener("abort", () => (clearTimeout(t), r()), { once: true });
    }),
  signal: ac.signal,
  now: Date.now,
});
