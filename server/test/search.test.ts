import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createAgent } from "../src/agent.ts";
import { loadConfig } from "../src/config.ts";
import { compileGlobs } from "../src/glob.ts";
import * as searchMod from "../src/search.ts";
const { safeRegex, searchLimits } = searchMod;

let tmp: string, outside: string, agent: ReturnType<typeof createAgent>;
const write = (rel: string, data: string | Buffer) => {
  fs.mkdirSync(path.dirname(path.join(tmp, rel)), { recursive: true });
  fs.writeFileSync(path.join(tmp, rel), data);
};

before(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "filedeck-search-")));
  outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "filedeck-search-out-")));
  fs.writeFileSync(path.join(outside, "secret.txt"), "needle outside");
  write("s/Readme.md", "hello\nthe Needle is here\nbye\n");
  write("s/src/main.ts", "const a = 1;\n// needle two\n// needle three\n");
  write("s/src/deep/util.ts", "nothing");
  write("s/notes.txt", "x".repeat(100) + "\nneedle at line two\n");
  write("s/.hidden/h.txt", "needle hidden");
  write("s/bin.dat", Buffer.concat([Buffer.from([0, 1, 2]), Buffer.from("needle")]));
  write("s/big.txt", "needle " + "y".repeat(2000));
  fs.symlinkSync(outside, path.join(tmp, "s/out"));
  fs.symlinkSync(path.join(outside, "secret.txt"), path.join(tmp, "s/link.txt"));
  agent = createAgent(loadConfig({ FILEDECK_ROOT: tmp, FILEDECK_NODE: "t", FILEDECK_SEARCH_MAX_FILE: "1000" } as never));
});
after(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
});

interface Line {
  e?: { h: { p: string; t: string; l?: number; x?: string; n?: number }[]; sc: number };
  done?: { scanned: number; grepped: number; skipped: number; capped: boolean; truncated: boolean; depthLimited: boolean };
  error?: string;
}
async function search(qs: string) {
  const r = await agent.request("/api/fs/search?" + qs);
  if (r.status !== 200) return { status: r.status, hits: [], done: undefined };
  const lines = (await r.text()).trim().split("\n").map((l) => JSON.parse(l) as Line);
  return { status: 200, hits: lines.flatMap((l) => l.e?.h ?? []), done: lines.at(-1)?.done, lines };
}
const names = (h: { p: string }[]) => h.map((x) => x.p).sort();

test("name search: substring (case-insensitive by default), case-sensitive, types", async () => {
  assert.deepEqual(names((await search("path=/s&q=MAIN")).hits), ["src/main.ts"]);
  assert.deepEqual(names((await search("path=/s&q=MAIN&ic=0")).hits), []);
  assert.deepEqual(names((await search("path=/s&q=src&types=dir")).hits), ["src"]);
  assert.deepEqual(names((await search("path=/s&q=util&types=file")).hits), ["src/deep/util.ts"]);
  const r = await search("path=/s&q=e");
  assert.ok(r.done && r.done.scanned > 5);
});

test("glob and regex name search", async () => {
  assert.deepEqual(names((await search("path=/s&q=*.ts&mode=glob")).hits), ["src/deep/util.ts", "src/main.ts"]);
  assert.deepEqual(names((await search("path=/s&q=src/*.ts&mode=glob")).hits), ["src/main.ts"]);
  assert.deepEqual(names((await search("path=/s&q=" + encodeURIComponent("^(main|util)\\.ts$") + "&mode=regex")).hits), ["src/deep/util.ts", "src/main.ts"]);
  assert.equal((await search("path=/s&q=" + encodeURIComponent("(") + "&mode=regex")).status, 400);
  assert.equal((await search("path=/s&q=" + encodeURIComponent("(a+)+$") + "&mode=regex")).status, 400);
  assert.equal((await search("path=/s&q=" + encodeURIComponent("a".repeat(500)) + "&mode=regex")).status, 400);
  assert.throws(() => safeRegex("(x*)*", ""));
  assert.throws(() => safeRegex("(a)\\1", ""));
  assert.ok(safeRegex("^[a-z]+\\.(ts|js)$", "i").test("A.TS"));
});

test("content search: lines, counts, binary and oversized files skipped, hidden only on request", async () => {
  const r = await search("path=/s&content=needle");
  const by = Object.fromEntries(r.hits.map((h) => [h.p, h]));
  assert.deepEqual(names(r.hits), ["Readme.md", "notes.txt", "src/main.ts"]);
  assert.equal(by["Readme.md"]!.l, 2);
  assert.match(by["Readme.md"]!.x!, /Needle is here/);
  assert.equal(by["src/main.ts"]!.n, 2);
  assert.equal(by["notes.txt"]!.l, 2);
  assert.equal(r.done!.skipped, 2, "binary + oversized"); // bin.dat, big.txt (> 1000 bytes)
  assert.deepEqual(names((await search("path=/s&content=needle&hidden=1")).hits), [".hidden/h.txt", "Readme.md", "notes.txt", "src/main.ts"]);
  assert.deepEqual(names((await search("path=/s&content=NEEDLE&cic=0")).hits), []);
  assert.deepEqual(names((await search("path=/s&content=" + encodeURIComponent("needle \\w+$") + "&cre=1")).hits), ["src/main.ts"]);
  // name filter + content together
  assert.deepEqual(names((await search("path=/s&q=*.md&mode=glob&content=needle")).hits), ["Readme.md"]);
});

test("symlinks are never followed or read, and the walk stays under the start folder", async () => {
  const all = await search("path=/s&q=&types=file");
  assert.ok(names(all.hits).includes("link.txt"));
  const r = await search("path=/s&content=outside&hidden=1");
  assert.deepEqual(r.hits, []);
  assert.equal((await search("path=/../x&q=a")).status, 400);
  assert.equal((await search("path=/s/notes.txt&q=a")).status, 400);
  assert.equal((await search("path=/nope&q=a")).status, 404);
  assert.equal((await search("path=/s")).status, 400); // empty search
});

test("caps: result cap, entry cap, depth cap", async () => {
  const a = await search("path=/s&q=e&maxResults=2");
  assert.equal(a.hits.length, 2);
  assert.equal(a.done!.capped, true);
  const b = await search("path=/s&q=e&max=3");
  assert.equal(b.done!.truncated, true);
  const c = await search("path=/s&q=util&depth=2");
  assert.deepEqual(c.hits, []);
  assert.equal(c.done!.depthLimited, true);
});

test("total content byte budget ends the search early", async () => {
  const tiny = createAgent(loadConfig({ FILEDECK_ROOT: tmp, FILEDECK_NODE: "t", FILEDECK_SEARCH_MAX_BYTES: "60" } as never));
  const r = await tiny.request("/api/fs/search?path=/s&content=needle");
  const lines = (await r.text()).trim().split("\n").map((l) => JSON.parse(l) as Line);
  assert.equal(lines.at(-1)!.done!.capped, true);
});

test("a cancelled request stops the walk", async () => {
  for (let i = 0; i < 300; i++) write(`many/d${i % 10}/f${i}.txt`, "x");
  const ac = new AbortController();
  const r = await agent.request("/api/fs/search?path=/many&q=f", { signal: ac.signal });
  const reader = r.body!.getReader();
  await reader.read();
  ac.abort();
  await reader.cancel().catch(() => undefined);
  // a new search still works (the gate slot was released)
  assert.equal((await search("path=/many&q=f1")).status, 200);
});

test("concurrency gate answers 429 beyond the limit", async () => {
  const one = createAgent(loadConfig({ FILEDECK_ROOT: tmp, FILEDECK_NODE: "t", FILEDECK_SEARCH_CONCURRENCY: "1" } as never));
  const first = await one.request("/api/fs/search?path=/many&q=f");
  const rd = first.body!.getReader();
  await rd.read();
  const second = await one.request("/api/fs/search?path=/many&q=f");
  assert.equal(second.status, 429);
  await rd.cancel();
});

test("a glob that would backtrack badly is answered at once and does not hold up the agent", async () => {
  write("slow/" + "a".repeat(44), "x");
  const t0 = Date.now();
  const [r, health] = await Promise.all([search("path=/slow&q=" + encodeURIComponent("*a*a*a*a*a*a*a*a*b") + "&mode=glob"), agent.request("/healthz")]);
  assert.equal(r.status, 200);
  assert.deepEqual(r.hits, []);
  assert.equal(health.status, 200);
  assert.ok(Date.now() - t0 < 2500, `took ${Date.now() - t0} ms`);
  assert.equal(compileGlobs(["*a".repeat(30) + "*b"], false).test("a".repeat(200), false), false);
});

test("a regular expression the heuristics let through is cut off with a 400 instead of stalling the agent", async () => {
  write("slowre/" + "a".repeat(40), "x");
  const saved = searchLimits.regexTotalMs;
  searchLimits.regexTotalMs = 400;
  const t0 = Date.now();
  const r = await search("path=/slowre&q=" + encodeURIComponent("^(a|a)*b$") + "&mode=regex");
  const failed = r.status === 400 || (r.lines ?? []).some((l) => /too long/.test(l.error ?? ""));
  assert.ok(failed, `status ${r.status}`);
  assert.ok(Date.now() - t0 < 6000, `took ${Date.now() - t0} ms`);
  // content search: same limit, and a fast pattern still works on the same data
  write("slowre/c.txt", "a".repeat(40) + "\nneedle\n");
  const c = await search("path=/slowre&q=c.txt&content=" + encodeURIComponent("^(a|a)*b$") + "&cre=1");
  assert.ok(c.status === 400 || (c.lines ?? []).some((l) => /too long/.test(l.error ?? "")), `content status ${c.status}`);
  const ok = await search("path=/slowre&q=c.txt&content=" + encodeURIComponent("^nee+dle$") + "&cre=1");
  assert.deepEqual(names(ok.hits), ["c.txt"]);
  searchLimits.regexTotalMs = saved;
});

test("makeTester runs a slow pattern in a worker, cuts it off at the budget and still matches fast ones", async () => {
  const slow = searchMod.makeTester("^(a|a)*b$", true, false, { leftMs: 150 });
  await assert.rejects(slow.testMany(["a".repeat(60)]), /too long/);
  slow.close();
  const fast = searchMod.makeTester("^(x|y)+$", true, false);
  assert.deepEqual(await fast.testMany(["xyxy", "xz"]), [true, false]);
  fast.close();
});

/** Largest delay seen by a /healthz request made every 10 ms while `work` runs. */
async function healthWhile<T>(work: Promise<T>): Promise<{ result: T; worst: number }> {
  let worst = 0;
  let done = false;
  const pinger = (async () => {
    while (!done) {
      const t = performance.now();
      await agent.request("/healthz");
      worst = Math.max(worst, performance.now() - t);
      await new Promise((r) => setTimeout(r, 10));
    }
  })();
  try {
    const result = await work;
    return { result, worst };
  } finally {
    done = true;
    await pinger;
  }
}

test("a slow regular expression runs off the event loop and is cut off at a total deadline for the whole search", async () => {
  write("slowre2/" + "a".repeat(40), "x");
  const saved = searchLimits.regexTotalMs;
  searchLimits.regexTotalMs = 1200;
  try {
    const t0 = performance.now();
    const { result: r, worst } = await healthWhile(search("path=/slowre2&q=" + encodeURIComponent("^(a|a)*b$") + "&mode=regex"));
    assert.ok(r.status === 400 || (r.lines ?? []).some((l) => /too long/.test(l.error ?? "")), `status ${r.status}`);
    assert.ok(performance.now() - t0 < 6000, `took ${performance.now() - t0} ms`);
    assert.ok(worst < 400, `the event loop was blocked for ${Math.round(worst)} ms`);
    // many chunks, each costing some time: the deadline is for the whole search, not for each chunk.
    // One line costs about `cost` ms to match here; the budget is 2.5 times that, and the file has 8 chunks with such a line.
    const re = /^(a|a)*b$/;
    let n = 16;
    let cost = 0;
    while (cost < 80 && n < 34) {
      n++;
      const t = performance.now();
      re.test("a".repeat(n));
      cost = performance.now() - t;
    }
    const slowLine = "a".repeat(n) + "\n";
    let block = slowLine;
    while (block.length + 100 <= 65536) block += "x".repeat(99) + "\n";
    write("slowre2/chunks.txt", block.padEnd(65536, "y").repeat(8));
    searchLimits.regexTotalMs = Math.max(300, cost * 2.5);
    const t1 = performance.now();
    const big = createAgent(loadConfig({ FILEDECK_ROOT: tmp, FILEDECK_NODE: "t" } as never)); // the shared agent skips files over 1000 bytes
    const { result: c, worst: w2 } = await healthWhile(
      (async () => {
        const r = await big.request("/api/fs/search?path=/slowre2&q=chunks&content=" + encodeURIComponent("^(a|a)*b$") + "&cre=1");
        const lines = (await r.text()).trim().split("\n").map((l) => JSON.parse(l) as Line);
        return { status: r.status, lines };
      })(),
    );
    assert.ok(c.status === 400 || (c.lines ?? []).some((l) => /too long/.test(l.error ?? "")), `content status ${c.status}`);
    assert.ok(performance.now() - t1 < 6000, `took ${performance.now() - t1} ms`);
    assert.ok(w2 < 400, `the event loop was blocked for ${Math.round(w2)} ms`);
  } finally {
    searchLimits.regexTotalMs = saved;
  }
});

test("regular-expression searches are bounded in number, and a cancelled request releases its worker", async () => {
  write("slowre3/" + "a".repeat(40), "x");
  const saved = searchLimits.regexTotalMs;
  searchLimits.regexTotalMs = 30_000;
  const url = "/api/fs/search?path=/slowre3&mode=regex&q=" + encodeURIComponent("^(a|a)*b$");
  const ctls = Array.from({ length: searchLimits.maxWorkers }, () => new AbortController());
  try {
    const running = ctls.map((c) => Promise.resolve(agent.request(url, { signal: c.signal })).then((r) => r.text(), () => ""));
    await new Promise((r) => setTimeout(r, 300));
    const extra = await agent.request(url);
    assert.equal(extra.status, 429);
    ctls.forEach((c) => c.abort());
    await Promise.all(running);
    await new Promise((r) => setTimeout(r, 300));
    const again = await agent.request("/api/fs/search?path=/s&mode=regex&q=" + encodeURIComponent("^main\\.ts$"));
    assert.equal(again.status, 200);
    await again.text();
  } finally {
    ctls.forEach((c) => c.abort());
    searchLimits.regexTotalMs = saved;
  }
});

test("a glob matcher with too many expanded alternatives is refused with a 400, and ordinary excludes are fast", async () => {
  const braces = "{a,b}{a,b}{a,b}{a,b}{a,b}{a,b}";
  const qs = Array.from({ length: 100 }, (_, i) => "exclude=" + encodeURIComponent(braces + "**?".repeat(20) + "z" + i)).join("&");
  const t0 = performance.now();
  const r = await agent.request("/api/fs/walk?path=/s&" + qs);
  await r.text();
  assert.equal(r.status, 400);
  assert.ok(performance.now() - t0 < 1500);
  assert.throws(() => compileGlobs(Array.from({ length: 100 }, (_, i) => `{a,b}{c,d}{e,f}x${i}`), false), /too large/);
  // ordinary patterns stay cheap: 100,000 paths against six common excludes
  const m = compileGlobs(["*.log", "node_modules/", ".git/", "*.tmp", "build", "*.{png,jpg}"], false);
  const paths = Array.from({ length: 100_000 }, (_, i) => `src/pkg${i % 50}/dir${i % 7}/file${i}.${["ts", "js", "md", "log", "png"][i % 5]}`);
  const t1 = performance.now();
  let n = 0;
  for (const p of paths) if (m.test(p, false)) n++;
  assert.equal(n, 40_000);
  assert.ok(performance.now() - t1 < 1000, `matching took ${Math.round(performance.now() - t1)} ms`);
});

test("timeSlicer gives the event loop a turn once a loop has run for a slice", async () => {
  const { timeSlicer } = await import("../src/glob.ts");
  const tick = timeSlicer(5);
  assert.equal(tick(), null);
  const end = performance.now() + 12;
  while (performance.now() < end);
  const w = tick();
  assert.ok(w);
  await w;
  assert.equal(tick(), null);
});

test("content search reads across 64 KiB chunk boundaries: split characters and split words are found", async () => {
  const big = createAgent(loadConfig({ FILEDECK_ROOT: tmp, FILEDECK_NODE: "t" } as never));
  const head = "a".repeat(99) + "\n";
  const lead = head.repeat(655); // 65500 bytes
  // bytes 65535 and 65536 are the two bytes of the "\u00e9": the first read ends in the middle of the character
  write("chunk/split-char.txt", lead + "b".repeat(35) + "\u00e9 marker\nend\n");
  // "needle" starts 3 bytes before the boundary
  write("chunk/split-word.txt", lead + "b".repeat(33) + "needle tail\nend\n");
  // a long line that begins well before the boundary and runs past it: a match near its start must still be found
  write("chunk/long-line.txt", head.repeat(600) + "needle start " + "z".repeat(6000) + "\nend\n");
  const run = async (q: string) => {
    const r = await big.request("/api/fs/search?path=/chunk&" + q);
    const lines = (await r.text()).trim().split("\n").map((l) => JSON.parse(l) as Line);
    return lines.flatMap((l) => l.e?.h ?? []);
  };
  const c = await run("content=" + encodeURIComponent("\u00e9 marker"));
  assert.deepEqual(names(c), ["split-char.txt"]);
  assert.equal(c[0]!.l, 656);
  assert.deepEqual(names(await run("content=needle")), ["long-line.txt", "split-word.txt"]);
  assert.deepEqual(names(await run("content=" + encodeURIComponent("b+needle") + "&cre=1")), ["split-word.txt"]);
  const ll = (await run("content=needle")).find((h) => h.p === "long-line.txt")!;
  assert.equal(ll.l, 601);
  assert.ok(!(c[0]!.x ?? "").includes("\ufffd"));
});

/** The previous implementation (a regular expression per glob), kept here as the reference for the semantics. */
function refGlob(g: string, ic: boolean): RegExp {
  let re = "";
  for (let i = 0; i < g.length; i++) {
    const c = g[i] as string;
    if (c === "*") {
      if (g[i + 1] === "*") {
        while (g[i + 1] === "*") i++;
        if (g[i + 1] === "/") (i++, (re += "(?:.*/)?"));
        else re += ".*";
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else if (c === "[") {
      const end = g.indexOf("]", i + 2);
      if (end < 0) re += "\\[";
      else {
        let body = g.slice(i + 1, end);
        const neg = body[0] === "!" || body[0] === "^";
        if (neg) body = body.slice(1);
        re += "[" + (neg ? "^" : "") + body.replace(/[\\\]^]/g, "\\$&") + "]";
        i = end;
      }
    } else re += c.replace(/[.+^${}()|\\/]/g, "\\$&");
  }
  return new RegExp("^" + re + "$", ic ? "i" : "");
}

test("linear-time glob matcher agrees with the regular-expression semantics it replaced", () => {
  let seed = 12345;
  const rnd = (n: number) => ((seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff), (seed >>> 8) % n);
  const pat = ["a", "b", "A", "/", ".", "*", "**", "?", "[ab]", "[!a]", "[a-c]", "[^b]", "**/", "-"];
  const txt = ["a", "b", "A", "B", "c", "/", ".", "-"];
  const distinct = new Set<string>();
  for (let n = 0; n < 6000; n++) {
    const g = Array.from({ length: 1 + rnd(6) }, () => pat[rnd(pat.length)]).join("");
    const text = Array.from({ length: rnd(9) }, () => txt[rnd(txt.length)]).join("");
    distinct.add(`${g}\0${text}`);
    for (const ic of [false, true]) {
      // a leading "/" or a trailing "/" has a meaning of its own (anchoring, directories only): compare full-path rules only
      if (g.startsWith("/") || g.endsWith("/") || !g.includes("/")) continue;
      assert.equal(compileGlobs([g], ic).test(text, true), refGlob(g, ic).test(text), `${g} vs ${text} (ic=${ic})`);
    }
    if (!g.includes("/")) {
      const base = text.slice(text.lastIndexOf("/") + 1);
      assert.equal(compileGlobs([g], false).test(text, true), refGlob(g, false).test(base), `${g} vs ${text}`);
    }
  }
  assert.ok(distinct.size > 5000, `only ${distinct.size} distinct cases`);
});
