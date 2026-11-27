#!/usr/bin/env node
import { runGroups, GROUPS_USAGE } from "./groups-cli.ts";
import { run, USAGE } from "./du-cli.ts";

const HASH_USAGE = "       filedeck hash-password   (reads one line from stdin, prints a password hash)";

/** One line from stdin. On a terminal the typed characters are not echoed. */
async function readPassword(): Promise<string> {
  const stdin = process.stdin;
  if (stdin.isTTY) {
    process.stderr.write("Password: ");
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    let pw = "";
    outer: for await (const chunk of stdin as AsyncIterable<string>) {
      for (const ch of chunk) {
        if (ch === "\u0003") process.exit(130);
        if (ch === "\r" || ch === "\n" || ch === "\u0004") break outer;
        if (ch === "\u007f") pw = pw.slice(0, -1);
        else pw += ch;
      }
    }
    stdin.setRawMode(false);
    process.stderr.write("\n");
    return pw;
  }
  let buf = "";
  for await (const chunk of stdin) buf += chunk;
  return buf.split(/\r?\n/)[0] ?? "";
}

const [cmd, ...args] = process.argv.slice(2);
if (cmd === "hash-password") {
  const pw = await readPassword();
  if (!pw) {
    process.stderr.write("filedeck hash-password: the password is empty\n");
    process.exit(2);
  }
  const { hashPassword } = await import("./auth/store.ts");
  process.stdout.write(`${hashPassword(pw)}\n`);
  process.exit(0);
}
if (cmd !== "du" && cmd !== "groups") {
  process.stderr.write(`${USAGE}\n${GROUPS_USAGE}\n${HASH_USAGE}\n`);
  process.exit(2);
}
const ac = new AbortController();
process.once("SIGINT", () => ac.abort());
process.exitCode = await (cmd === "groups" ? runGroups : run)(args, process.env, {
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
