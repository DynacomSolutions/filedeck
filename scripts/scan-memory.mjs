// Memory check of a big du: an agent (in this process) scans a test tree through GET /api/du, then streams the whole answer, while the process
// RSS is sampled once a second. Run it under a memory cap with scripts/scan-memory-check.sh; it fails when RSS grows with the number of entries.
//
// usage: node --import tsx scripts/scan-memory.mts <work-dir> [folders=50000] [files-per-folder=60]
//   <work-dir>/tree   the test tree (built once: folders a0000/b0000/c000 with empty and 12-byte files; kept for the next run)
//   <work-dir>/index  the agent's size store (kept: a second run after a kill shows the resume)
import fs from "node:fs";
import path from "node:path";
// the built agent (npm run build -w server), as it runs in the image
import { createAgent } from "../server/dist/agent.js";
import { loadConfig } from "../server/dist/config.js";

const [work, foldersArg = "50000", filesArg = "60"] = process.argv.slice(2);
if (!work) {
  console.error("usage: scan-memory.ts <work-dir> [folders] [files-per-folder]");
  process.exit(2);
}
const folders = Number(foldersArg);
const files = Number(filesArg);
const tree = path.join(work, "tree");
const index = path.join(work, "index");
fs.mkdirSync(index, { recursive: true });

const rssMiB = () => Math.round(process.memoryUsage().rss / 1048576);
/** anonymous memory (heap, SQLite caches, buffers): what grows when something is kept; RSS also counts the mapped node binary and libraries */
const anonMiB = () => Math.round(Number(/RssAnon:\s+(\d+)/.exec(fs.readFileSync("/proc/self/status", "utf8"))?.[1] ?? 0) / 1024);

// --- build the tree once: A x B x C folders, `files` files each ---
const done = path.join(work, `tree-${folders}x${files}.done`);
if (!fs.existsSync(done)) {
  fs.rmSync(tree, { recursive: true, force: true });
  const c = 25;
  const b = 40;
  const a = Math.ceil(folders / (b * c));
  const t0 = Date.now();
  let made = 0;
  for (let i = 0; i < a && made < folders; i++)
    for (let j = 0; j < b && made < folders; j++)
      for (let k = 0; k < c && made < folders; k++, made++) {
        const d = path.join(tree, `a${String(i).padStart(4, "0")}`, `b${String(j).padStart(4, "0")}`, `c${String(k).padStart(3, "0")}`);
        fs.mkdirSync(d, { recursive: true });
        for (let f = 0; f < files; f++) {
          const fd = fs.openSync(path.join(d, `file-with-a-longish-name-${String(f).padStart(5, "0")}.dat`), "w");
          if (f % 10 === 0) fs.writeSync(fd, "hello world\n");
          fs.closeSync(fd);
        }
        if (made % 5000 === 0) console.log(`building: ${made} folders, ${made * files} files, ${Math.round((Date.now() - t0) / 1000)} s`);
      }
  fs.writeFileSync(done, "");
}
const expected = folders * files;
console.log(`tree: ${folders} folders x ${files} files = ${expected} files`);

// --- the agent and the scan ---
const app = createAgent(loadConfig({ FILEDECK_ROOT: work, FILEDECK_NODE: "mem", FILEDECK_INDEX_DIR: index, FILEDECK_DU_WAIT_MS: "0", FILEDECK_INDEX_REVALIDATE_MS: "1" }));
const samples = [];
/** the memory cgroup of this process (the cap): what the kernel charges to it besides the process (file cache, dentries and inodes) */
const cgDir = (() => {
  try {
    return "/sys/fs/cgroup" + fs.readFileSync("/proc/self/cgroup", "utf8").trim().split(":").pop();
  } catch {
    return "";
  }
})();
const cgroup = () => {
  try {
    const st = Object.fromEntries(fs.readFileSync(cgDir + "/memory.stat", "utf8").trim().split("\n").map((l) => l.split(" ")));
    const mib = (k) => Math.round(Number(st[k] ?? 0) / 1048576);
    const ev = fs.readFileSync(cgDir + "/memory.events", "utf8").replace(/\n/g, " ").trim();
    return ` cgroup=${mib("anon") + mib("file") + mib("kernel")}MiB (anon ${mib("anon")} file ${mib("file")} slab ${mib("slab")} dirty ${mib("file_dirty")}) [${ev}]`;
  } catch {
    return "";
  }
};
let phase = "scan";
let entries = 0;
const t0 = Date.now();
const timer = setInterval(() => {
  const x = { s: Math.round((Date.now() - t0) / 1000), phase, rss: rssMiB(), anon: anonMiB(), entries };
  samples.push(x);
  console.log(`${x.s}s ${x.phase} entries=${x.entries} rss=${x.rss}MiB anon=${x.anon}MiB${cgroup()}`);
}, 1000);

const url = "/api/du?path=/tree&depth=64";
let r = await app.request(url);
if (r.status === 202) {
  const { jobId } = await r.json();
  for (;;) {
    const j = await (await app.request(`/api/jobs/${jobId}`)).json();
    entries = j.progress?.entries ?? entries;
    if (j.state === "done") {
      console.log(`scan done: ${j.result?.read ?? "?"} folders read from disk`);
      break;
    }
    if (j.state === "failed" || j.state === "canceled") throw new Error(`scan ${j.state}: ${j.error}`);
    await new Promise((res) => setTimeout(res, 1000));
  }
  r = await app.request(url);
}
if (r.status !== 200) throw new Error(`du answered ${r.status}`);

// --- the answer, streamed: counted as it arrives, never kept ---
phase = "answer";
let bytes = 0;
let lines = 0;
const reader = r.body.getReader();
const dec = new TextDecoder();
let tail = "";
for (;;) {
  const { value, done: end } = await reader.read();
  if (end) break;
  bytes += value.length;
  const text = tail + dec.decode(value, { stream: true });
  lines += (text.match(/"path":/g) ?? []).length;
  tail = text.slice(-16);
  entries = lines;
}
clearInterval(timer);
console.log(`answer: ${(bytes / 1048576).toFixed(1)} MiB of JSON, about ${lines - 1} entries; trailer ${JSON.stringify(tail)}`);

// --- verdict: RSS after the first quarter of the scan must stay within a small band whatever the entry count ---
const scan = samples.filter((x) => x.phase === "scan");
const settled = scan.slice(Math.floor(scan.length / 4));
const base = settled.length ? Math.min(...settled.map((x) => x.rss)) : rssMiB();
const peak = Math.max(...samples.map((x) => x.rss));
const later = samples.slice(samples.indexOf(settled[0] ?? samples[0]));
const growth = Math.max(...later.map((x) => x.rss)) - base;
const anonBase = settled.length ? Math.min(...settled.map((x) => x.anon)) : anonMiB();
const anonGrowth = Math.max(...later.map((x) => x.anon)) - anonBase;
console.log(`RSS: peak ${peak} MiB; after the first quarter of the scan it stayed within ${growth} MiB of ${base} MiB (scan and answer); anonymous within ${anonGrowth} MiB of ${anonBase} MiB`);
await app.close();
const limit = Number(process.env.SCAN_MEMORY_MAX_GROWTH_MIB ?? 48);
if (growth > limit) {
  console.error(`FAIL: RSS grew by ${growth} MiB (limit ${limit})`);
  process.exit(1);
}
console.log("OK");
process.exit(0);
