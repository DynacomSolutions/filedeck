// Shared by size-store-fresh.test.ts and size-store-fresh-api.test.ts: the temporary folder, what is closed at the end of a file even when an assertion threw, and the fixtures.
import { test as nodeTest, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SizeStore } from "../src/size-store.ts";

/** every test here starts agents, helpers and workers: a leak must fail the test, not hang the runner */
export const test = ((name: string, fn: (t: never) => unknown) => nodeTest(name, { timeout: 120_000 }, fn as never)) as typeof nodeTest;

export let tmp: string;
export const stores: SizeStore[] = [];
export const agents: { close(): Promise<void> }[] = [];
before(() => void (tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "filedeck-fresh-")))));
after(async () => {
  for (const s of stores) await s.close();
  for (const a of agents) await Promise.race([a.close().catch(() => {}), new Promise((r) => setTimeout(r, 15_000))]);
  fs.rmSync(tmp, { recursive: true, force: true });
});
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export const until = async (f: () => boolean | Promise<boolean>, ms = 20_000) => {
  for (const t0 = Date.now(); !(await f()) && Date.now() - t0 < ms; ) await sleep(20);
};
export function fixture(name: string) {
  const root = path.join(tmp, name);
  for (const d of ["a/x", "a/y", "b/z"]) fs.mkdirSync(path.join(root, d), { recursive: true });
  for (const f of ["a/x/f", "a/y/f", "b/z/f"]) fs.writeFileSync(path.join(root, f), "12345");
  const db = path.join(tmp, `${name}.db`); // beside the tree, not in it
  const s = new SizeStore(db, { root, ttlMs: 3_600_000, maxEntries: 100_000 });
  stores.push(s);
  return { root, s, db };
}
export const scannedAt = (db: string, p: string) => {
  const d = new DatabaseSync(db, { readOnly: true });
  try {
    return (d.prepare("SELECT scanned_at s FROM sizes WHERE path = ?").get(p) as { s: number } | undefined)?.s;
  } finally {
    d.close();
  }
};


export type Any = any; // the tests reach into private state on purpose
/** a store as a running watcher leaves it: ready at once and covering everything, then one full walk (rows re-read after the ready time are trusted) */
export async function validate(s: SizeStore, p = "/") {
  const ready = Date.now();
  const a = s as Any;
  a.covers = () => true;
  a.quiet = () => true;
  a.watchedSince = () => ready;
  await sleep(5);
  await s.scan(p, undefined, true);
}
export const bytes = (t: { entries: { bytes: number }[] } | null) => t?.entries?.[0]?.bytes ?? null;
export const backlog = async (s: SizeStore, ps: string[]) => {
  await s.notePending(ps.map((path) => ({ path, dueAt: Date.now() - 10_000, modify: false })), 100);
  return s.takeDue(Date.now(), 10, { modifyMs: 100, settleMs: 1 });
};
/** hold back the commit sends the picker chooses until released */
export function hold(s: SizeStore, pick: (m: Any) => boolean) {
  const a = s as Any;
  const orig = a.send.bind(s);
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let held = false;
  a.send = async (m: Any) => {
    if (m.op === "commit" && pick(m)) {
      held = true;
      await gate;
    }
    return orig(m);
  };
  return { release, held: () => held };
}
/** the watcher applied what is pending: take it and report the re-reads ended */
export async function settlePending(s: SizeStore) {
  const got = (await s.takeDue(Date.now(), 100, { modifyMs: 100, settleMs: 1 })) ?? [];
  await s.noteRan(got.map((p) => ({ path: p, endedAt: Date.now(), hold: false })), 100);
}
export const rowsOf = (db: string, sql: string) => {
  const d = new DatabaseSync(db, { readOnly: true });
  try {
    return d.prepare(sql).all() as Any[];
  } finally {
    d.close();
  }
};

