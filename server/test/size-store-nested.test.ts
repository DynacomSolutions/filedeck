// A scan of a folder below a walk that runs does not wait for that walk (SizeStore.lock with `nest`, the claims of SizeStore.walk, Jobs gates that say `urgent`).
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { loadConfig } from "../src/config.ts";
import { Jobs } from "../src/jobs.ts";
import { makeAgentJobs } from "../src/archive-routes.ts";
import { createAgent, SizeStore, at, sleep, mk, fileStore, countReaddir, agrees } from "./size-store-support.ts";

type Any = any; // the tests reach into private state on purpose
const ctl = (signal = new AbortController().signal) => ({ signal, progress: { bytes: 0, totalBytes: 0, entries: 0, totalEntries: 0, current: "" } });
const within = <T,>(p: Promise<T>, ms: number, what: string) => {
  let t!: NodeJS.Timeout;
  return Promise.race([p, new Promise<never>((_, rej) => (t = setTimeout(() => rej(new Error(what)), ms)))]).finally(() => clearTimeout(t));
};

/**
 * The first read (after `skip` reads) of a folder that `match` accepts waits for `go()`; `hit` resolves when that read has started. Every listing is sorted, so the order of the
 * walk (and with it, which folders it has passed when it waits) is the same on every file system.
 */
function blocker(match: (p: string) => boolean, skip = 0) {
  const orig = fsp.readdir;
  let go!: () => void;
  const gate = new Promise<void>((r) => (go = r));
  let hit!: () => void;
  const reading = new Promise<void>((r) => (hit = r));
  let taken = false;
  let seen = 0;
  (fsp as Any).readdir = async (p: string, ...a: unknown[]) => {
    if (!taken && match(String(p)) && seen++ >= skip) {
      taken = true;
      hit();
      await gate;
    }
    const out = await (orig as Any)(p, ...a);
    return Array.isArray(out) && out.every((x) => typeof x === "string") ? [...out].sort() : out;
  };
  return {
    reading,
    go,
    restore: () => {
      go();
      (fsp as Any).readdir = orig;
    },
  };
}

/** the folder tree of the tests: `a` holds `d1` (the nested scan, with a folder below it) and `s1` (a later sibling) */
function tree(name: string) {
  const w = (p: string, n: number) => (fs.mkdirSync(path.dirname(at(`${name}/${p}`)), { recursive: true }), fs.writeFileSync(at(`${name}/${p}`), "x".repeat(n)));
  w("a/top.txt", 7);
  w("a/d1/f", 100);
  w("a/d1/sub/g", 30);
  w("a/s1/h", 9);
  w("a/s1/deep/i", 5);
}

const stores: [string, () => SizeStore][] = [
  ["memory", () => mk()],
  ["file", () => fileStore()],
];

for (const [kind, open] of stores) {
  test(`${kind}: a scan below a blocked walk finishes at once, and the walk ends with the right totals`, async () => {
    tree(`n1${kind}`);
    const s = open();
    const b = blocker((p) => p === at(`n1${kind}/a`)); // the walk waits in its start folder: outside the folder of the nested scan
    try {
      const outer = s.scanRead(`/n1${kind}/a`, undefined, true);
      await b.reading;
      const d = await within(s.scanRead(`/n1${kind}/a/d1`, undefined, true), 10_000, "the nested scan waited for the walk");
      assert.equal(d.res.bytes, 130);
      assert.equal((s as Any).held.length, 1, "only the walk holds a lock");
      b.go();
      const a = await outer;
      assert.equal(a.res.bytes, 7 + 130 + 14);
      await agrees(s, `/n1${kind}/a`);
      assert.equal((s as Any).held.length, 0);
    } finally {
      b.restore();
    }
  });

  test(`${kind}: ahead: the walk reads the rows of the nested scan, which changed the folder, and counts them`, async () => {
    tree(`n2${kind}`);
    const s = open();
    const b = blocker((p) => p === at(`n2${kind}/a`));
    try {
      const since = Date.now();
      await sleep(5);
      const outer = s.scanRead(`/n2${kind}/a`, undefined, since);
      await b.reading;
      fs.writeFileSync(at(`n2${kind}/a/d1/new`), "n".repeat(50));
      const d = await within(s.scanRead(`/n2${kind}/a/d1`, undefined, true), 10_000, "the nested scan waited for the walk");
      assert.equal(d.res.bytes, 180);
      const paths: string[] = [];
      const a = await countReaddir(async () => {
        b.go();
        const x = await outer;
        assert.equal(x.res.bytes, 7 + 180 + 14);
      }, paths);
      assert.ok(a > 0);
      assert.deepEqual(paths.filter((p) => p === at(`n2${kind}/a/d1`) || p.startsWith(at(`n2${kind}/a/d1/`))), [], "the folder of the nested scan is not read again");
      await agrees(s, `/n2${kind}/a`);
    } finally {
      b.restore();
    }
  });

  test(`${kind}: ahead: the walk that comes to the folder while the nested scan runs waits for it`, async () => {
    tree(`n5${kind}`);
    const s = open();
    const rootGate = blocker((p) => p === at(`n5${kind}/a`));
    const d1Gate = blocker((p) => p === at(`n5${kind}/a/d1`)); // the nested scan reads this first: the walk has not come to it yet
    try {
      const since = Date.now();
      await sleep(5);
      const outer = s.scanRead(`/n5${kind}/a`, undefined, since);
      await rootGate.reading;
      fs.writeFileSync(at(`n5${kind}/a/d1/new`), "n".repeat(50));
      const d = s.scanRead(`/n5${kind}/a/d1`, undefined, true);
      await d1Gate.reading;
      let ended = false;
      void outer.then(
        () => (ended = true),
        () => (ended = true),
      );
      const paths: string[] = [];
      await countReaddir(async () => {
        rootGate.go();
        await sleep(200);
        assert.equal(ended, false, "the walk waits where it comes to the folder");
        d1Gate.go();
        assert.equal((await within(d, 10_000, "nested")).res.bytes, 180);
        assert.equal((await within(outer, 10_000, "walk")).res.bytes, 7 + 180 + 14);
      }, paths);
      // (the nested scan began its read of the folder before this count, and reads the folder below it inside it: the walk takes the rows the scan wrote and reads the folder no more)
      assert.deepEqual(paths.filter((p) => p === at(`n5${kind}/a/d1`)), [], "the walk read the folder again instead of waiting");
      await agrees(s, `/n5${kind}/a`);
    } finally {
      d1Gate.restore();
      rootGate.restore();
    }
  });

  test(`${kind}: passed: the walk had left the folder, and takes the change into its totals without losing the folder's rows`, async () => {
    tree(`n3${kind}`);
    const s = open();
    const b = blocker((p) => p === at(`n3${kind}/a/s1`)); // d1 is read and left first (sorted), the walk waits in the next folder
    try {
      const outer = s.scanRead(`/n3${kind}/a`, undefined, true);
      await b.reading;
      fs.writeFileSync(at(`n3${kind}/a/d1/new`), "n".repeat(50));
      const d = await within(s.scanRead(`/n3${kind}/a/d1`, undefined, true), 10_000, "the nested scan waited for the walk");
      assert.equal(d.res.bytes, 180);
      b.go();
      const a = await outer;
      assert.equal(a.res.bytes, 7 + 180 + 14);
      const top = await s.tree(`/n3${kind}/a`, 64, false);
      assert.ok(top.entries.some((e) => e.path === `/n3${kind}/a/d1` && e.bytes === 180), "the folder's row stays and is current");
      await agrees(s, `/n3${kind}/a`);
    } finally {
      b.restore();
    }
  });

  test(`${kind}: a scan of a folder the walk is in waits until the walk has left it`, async () => {
    tree(`n4${kind}`);
    const s = open();
    const b = blocker((p) => p === at(`n4${kind}/a/d1`)); // the walk is inside d1
    try {
      const outer = s.scanRead(`/n4${kind}/a`, undefined, true);
      await b.reading;
      let done = false;
      const d = s.scanRead(`/n4${kind}/a/d1`, undefined, true).then((x) => ((done = true), x));
      await sleep(150);
      assert.equal(done, false, "the walk is in the folder");
      b.go();
      const x = await within(d, 10_000, "the nested scan never started");
      assert.equal(x.res.bytes, 130);
      assert.equal((await outer).res.bytes, 7 + 130 + 14);
      await agrees(s, `/n4${kind}/a`);
    } finally {
      b.restore();
    }
  });

  test(`${kind}: a canceled waiter and a canceled walk leave no lock behind`, async () => {
    tree(`n7${kind}`);
    const s = open();
    const inner = blocker((p) => p === at(`n7${kind}/a/d1`));
    try {
      const outer = s.scanRead(`/n7${kind}/a`, undefined, true);
      await inner.reading;
      const ac = new AbortController();
      const waiter = s.lock(`/n7${kind}/a/d1`, ac.signal, false, { nest: true });
      await sleep(50);
      assert.ok(s.oldestLockWaitSeconds() >= 0);
      ac.abort();
      await assert.rejects(waiter, /canceled/);
      assert.equal((s as Any).held.length, 1, "only the walk is left");
      inner.go();
      await outer;
      assert.equal((s as Any).held.length, 0);
      assert.equal(s.oldestLockWaitSeconds(), 0);
    } finally {
      inner.restore();
    }
    // a walk that is canceled after a scan went beside it
    const root = blocker((p) => p === at(`n7${kind}/a`));
    try {
      const ac = new AbortController();
      const outer = s.scanRead(`/n7${kind}/a`, ctl(ac.signal), true);
      await root.reading;
      await within(s.scanRead(`/n7${kind}/a/d1`, undefined, true), 10_000, "the nested scan waited for the walk");
      ac.abort();
      root.go();
      await assert.rejects(outer, /canceled/);
      assert.equal((s as Any).held.length, 0);
      assert.equal(s.oldestLockWaitSeconds(), 0);
    } finally {
      root.restore();
    }
  });
  test(`${kind}: ahead through an ancestor: the walk is in a sibling when the scan is made, writes what it has first, and reads the scan's rows when it comes`, async () => {
    const n = `n12${kind}`;
    for (const [f, len] of [["a/a1/x", 3], ["a/b/c/f", 10], ["a/b/c/deep/g", 5], ["a/b/bf", 4], ["a/z/h", 6]] as const) {
      fs.mkdirSync(path.dirname(at(`${n}/${f}`)), { recursive: true });
      fs.writeFileSync(at(`${n}/${f}`), "x".repeat(len));
    }
    const s = open();
    const g = blocker((p) => p === at(`${n}/a/a1`)); // the walk has passed nothing else; it is in a1, with `a` open
    try {
      const since = Date.now();
      await sleep(5);
      const outer = s.scanRead(`/${n}/a`, undefined, since);
      await g.reading;
      fs.writeFileSync(at(`${n}/a/b/c/new`), "n".repeat(25));
      await within(s.scanRead(`/${n}/a/b/c`, undefined, true), 10_000, "the nested scan waited for the walk");
      const claim = (s as Any).held[0].claims[0];
      assert.ok(claim.at, "the walk had a folder open above the scan's folder when the scan came");
      assert.equal(claim.reached, false, "and had not come to it");
      g.go();
      const paths: string[] = [];
      await countReaddir(async () => assert.equal((await outer).res.bytes, 3 + 10 + 5 + 25 + 4 + 6), paths);
      assert.deepEqual(paths.filter((p) => p === at(`${n}/a/b/c`)), [], "the walk took the rows of the scan");
      await agrees(s, `/${n}/a`);
    } finally {
      g.restore();
    }
  });

  test(`${kind}: a scan in a scan in a walk: each change counts once`, async () => {
    const n = `n13${kind}`;
    tree(n);
    const s = open();
    const rootGate = blocker((p) => p === at(`${n}/a`));
    const d1Gate = blocker((p) => p === at(`${n}/a/d1`));
    try {
      const outer = s.scanRead(`/${n}/a`, undefined, true);
      await rootGate.reading;
      fs.writeFileSync(at(`${n}/a/d1/sub/new`), "n".repeat(20));
      const mid = s.scanRead(`/${n}/a/d1`, undefined, true);
      await d1Gate.reading; // the middle scan is in its folder
      const inner = await within(s.scanRead(`/${n}/a/d1/sub`, undefined, true), 10_000, "the inner scan waited");
      assert.equal(inner.res.bytes, 50);
      d1Gate.go();
      assert.equal((await within(mid, 10_000, "mid")).res.bytes, 150);
      rootGate.go();
      assert.equal((await within(outer, 10_000, "outer")).res.bytes, 7 + 150 + 14);
      await agrees(s, `/${n}/a`);
    } finally {
      d1Gate.restore();
      rootGate.restore();
    }
  });

  test(`${kind}: a scan that is canceled after a scan below it ended still hands that change on; the rows above the walk agree`, async () => {
    const n = `n9${kind}`;
    for (const [f, len] of [["a/b/c/f", 10], ["a/b/bf", 3], ["a/s1/h", 4], ["a/top", 2]] as const) {
      fs.mkdirSync(path.dirname(at(`${n}/${f}`)), { recursive: true });
      fs.writeFileSync(at(`${n}/${f}`), "x".repeat(len));
    }
    const s = open();
    await s.scan(`/${n}`); // a row above the walk's start folder
    const g1 = blocker((p) => p === at(`${n}/a/s1`)); // the walk has passed b
    let g2: ReturnType<typeof blocker> | undefined;
    try {
      const a1 = s.scanRead(`/${n}/a`, undefined, true);
      await g1.reading;
      g2 = blocker((p) => p === at(`${n}/a/b`));
      const ac = new AbortController();
      const a2 = s.scanRead(`/${n}/a/b`, ctl(ac.signal), true);
      a2.catch(() => undefined);
      await g2.reading;
      fs.writeFileSync(at(`${n}/a/b/c/new`), "n".repeat(40));
      await within(s.scanRead(`/${n}/a/b/c`, undefined, true), 10_000, "the nested scan waited");
      ac.abort();
      g2.go();
      await assert.rejects(a2, /canceled/);
      g1.go();
      await a1;
      await agrees(s, `/${n}`);
    } finally {
      g2?.restore();
      g1.restore();
    }
  });

  test(`${kind}: a folder deleted after the scan below the walk ended leaves no row and no wrong totals (ahead), and no row (passed)`, async () => {
    const n = `n10${kind}`;
    tree(n);
    const s = open();
    const g = blocker((p) => p === at(`${n}/a`));
    try {
      const outer = s.scanRead(`/${n}/a`, undefined, true);
      await g.reading;
      await within(s.scanRead(`/${n}/a/d1`, undefined, true), 10_000, "the nested scan waited");
      fs.rmSync(at(`${n}/a/d1`), { recursive: true });
      g.go();
      await outer;
      await agrees(s, `/${n}/a`);
      assert.ok(!(await s.tree(`/${n}/a`, 64, false)).entries.some((e) => e.path.startsWith(`/${n}/a/d1`)), "no row of the deleted folder");
    } finally {
      g.restore();
    }
    const m = `n10p${kind}`;
    tree(m);
    const g2 = blocker((p) => p === at(`${m}/a/s1`));
    try {
      const outer = s.scanRead(`/${m}/a`, undefined, true);
      await g2.reading;
      fs.writeFileSync(at(`${m}/a/d1/new`), "n".repeat(50));
      await within(s.scanRead(`/${m}/a/d1`, undefined, true), 10_000, "the nested scan waited");
      fs.rmSync(at(`${m}/a/d1`), { recursive: true });
      g2.go();
      await outer;
      assert.ok(!(await s.tree(`/${m}/a`, 64, false)).entries.some((e) => e.path.startsWith(`/${m}/a/d1`)), "no row of the deleted folder");
      assert.equal((s as Any).held.length, 0);
    } finally {
      g2.restore();
    }
  });
}

test("a scan below a walk that is finishing, and a lock that is not a scan, wait as before", async () => {
  tree("n8");
  const s = mk();
  // an ordinary lock above is waited for
  const plain = await s.lock("/n8/a");
  let got = false;
  const n = s.lock("/n8/a/d1", undefined, false, { nest: true }).then((r) => ((got = true), r));
  await sleep(50);
  assert.equal(got, false, "a lock that is not a scan lock is not a walk");
  plain();
  (await n)();
  // a scan lock that was granted is a walk: a scan below goes beside it, one above or at its folder waits
  const walk = await s.lock("/n8/a", undefined, false, { nest: true });
  const below = await within(s.lock("/n8/a/d1", undefined, false, { nest: true }), 5_000, "below");
  assert.equal(s.nested(below), true);
  assert.equal(s.nested(walk), false);
  let same = false;
  const e = s.lock("/n8/a", undefined, false, { nest: true }).then((r) => ((same = true), r));
  await sleep(50);
  assert.equal(same, false, "the same folder waits");
  below();
  walk();
  (await e)();
  assert.equal((s as Any).held.length, 0);
});

test("a walk that waits to go into the folder of an answer does not make the answer's lock wait, and is not held below that folder", async () => {
  tree("n14");
  const s = mk();
  const rootGate = blocker((p) => p === at("n14/a"));
  const dGate = blocker((p) => p === at("n14/a/d1"));
  try {
    const since = Date.now();
    await sleep(5);
    const outer = s.scanRead("/n14/a", undefined, since);
    await rootGate.reading;
    const d = s.scanRead("/n14/a/d1", undefined, true);
    await dGate.reading;
    const watch = s.watchAnswer("/n14/a/d1"); // the request for the answer is there already, the walk comes after
    rootGate.go();
    await sleep(100); // the walk waits for the scan at the folder
    dGate.go();
    await within(d, 10_000, "scan");
    const t0 = Date.now();
    const rel = await within(s.lock("/n14/a/d1", undefined, true, { nest: true }), 5_000, "the answer's lock waited for the walk that waits for the answer");
    watch.passed();
    rel();
    assert.ok(Date.now() - t0 < 2_000);
    assert.equal((await within(outer, 5_000, "the walk was held too long")).res.bytes, 7 + 130 + 14);
    watch.end();
    await agrees(s, "/n14/a");
  } finally {
    dGate.restore();
    rootGate.restore();
  }
  // a walk that is in the folder already is never held at a folder below it, whatever is watched
  tree("n15");
  const g = blocker((p) => p === at("n15/a/d1"));
  try {
    const outer = s.scanRead("/n15/a", undefined, true);
    await g.reading; // the walk is in d1
    const watch = s.watchAnswer("/n15/a/d1");
    const t0 = Date.now();
    g.go();
    assert.equal((await within(outer, 5_000, "the walk was held below the folder")).res.bytes, 7 + 130 + 14);
    assert.ok(Date.now() - t0 < 2_000);
    watch.end();
  } finally {
    g.restore();
  }
});

test("a folder deleted after the scan beside the walk ended marks only the folder the walk had open: the next scan reuses the rest", async () => {
  for (const [f, len] of [["a/m/d1/f", 3], ["a/m/s2/h", 4], ["a/z1/x", 5], ["a/z2/y", 6], ["a/z3/w", 7]] as const) {
    fs.mkdirSync(path.dirname(at(`n16/${f}`)), { recursive: true });
    fs.writeFileSync(at(`n16/${f}`), "x".repeat(len));
  }
  const s = mk();
  const g = blocker((p) => p === at("n16/a/m/s2")); // the walk has passed d1 and has `m` open
  try {
    const outer = s.scanRead("/n16/a", undefined, true);
    await g.reading;
    await within(s.scanRead("/n16/a/m/d1", undefined, true), 10_000, "the nested scan waited");
    fs.rmSync(at("n16/a/m/d1"), { recursive: true });
    g.go();
    await outer;
    const paths: string[] = [];
    await countReaddir(() => s.scanRead("/n16/a"), paths);
    assert.deepEqual(paths.filter((p) => !p.startsWith(at("n16/a/m"))), [], "only the folder that was open is read again");
    assert.ok(paths.includes(at("n16/a/m")));
  } finally {
    g.restore();
  }
});

test("a change that cannot be measured (a failed read) leaves the folder the walk had open marked stale, and takes nothing", async () => {
  for (const [f, len] of [["a/m/d1/f", 3], ["a/m/s2/h", 4], ["a/z1/x", 5]] as const) {
    fs.mkdirSync(path.dirname(at(`n17/${f}`)), { recursive: true });
    fs.writeFileSync(at(`n17/${f}`), "x".repeat(len));
  }
  const s = mk();
  const g = blocker((p) => p === at("n17/a/m/s2"));
  const orig = (s as Any).getKnown.bind(s);
  let reads = 0;
  (s as Any).getKnown = (p: string) => (p === "/n17/a/m/d1" && ++reads >= 2 ? Promise.resolve(null) : orig(p)); // the read after the scan fails
  try {
    const outer = s.scanRead("/n17/a", undefined, true);
    await g.reading;
    fs.writeFileSync(at("n17/a/m/d1/new"), "n".repeat(20));
    await within(s.scanRead("/n17/a/m/d1", undefined, true), 10_000, "the nested scan waited");
    assert.equal(reads, 2);
    g.go();
    await outer;
    assert.ok((s as Any).markAt("/n17/a/m") > 0, "the folder is marked stale");
    assert.equal((s as Any).markAt("/n17/a/z1"), 0, "the others are not");
  } finally {
    g.restore();
  }
});

test("a second scan of the folder a walk is held at (for an answer) waits for the walk to leave it, and each change counts once", async () => {
  tree("n18");
  const s = mk();
  const rootGate = blocker((p) => p === at("n18/a"));
  const dGate = blocker((p) => p === at("n18/a/d1"));
  try {
    const since = Date.now();
    await sleep(5);
    const outer = s.scanRead("/n18/a", undefined, since);
    await rootGate.reading;
    const first = s.scanRead("/n18/a/d1"); // not fresh, beside the walk, held in its folder
    await dGate.reading;
    const watch = s.watchAnswer("/n18/a/d1"); // the du --fresh request: it starts a scan of its own, which waits for the first
    const second = s.scanRead("/n18/a/d1", undefined, true);
    await sleep(50);
    rootGate.go(); // the walk comes to the folder and waits for the first scan
    await sleep(100);
    fs.writeFileSync(at("n18/a/d1/new"), "n".repeat(50));
    dGate.go();
    await within(first, 10_000, "first");
    await within(second, 10_000, "second");
    const x = await within(outer, 10_000, "the walk was held too long");
    assert.equal(x.res.bytes, 7 + 180 + 14);
    assert.equal((s as Any).held.length, 0);
    watch.end();
    await agrees(s, "/n18/a");
  } finally {
    dGate.restore();
    rootGate.restore();
  }
});

test("GET /api/du of a folder below a running size job answers at once, not stale, and the job goes on", async () => {
  const root = path.join(at("api"));
  fs.mkdirSync(path.join(root, "t/big/sub"), { recursive: true });
  fs.writeFileSync(path.join(root, "t/big/sub/f"), "abc");
  fs.writeFileSync(path.join(root, "t/big/top"), "12345");
  const b = blocker((p) => p === path.join(root, "t/big"));
  try {
    // one job slot: the nested scan can only run because its job is urgent
    const app = createAgent(loadConfig({ FILEDECK_ROOT: root, FILEDECK_NODE: "t", FILEDECK_DU_WAIT_MS: "5000", FILEDECK_JOB_CONCURRENCY: "1" } as never));
    const post = await app.request("/api/jobs/size", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: "/t/big", fresh: true }) });
    assert.equal(post.status, 202);
    const job = (await post.json()) as { id: string };
    await b.reading;
    const t0 = Date.now();
    const r = await within(Promise.resolve(app.request("/api/du?path=/t/big/sub&depth=1&fresh=1")), 15_000, "GET du waited for the walk");
    assert.equal(r.status, 200);
    const body = (await r.json()) as { entries: { path: string; bytes: number }[]; stale?: boolean };
    assert.ok(Date.now() - t0 < 4_000);
    assert.equal(body.stale, undefined, "not stale");
    assert.equal(body.entries.find((e) => e.path === "/t/big/sub")?.bytes, 3);
    assert.equal(((await (await app.request(`/api/jobs/${job.id}`)).json()) as { state: string }).state, "running", "the walk is still blocked");
    b.go();
    for (let i = 0; i < 200; i++) {
      const j = (await (await app.request(`/api/jobs/${job.id}`)).json()) as { state: string };
      if (j.state === "done") break;
      await sleep(25);
    }
    const big = (await (await app.request("/api/du?path=/t/big&depth=1")).json()) as { entries: { path: string; bytes: number }[] };
    assert.equal(big.entries.find((e) => e.path === "/t/big")?.bytes, 8);
  } finally {
    b.restore();
  }
});

test("a walk that opens a folder of a watched answer makes it stale; other opens, however many, do not", async () => {
  tree("n11");
  for (let i = 0; i < 300; i++) {
    fs.mkdirSync(at(`n11/a/x${String(i).padStart(3, "0")}`));
    fs.writeFileSync(at(`n11/a/x${String(i).padStart(3, "0")}/f`), "x");
  }
  const s = mk();
  const g = blocker((p) => p === at("n11/a"));
  try {
    const outer = s.scanRead("/n11/a", undefined, true);
    await g.reading;
    const mine = s.watchAnswer("/n11/a/d1"); // the walk will open this folder
    const other = s.watchAnswer("/n11/a/nothere"); // the walk opens 300 folders, none in this one
    const m1 = s.lockMark();
    const m2 = s.lockMark();
    const o1 = mine.opens();
    const o2 = other.opens();
    mine.passed();
    other.passed();
    assert.equal(s.lockedSince("/n11/a/d1", m1, { watch: mine, opens: o1 }), false, "a walk above that did not come yet is not a reason");
    g.go();
    await outer;
    assert.equal(s.lockedSince("/n11/a/d1", m1, { watch: mine, opens: o1 }), true, "it opened the folder");
    assert.equal(s.lockedSince("/n11/a/nothere", m2, { watch: other, opens: o2 }), false, "300 other folders do not overflow the record");
    mine.end();
    other.end();
  } finally {
    g.restore();
  }
});

test("GET /api/du fresh of a folder beside a walk that has passed on: the walk is held until the answer has its lock, so the answer is 200 and not stale", async () => {
  const root = at("api2");
  fs.mkdirSync(path.join(root, "t/big/a1"), { recursive: true });
  fs.mkdirSync(path.join(root, "t/big/sub"), { recursive: true });
  fs.writeFileSync(path.join(root, "t/big/a1/f"), "12");
  fs.writeFileSync(path.join(root, "t/big/sub/f"), "abc");
  const b = blocker((p) => p === path.join(root, "t/big/a1")); // the walk has `big` open and waits in a1: before sub
  const d = blocker((p) => p === path.join(root, "t/big/sub")); // the scan of sub is held in its folder
  try {
    const app = createAgent(loadConfig({ FILEDECK_ROOT: root, FILEDECK_NODE: "t", FILEDECK_DU_WAIT_MS: "8000", FILEDECK_JOB_CONCURRENCY: "1" } as never));
    const post = await app.request("/api/jobs/size", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: "/t/big", fresh: true }) });
    const job = (await post.json()) as { id: string };
    await b.reading;
    const get = Promise.resolve(app.request("/api/du?path=/t/big/sub&depth=1&fresh=1"));
    await d.reading;
    b.go(); // the walk goes on to sub and waits there for the scan
    await sleep(150);
    d.go(); // the scan ends: the walk goes into sub at once (it reuses the scan's rows), unless it is held until the answer is read
    const r = await within(get, 20_000, "GET du waited");
    assert.equal(r.status, 200);
    const body = (await r.json()) as { entries: { path: string; bytes: number }[]; stale?: boolean };
    assert.equal(body.stale, undefined, "not stale");
    assert.equal(body.entries.find((e) => e.path === "/t/big/sub")?.bytes, 3);
    for (let i = 0; i < 200; i++) {
      if (((await (await app.request(`/api/jobs/${job.id}`)).json()) as { state: string }).state === "done") break;
      await sleep(25);
    }
  } finally {
    d.restore();
    b.restore();
  }
});

test("jobs: an urgent gate starts the job past the concurrency limit", async () => {
  const jobs = new Jobs(1);
  let free!: () => void;
  const first = jobs.create("x", "one", () => new Promise<void>((r) => (free = r)));
  await sleep(10);
  const waits = jobs.create("x", "two", async () => 1);
  const urgent = jobs.create("x", "three", async () => 2, undefined, async () => ({ urgent: true }));
  await sleep(50);
  assert.equal(jobs.get(first.id)!.state, "running");
  assert.equal(jobs.get(waits.id)!.state, "queued", "an ordinary job waits for the slot");
  assert.equal(jobs.get(urgent.id)!.state, "done", "the urgent job did not");
  free();
  await sleep(50);
  assert.equal(jobs.get(waits.id)!.state, "done");
});

test("jobs: size jobs that run long stop taking slots, so a small one still starts (agent lanes)", async () => {
  const jobs = makeAgentJobs(loadConfig({ FILEDECK_ROOT: at("."), FILEDECK_NODE: "t", FILEDECK_JOB_CONCURRENCY: "2" } as never));
  const frees: (() => void)[] = [];
  const long = () => new Promise<void>((r) => frees.push(r));
  mock.timers.enable({ apis: ["Date"], now: Date.now() });
  try {
    jobs.create("size", "long 1", long);
    jobs.create("size", "long 2", long);
    const small = jobs.create("size", "small", async () => "ok");
    await sleep(100);
    assert.equal(jobs.get(small.id)!.state, "queued", "both slots are taken");
    mock.timers.tick(31_000); // the two size jobs have now run longer than BIG_SCAN_MS
    for (let i = 0; i < 40 && jobs.get(small.id)!.state === "queued"; i++) await sleep(100);
    assert.equal(jobs.get(small.id)!.state, "done", "a small job starts beside the long walks");
  } finally {
    mock.timers.reset();
    for (const f of frees) f();
  }
});
