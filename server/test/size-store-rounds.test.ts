import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { loadConfig } from "../src/config.ts";
import { createAgent, SizeStore, tmp, at, sleep, mk, rows, makeTreeA } from "./size-store-support.ts";

before(() => makeTreeA());

// ---- second review round ----

test("applyChanged: a recreated folder is not trusted even when it gets the old inode number", async () => {
  fs.mkdirSync(at("rc2/x/y"), { recursive: true });
  fs.writeFileSync(at("rc2/x/y/f"), "1".repeat(1000));
  const [l, st] = [fsp.lstat, fsp.stat];
  const same = (fn: (...a: never[]) => Promise<fs.Stats>) => async (p: string, ...a: never[]) => {
    const s = await fn(p as never, ...a);
    if (String(p).startsWith(at("rc2/"))) Object.defineProperty(s, "ino", { value: 7 });
    return s;
  };
  (fsp as { lstat: unknown }).lstat = same(l as never);
  (fsp as { stat: unknown }).stat = same(st as never);
  try {
    const s = mk();
    await s.scan("/rc2");
    await sleep(30);
    fs.rmSync(at("rc2/x"), { recursive: true });
    fs.mkdirSync(at("rc2/x"));
    fs.writeFileSync(at("rc2/x/g"), "2");
    await s.applyChanged("/rc2");
    assert.equal((await s.tree("/rc2", 0, false)).entries[0]!.bytes, 1);
    s.close();
  } finally {
    (fsp as { lstat: unknown }).lstat = l;
    (fsp as { stat: unknown }).stat = st;
  }
});

test("uncached store keeps answering for earlier scans, not only the latest", async () => {
  fs.mkdirSync(at("u/a/x"), { recursive: true });
  fs.mkdirSync(at("u/b"), { recursive: true });
  fs.writeFileSync(at("u/file"), "");
  const orig = console.error;
  console.error = () => {};
  try {
    const s = new SizeStore(at("u/file/sizes.db"), { root: at("u"), ttlMs: 60_000, maxEntries: 100_000 });
    assert.equal(s.persistent, false);
    await s.scan("/a");
    await s.scan("/b");
    assert.equal((await s.tree("/a", 1, false)).entries.length, 2);
    assert.equal((await s.tree("/b", 1, false)).entries.length, 1);
    s.close();
  } finally {
    console.error = orig;
  }
});

test("the tree for an answer is built under the scan's lock", async () => {
  const s = mk();
  let got = false;
  let late!: Promise<() => void>;
  await s.scanRead("/a", undefined, true, undefined, async () => {
    late = s.lock("/a").then((r) => ((got = true), r));
    await sleep(30);
    assert.equal(got, false);
  });
  (await late)();
  assert.equal(got, true);
  s.close();
});

test("scans: requests do not wait for overlapping scans, a vanished start folder cannot deadlock, cancel works while waiting", async () => {
  const root = fs.mkdtempSync(path.join(tmp, "dl-"));
  for (const d of ["big/sub", "big/sub2", "q1", "q2", "p/x", "p/w", "p/z"]) fs.mkdirSync(path.join(root, d), { recursive: true });
  const slow = new Set([path.join(root, "big"), path.join(root, "q1"), path.join(root, "q2")]);
  const orig = fsp.readdir;
  // "big" is read only once the test lets it go, so the assertions below do not depend on how fast the host is
  let letBigGo!: () => void;
  const bigGate = new Promise<void>((r) => (letBigGo = r));
  (fsp as { readdir: unknown }).readdir = async (p: string, ...a: unknown[]) => {
    if (String(p) === path.join(root, "big")) await bigGate;
    else if (slow.has(String(p))) await sleep(500);
    return (orig as (...x: unknown[]) => Promise<unknown>)(p, ...a);
  };
  try {
    const app = createAgent(loadConfig({ FILEDECK_ROOT: root, FILEDECK_NODE: "t", FILEDECK_DU_WAIT_MS: "100" } as never));
    const post = async (p: string) => (await app.request("/api/jobs/size", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: p }) })).json() as Promise<{ id: string; state: string }>;
    const job = async (id: string) => (await (await app.request(`/api/jobs/${id}`)).json()) as { state: string };
    const settle = async (id: string) => {
      let j = await job(id);
      for (let i = 0; i < 3000 && (j.state === "queued" || j.state === "running"); i++) {
        await sleep(20);
        j = await job(id);
      }
      return j.state;
    };

    // the handlers answer at once while an overlapping scan holds the subtree
    const big = await post("/big");
    // each answer must arrive while the scan that holds the subtree is still blocked: a handler that waited for the lock would never answer, and the guard fails the test
    const answered = async <T>(p: Promise<T>, what: string): Promise<T> => {
      let guard!: NodeJS.Timeout;
      const stuck = new Promise<never>((_, rej) => (guard = setTimeout(() => rej(new Error(`${what} waited for the lock`)), 30_000)));
      try {
        return await Promise.race([p, stuck]);
      } finally {
        clearTimeout(guard);
      }
    };
    const sub = await answered(post("/big/sub"), "POST");
    // a scan of a folder below the walk goes beside it (SizeStore.lock with `nest`): it ends while the walk is still blocked, and the answer for its folder comes at once
    assert.equal(await answered(settle(sub.id), "the scan of the subfolder"), "done");
    assert.equal((await job(big.id)).state, "running");
    const r = await answered(Promise.resolve(app.request("/api/du?path=/big/sub&depth=0")), "GET du");
    assert.equal(r.status, 200);
    letBigGo();
    // a waiting job can be canceled, and it does not block the one after it
    const doomed = await post("/big/sub2");
    await app.request(`/api/jobs/${doomed.id}/cancel`, { method: "POST" });
    assert.equal(await settle(doomed.id), "canceled");
    assert.equal(await settle(big.id), "done");
    assert.equal(await settle(sub.id), "done");

    // two slow jobs fill the slots; the folders of the queued ones vanish before they start
    const q1 = await post("/q1");
    const q2 = await post("/q2");
    const x = await post("/p/x");
    const w = await post("/p/w");
    const z = await post("/p/z");
    fs.rmSync(path.join(root, "p/x"), { recursive: true });
    fs.rmSync(path.join(root, "p/w"), { recursive: true });
    assert.equal(await settle(q1.id), "done");
    assert.equal(await settle(q2.id), "done");
    assert.equal(await settle(x.id), "failed");
    assert.equal(await settle(w.id), "failed");
    assert.equal(await settle(z.id), "done");
  } finally {
    letBigGo();
    (fsp as { readdir: unknown }).readdir = orig;
  }
});

// ---- round 4 ----

test("a detached du scan running past a minute is still joined by the repeat request, which then gets the result", async (t) => {
  const root = fs.mkdtempSync(path.join(tmp, "det-"));
  fs.mkdirSync(path.join(root, "big/sub"), { recursive: true });
  let open!: () => void;
  const gate = new Promise<void>((r) => (open = r));
  const orig = fsp.readdir;
  (fsp as { readdir: unknown }).readdir = async (p: string, ...a: unknown[]) => {
    if (String(p) === path.join(root, "big")) await gate;
    return (orig as (...x: unknown[]) => Promise<unknown>)(p, ...a);
  };
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
  try {
    const app = createAgent(loadConfig({ FILEDECK_ROOT: root, FILEDECK_NODE: "t", FILEDECK_DU_WAIT_MS: "0" } as never));
    const du = async () => app.request("/api/du?path=/big&fresh=1");
    const first = await du();
    assert.equal(first.status, 202);
    const { jobId } = (await first.json()) as { jobId: string };
    t.mock.timers.tick(61_000);
    const again = await du();
    assert.equal(again.status, 202);
    assert.equal(((await again.json()) as { jobId: string }).jobId, jobId);
    t.mock.timers.reset();
    open();
    for (let i = 0; i < 200; i++) {
      const j = (await (await app.request(`/api/jobs/${jobId}`)).json()) as { state: string };
      if (j.state === "done") break;
      await sleep(20);
    }
    const last = await du();
    assert.equal(last.status, 200);
    assert.equal(((await last.json()) as { entries: unknown[] }).entries.length, 2);
  } finally {
    t.mock.timers.reset();
    (fsp as { readdir: unknown }).readdir = orig;
  }
});

test("uncached store keeps at most maxEntries rows across remembered walks", async () => {
  fs.mkdirSync(at("cap/a/x"), { recursive: true });
  fs.mkdirSync(at("cap/b/y"), { recursive: true });
  fs.writeFileSync(at("cap/file"), "");
  const orig = console.error;
  console.error = () => {};
  try {
    const s = new SizeStore(at("cap/file/sizes.db"), { root: at("cap"), ttlMs: 60_000, maxEntries: 3 });
    await s.scan("/a");
    await s.scan("/b");
    assert.equal((await s.tree("/a", 1, false)).entries.length, 0); // evicted: 2 + 2 rows > 3
    assert.equal((await s.tree("/b", 1, false)).entries.length, 2);
    s.close();
  } finally {
    console.error = orig;
  }
});

// The du totals test and the /healthz test run against any agent: test/contract/du-totals.test.ts.
