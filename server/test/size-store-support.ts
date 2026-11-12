// Shared by the size-store*.test.ts files: the temporary folder, what is closed at the end of a file even when an assertion threw, and the common helpers.
import { before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createAgent as makeAgent } from "../src/agent.ts";
import { SizeStore as RealSizeStore } from "../src/size-store.ts";

// a file-backed size store starts a writer thread: close every agent so the test process can exit
const agents: { close(): Promise<void> }[] = [];
export const createAgent = (cfg: Parameters<typeof makeAgent>[0]) => {
  const a = makeAgent(cfg);
  agents.push(a as unknown as { close(): Promise<void> });
  return a;
};
// every store a test opens is closed at the end of the file, even when an assertion threw first (an open file-backed store keeps a writer thread, and with it the process, alive)
const openStores: { close(): Promise<void> | void }[] = [];
export class SizeStore extends RealSizeStore {
  constructor(...a: ConstructorParameters<typeof RealSizeStore>) {
    super(...a);
    openStores.push(this);
  }
}

export let tmp: string;
export const at = (p: string) => path.join(tmp, p);
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export const mk = (ttlMs = 60_000, maxEntries = 100_000, commitChunk?: number) => new SizeStore(":memory:", { root: tmp, ttlMs, maxEntries, commitChunk });

before(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "filedeck-sizes-")));
});
after(async () => {
  for (const a of agents) await a.close().catch(() => {}); // some tests close their agent already
  for (const s of openStores) await Promise.resolve(s.close()).catch(() => {});
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** the folder most tests scan: files, a subfolder two levels deep, a link and a trash store */
export function makeTreeA() {
  fs.mkdirSync(at("a/sub/deep"), { recursive: true });
  fs.writeFileSync(at("a/f.txt"), "12345");
  fs.writeFileSync(at("a/sub/g.txt"), "1234567890");
  fs.writeFileSync(at("a/sub/deep/h.txt"), "x");
  fs.symlinkSync("/etc/passwd", at("a/link"));
  fs.mkdirSync(at("a/.filedeck-trash"));
  fs.writeFileSync(at("a/.filedeck-trash/t"), "T".repeat(1000));
}

/** readdir calls made while `fn` runs; the paths are kept so a failed count says which folders were read */
export async function countReaddir(fn: () => Promise<unknown>, paths: string[] = []): Promise<number> {
  const orig = fsp.readdir;
  let n = 0;
  (fsp as { readdir: unknown }).readdir = (...a: unknown[]) => (n++, paths.push(String(a[0])), (orig as (...x: unknown[]) => unknown)(...a));
  try {
    await fn();
  } finally {
    (fsp as { readdir: unknown }).readdir = orig;
  }
  return n;
}

export const rows = async (s: SizeStore, p: string) => (await s.tree(p, 64, false)).entries.map(({ scannedAt: _s, ...e }) => e);
/** the store must agree with a from-scratch scan of the same tree */
export async function agrees(s: SizeStore, p: string) {
  const ref = mk();
  await ref.scan(p, undefined, true);
  assert.deepEqual(await rows(s, p), await rows(ref, p));
  ref.close();
}
export const fileStore = () => new SizeStore(path.join(fs.mkdtempSync(path.join(tmp, "db-")), "sizes.db"), { root: tmp, ttlMs: 60_000, maxEntries: 1_000_000 });
