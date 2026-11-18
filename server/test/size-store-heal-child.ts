// A second agent process for the self-heal tests: opens one SizeStore and answers one JSON command per stdin line with one JSON line on stdout.
// argv: store file, served root, lease ms. Commands: {cmd: "state"}, {cmd: "scan", path}, {cmd: "close"}.
import readline from "node:readline";
import { SizeStore } from "../src/size-store.ts";

const [file, root, leaseMs] = process.argv.slice(2);
const lines: string[] = [];
const orig = console.error;
console.error = (...a: unknown[]) => {
  lines.push(a.join(" "));
  orig(...a);
};
const s = new SizeStore(file!, { root: root!, ttlMs: 3_600_000, maxEntries: 100_000, leaseMs: Number(leaseMs) });
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", async (l) => {
  const m = JSON.parse(l) as { id: number; cmd: string; path?: string };
  let out: unknown;
  try {
    if (m.cmd === "state") out = { file: s.storeFile, health: s.health(), writer: s.isWriter, lines };
    else if (m.cmd === "scan") {
      const r = await s.scanRead(m.path!);
      out = { read: r.read, dirs: r.res.dirs };
    } else if (m.cmd === "close") {
      await s.close();
      out = { closed: true };
    }
  } catch (e) {
    out = { err: (e as Error).message };
  }
  process.stdout.write(JSON.stringify({ id: m.id, out }) + "\n");
  if (m.cmd === "close") process.exit(0);
});
