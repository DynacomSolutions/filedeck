// One size store file, read and written by both agents. Run it where the Rust agent is built:
//   FILEDECK_RUST_BIN=/path/to/filedeckd node --import tsx --test test/rust/store-compat.test.ts
// It is not part of `npm test` (no FILEDECK_RUST_BIN there); the rust CI job runs it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const bin = process.env.FILEDECK_RUST_BIN;
const serverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const TOKEN = "compat-token-" + "x".repeat(24);

type Agent = { url: string; get(p: string): Promise<Response>; stop(): Promise<void> };
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
async function start(kind: "ts" | "rust", root: string, idx: string): Promise<Agent> {
  const port = await freePort();
  const argv = kind === "rust" ? [bin!] : [process.execPath, "--import", "tsx", path.join(serverDir, "src/main.ts")];
  const child: ChildProcess = spawn(argv[0]!, argv.slice(1), {
    cwd: serverDir,
    env: { ...process.env, FILEDECK_MODE: "agent", FILEDECK_NODE: "t", FILEDECK_ROOT: root, FILEDECK_INDEX_DIR: idx, FILEDECK_HOST: "127.0.0.1", PORT: String(port), FILEDECK_AGENT_TOKEN: TOKEN, FILEDECK_DU_WAIT_MS: "60000" },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let err = "";
  child.stderr!.on("data", (d) => (err = (err + d).slice(-3000)));
  let exited = false;
  child.once("exit", () => (exited = true));
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; ; i++) {
    if (exited) throw new Error(`${kind} agent exited: ${err}`);
    try {
      if ((await fetch(`${url}/healthz`)).ok) break;
    } catch {
      /* not listening yet */
    }
    if (i > 600) throw new Error(`${kind} agent did not start: ${err}`);
    await new Promise((r) => setTimeout(r, 50));
  }
  return {
    url,
    get: (p) => fetch(url + p, { headers: { authorization: `Bearer ${TOKEN}` } }),
    stop: async () => {
      if (exited) return;
      const gone = new Promise<void>((r) => child.once("exit", () => r()));
      child.kill("SIGTERM");
      await gone;
    },
  };
}

type Du = { cached: boolean; stale?: boolean; entries: { path: string; type: string; bytes: number; diskBytes: number; files: number; dirs: number; scannedAt?: number }[] };
const du = async (a: Agent, q: string) => {
  const r = await a.get("/api/du?" + q);
  assert.equal(r.status, 200, q);
  return (await r.json()) as Du;
};

test("a size store file written by one agent is read, reused and extended by the other", { skip: bin ? false : "FILEDECK_RUST_BIN is not set" }, async () => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "filedeck-compat-")));
  const root = path.join(base, "root");
  const idx = path.join(base, "state");
  fs.mkdirSync(idx);
  for (const d of ["t/a", "t/b/c", "u/x"]) fs.mkdirSync(path.join(root, d), { recursive: true });
  fs.writeFileSync(path.join(root, "t/a/f"), "12345");
  fs.writeFileSync(path.join(root, "t/b/c/g"), "1234567890");
  fs.linkSync(path.join(root, "t/a/f"), path.join(root, "t/b/hard"));
  fs.symlinkSync("a", path.join(root, "t/link"));
  fs.writeFileSync(path.join(root, "u/x/h"), "abc");
  try {
    // 1. the TS agent scans /t and stops
    const ts1 = await start("ts", root, idx);
    const written = await du(ts1, "path=/t&depth=3");
    assert.equal(written.cached, false);
    await ts1.stop();

    // 2. the Rust agent reads the TS rows, reuses them without reading a folder, and scans /u itself
    const rs = await start("rust", root, idx);
    const stored = await du(rs, "path=/t&depth=3&cachedOnly=1");
    assert.deepEqual(stored.entries, written.entries, "the Rust agent reads the rows of the TS agent, scannedAt and disk bytes too");
    const reused = await du(rs, "path=/t&depth=3");
    assert.equal(reused.cached, true, "no folder was read again: the TS rows match the disk");
    assert.deepEqual(reused.entries, written.entries);
    const rsU = await du(rs, "path=/u&depth=2");
    assert.equal(rsU.cached, false);
    await rs.stop();

    // 3. the TS agent reads what the Rust agent wrote
    const ts2 = await start("ts", root, idx);
    const seen = await du(ts2, "path=/u&depth=2&cachedOnly=1");
    assert.deepEqual(seen.entries, rsU.entries, "the TS agent reads the rows of the Rust agent");
    assert.equal((await du(ts2, "path=/u&depth=2")).cached, true, "and reuses them");
    assert.equal((await du(ts2, "path=/t&depth=3")).cached, true, "the TS rows of step 1 are still there");
    // and the two agents give the same answer for the same fresh scan (sizes on disk too)
    const tsFresh = await du(ts2, "path=/t&depth=3&all=1&fresh=1");
    await ts2.stop();
    const idx2 = path.join(base, "state2");
    fs.mkdirSync(idx2);
    const rs2 = await start("rust", root, idx2);
    const rsFresh = await du(rs2, "path=/t&depth=3&all=1&fresh=1");
    await rs2.stop();
    const strip = (d: Du) => d.entries.map(({ scannedAt: _s, ...e }) => e).sort((x, y) => (x.path < y.path ? -1 : 1));
    assert.deepEqual(strip(rsFresh), strip(tsFresh), "same totals, same disk bytes, same entries");
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});
