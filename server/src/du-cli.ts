/** `filedeck du`: GNU du look-alike on top of the hub's `GET /api/nodes/<node>/api/du` (see props.ts for the 202 + job polling contract). */

export interface DuOptions {
  summarize: boolean;
  human: boolean;
  depth: number | undefined;
  all: boolean;
  apparent: boolean;
  fresh: boolean;
  json: boolean;
  /** Only answer from stored sizes (`cachedOnly=1`): never starts a scan. */
  cached: boolean;
  /** Seconds in total; 0 follows a live job with no cap. */
  timeout: number;
  targets: { node: string; path: string }[];
}

/** Default cap in seconds for following a scan; `--timeout 0` removes it. */
export const DEFAULT_TIMEOUT = 600;

export const USAGE = `usage: filedeck du [-s] [-h] [-d N] [-a] [--apparent-size] [--fresh | --cached] [--json] [--timeout SECONDS] node:/path...
  -s, --summarize     only a total for each argument (same as -d 0)
  -h, --human-readable  sizes like 1.5K, 23M
  -d, --max-depth=N   print entries only N or fewer levels below the argument (0 to 64)
  -a, --all           also print files
      --apparent-size print apparent sizes (bytes) instead of disk usage
      --fresh         re-read every folder instead of reusing stored sizes
      --cached        answer from stored sizes only; never starts a scan (reports folders that are not stored)
      --json          print the hub's answer as JSON
      --timeout SECONDS  give up after this long in total (default: 600; 0 follows a live job until it ends)
environment: FILEDECK_URL (hub base URL), FILEDECK_TOKEN (read-only API token)`;

export class UsageError extends Error {}

export function parseArgs(argv: string[]): DuOptions {
  const o: DuOptions = { summarize: false, human: false, depth: undefined, all: false, apparent: false, fresh: false, cached: false, json: false, timeout: DEFAULT_TIMEOUT, targets: [] };
  const depth = (v: string | undefined) => {
    if (v === undefined || !/^\d+$/.test(v)) throw new UsageError(`invalid maximum depth '${v ?? ""}'`);
    return Number(v);
  };
  let rest = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (rest || a === "-" || !a.startsWith("-")) {
      const k = a.indexOf(":/");
      if (k < 1) throw new UsageError(`'${a}' is not node:/path`);
      o.targets.push({ node: a.slice(0, k), path: a.slice(k + 1) });
    } else if (a === "--") rest = true;
    else if (a.startsWith("--")) {
      const [name, val] = a.includes("=") ? [a.slice(0, a.indexOf("=")), a.slice(a.indexOf("=") + 1)] : [a, undefined];
      if (name === "--summarize") o.summarize = true;
      else if (name === "--human-readable") o.human = true;
      else if (name === "--all") o.all = true;
      else if (name === "--apparent-size") o.apparent = true;
      else if (name === "--fresh") o.fresh = true;
      else if (name === "--cached") o.cached = true;
      else if (name === "--json") o.json = true;
      else if (name === "--timeout") {
        const v = val ?? argv[++i];
        if (v === undefined || !/^\d+$/.test(v)) throw new UsageError(`invalid timeout '${v ?? ""}'`);
        o.timeout = Number(v);
      } else if (name === "--max-depth") o.depth = depth(val ?? argv[++i]);
      else throw new UsageError(`unrecognized option '${a}'`);
    } else {
      for (let j = 1; j < a.length; j++) {
        const f = a[j];
        if (f === "s") o.summarize = true;
        else if (f === "h") o.human = true;
        else if (f === "a") o.all = true;
        else if (f === "d") {
          o.depth = depth(a.slice(j + 1) || argv[++i]);
          break;
        } else throw new UsageError(`invalid option -- '${f}'`);
      }
    }
  }
  if (!o.targets.length) throw new UsageError("missing node:/path operand");
  if (o.summarize && o.depth !== undefined && o.depth !== 0) throw new UsageError("summarizing conflicts with --max-depth=" + o.depth);
  if (o.cached && o.fresh) throw new UsageError("--cached conflicts with --fresh");
  if (o.summarize) o.depth = 0;
  if (o.depth !== undefined && o.depth > 64) throw new UsageError("maximum depth is 64");
  return o;
}

/** GNU du -h: powers of 1024, rounded up, one decimal below 10, no suffix below 1024. */
export function humanSize(bytes: number): string {
  if (bytes < 1024) return String(bytes);
  let v = bytes;
  let u = 0;
  const units = "KMGTPEZY";
  while (v >= 1024 && u < units.length) {
    v /= 1024;
    u++;
  }
  // ceil to the precision shown, then carry when rounding reaches 1024 (or 10.0 -> 10)
  let s = v < 10 ? Math.ceil(v * 10) / 10 : Math.ceil(v);
  if (s >= 1024 && u < units.length) {
    s = 1;
    u++;
  }
  return (s < 10 && Number.isInteger(s) ? s.toFixed(1) : String(s)) + units[u - 1];
}

/** Default du unit: 1 KiB blocks, rounded up. */
export const blocks = (bytes: number) => Math.ceil(bytes / 1024);

export interface DuEntryJson {
  path: string;
  type: string;
  bytes: number;
  diskBytes: number;
  scannedAt?: number;
}
export interface DuAnswer {
  path: string;
  entries: DuEntryJson[];
  cached: boolean;
  truncated: boolean;
  watched: boolean;
  /**
   * the rows may be out of date: another process is writing the store (a rolling deploy) or a scan of an overlapping folder is running (no job was started),
   * the walk reused rows on their age while the change watcher was running, or a change was reported after the scan
   */
  stale?: boolean;
}

/** The API lists folders level by level; du lists children before their parent, in path order. */
export function postOrder(entries: DuEntryJson[]): DuEntryJson[] {
  const seg = (p: string) => p.split("/").filter(Boolean);
  const sorted = entries.map((e) => ({ e, s: seg(e.path) })).sort((a, b) => {
    for (let i = 0; i < Math.min(a.s.length, b.s.length); i++) if (a.s[i] !== b.s[i]) return (a.s[i] as string) < (b.s[i] as string) ? -1 : 1;
    return a.s.length - b.s.length;
  });
  const out: DuEntryJson[] = [];
  const open: { e: DuEntryJson; s: string[] }[] = [];
  const closeTo = (s: string[]) => {
    while (open.length && !(s.length > open.at(-1)!.s.length && open.at(-1)!.s.every((x, i) => x === s[i]))) out.push(open.pop()!.e);
  };
  for (const x of sorted) {
    closeTo(x.s);
    if (x.e.type === "dir") open.push(x);
    else out.push(x.e);
  }
  closeTo([]);
  return out;
}

export function formatLines(node: string, ans: DuAnswer, o: Pick<DuOptions, "human" | "apparent">): string[] {
  return postOrder(ans.entries).map((e) => {
    const b = o.apparent ? e.bytes : e.diskBytes;
    return `${o.human ? humanSize(b) : blocks(b)}\t${node}:${e.path}`;
  });
}

export interface RunIo {
  fetch: typeof fetch;
  out: (s: string) => void;
  err: (s: string) => void;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  /** Aborted on Ctrl-C. */
  signal?: AbortSignal;
}

interface Job {
  state: string;
  error?: string;
  progress?: { entries: number; totalEntries: number; bytes: number; current: string };
}

class Transient extends Error {}
class Interrupted extends Error {}

export async function run(argv: string[], env: Record<string, string | undefined>, io: RunIo): Promise<number> {
  let o: DuOptions;
  if (argv.includes("--help")) {
    io.out(USAGE + "\n");
    return 0;
  }
  try {
    o = parseArgs(argv);
  } catch (e) {
    io.err(`filedeck du: ${(e as Error).message}\n${USAGE}\n`);
    return 2;
  }
  const base = env.FILEDECK_URL?.replace(/\/+$/, "");
  const token = env.FILEDECK_TOKEN;
  if (!base || !token) {
    io.err("filedeck du: set FILEDECK_URL and FILEDECK_TOKEN\n");
    return 2;
  }
  const headers = { "x-filedeck-token": token };
  const deadline = o.timeout === 0 ? Infinity : io.now() + o.timeout * 1000;
  const stopIfAsked = () => {
    if (io.signal?.aborted) throw new Interrupted();
  };
  const get = async (url: string) => {
    let r: Response;
    try {
      r = await io.fetch(url, { headers, redirect: "manual", signal: AbortSignal.any([...(io.signal ? [io.signal] : []), ...(deadline === Infinity ? [] : [AbortSignal.timeout(Math.max(1, deadline - io.now()))])]) });
    } catch (e) {
      stopIfAsked();
      throw new Transient(`cannot reach ${base}: ${(e as Error).message}`);
    }
    if (r.status === 401) throw new Error("the hub rejected FILEDECK_TOKEN (401)");
    if (r.status === 403) throw new Error("the hub refused the request (403)");
    return r;
  };
  // Waits through 502/503/504 and network errors (backoff 1 s to 15 s) until the deadline; one notice per streak.
  // With lostOk, a 404 is returned to the caller instead (the job is gone).
  let answered = false; // per target: the hub has given a non-transient answer
  const patient = async (url: string, label: string, lostOk = false): Promise<Response> => {
    let wait = 1000;
    let last = "";
    let plain = "";
    for (let said = false, n = 1; ; said = true, n++) {
      try {
        const r = await get(url);
        if (![502, 503, 504].includes(r.status)) {
          answered = true;
          return r;
        }
        last = `hub answered HTTP ${r.status}`;
        plain = `HTTP ${r.status}: ${r.statusText}`;
      } catch (e) {
        if (!(e instanceof Transient)) throw e;
        last = plain = e.message;
      }
      // A wrong URL or a dead hub must not hang for the whole timeout: patience starts with the first real answer.
      if (!answered && n >= 3) throw new Error(plain);
      stopIfAsked();
      if (io.now() >= deadline) throw new Error(`timed out after ${o.timeout} s (${last})`);
      if (!said) io.err(`filedeck du: ${label}: ${last}, retrying\n`);
      await io.sleep(wait);
      stopIfAsked();
      wait = Math.min(wait * 2, 15000);
    }
  };
  let status = 0;
  for (const t of o.targets) {
    const label = `${t.node}:${t.path}`;
    answered = false;
    let jobId = "";
    let running = false; // a job of ours may still be running on the server
    const api = `${base}/api/nodes/${encodeURIComponent(t.node)}/api`;
    const q = new URLSearchParams({ path: t.path });
    if (o.depth !== undefined) q.set("depth", String(o.depth));
    else q.set("depth", "64");
    if (o.all) q.set("all", "1");
    if (o.fresh) q.set("fresh", "1");
    if (o.cached) q.set("cachedOnly", "1");
    const url = `${api}/du?${q}`;
    try {
      let polled = false;
      let r = await patient(url, label);
      if (o.cached && r.status === 204) {
        io.err(`filedeck du: ${label}: not stored yet; run without --cached to scan it\n`);
        status = 1;
        continue;
      }
      let rejoined = false;
      while (r.status === 202) {
        polled = true;
        jobId = ((await r.json()) as { jobId: string }).jobId;
        running = true;
        let lost = false;
        for (;;) {
          stopIfAsked();
          if (io.now() > deadline) throw new Error(`timed out after ${o.timeout} s`);
          const jr = await patient(`${api}/jobs/${encodeURIComponent(jobId)}`, label);
          if (jr.status === 404 && !rejoined) {
            // Job lost (agent restart): the same request starts or joins a scan.
            rejoined = true;
            io.err(`filedeck du: ${label}: job lost, asking for the scan again\n`);
            r = await patient(url, label);
            lost = true;
            break;
          }
          rejoined = false;
          if (!jr.ok) throw new Error(`job ${jobId}: HTTP ${jr.status}`);
          const j = (await jr.json()) as Job;
          if (j.state === "done") break;
          if (j.state === "failed" || j.state === "canceled") running = false;
          if (j.state === "failed" || j.state === "canceled") throw new Error(`scan ${j.state}${j.error ? `: ${j.error}` : ""}`);
          const p = j.progress;
          io.err(`filedeck du: ${label}: ${j.state}${p ? `, ${p.entries} entries, ${humanSize(p.bytes)}` : ""}\n`);
          await io.sleep(1000);
        }
        if (lost) continue;
        running = false;
        r = await patient(url, label); // for a minute the repeat is answered from the scan that just finished
      }
      if (!r.ok) {
        const msg = ((await r.json().catch(() => null)) as { error?: string } | null)?.error ?? r.statusText;
        throw new Error(`HTTP ${r.status}: ${msg}`);
      }
      const ans = (await r.json()) as DuAnswer;
      if (o.json) io.out(JSON.stringify({ node: t.node, ...ans }) + "\n");
      else for (const l of formatLines(t.node, ans, o)) io.out(l + "\n");
      if (ans.truncated) io.err(`filedeck du: ${label}: scan hit the entry limit, sizes are partial\n`);
      if (ans.stale) io.err(`filedeck du: ${label}: sizes may be out of date (another scan or a deploy is running, or rows older than the change watcher were reused); run the command again in a moment, or use --fresh to re-read\n`);
      // A repeat after our own job is cached by contract, but that scan just ran: only say so when nobody scanned for us.
      if (ans.cached && !polled) {
        const oldest = Math.min(...ans.entries.map((e) => e.scannedAt ?? Infinity));
        const age = Number.isFinite(oldest) ? ` (oldest folder scanned ${Math.max(0, Math.round((io.now() - oldest) / 60000))} min ago)` : "";
        io.err(`filedeck du: ${label}: answered from stored sizes${age}${ans.watched ? "" : "; changes since may be missing, use --fresh to re-read"}\n`);
      }
    } catch (e) {
      const stopped = e instanceof Interrupted;
      io.err(`filedeck du: ${label}: ${stopped ? "interrupted" : (e as Error).message}\n`);
      // The job is not cancelled; the same request joins it, so rerunning the command resumes the wait.
      if (jobId && running)
        io.err(`filedeck du: ${label}: job ${jobId} keeps running on the server; run the same command again to rejoin it\n`);
      status = stopped ? 130 : 1;
      if (stopped) break;
    }
  }
  return status;
}
