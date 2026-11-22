// Runs acceptance.mjs as several processes, each with one shard of the checks (FILEDECK_SHARD=i/n).
// FILEDECK_WORKERS sets the number of processes. The default is the smaller of 4 and the CPU count.
// All other environment variables pass through, for example FILEDECK_URL and BROWSER.
import { spawn } from 'node:child_process';
import { availableParallelism } from 'node:os';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('./acceptance.mjs', import.meta.url));
const requested = Number(process.env.FILEDECK_WORKERS || Math.min(4, availableParallelism()));
if (!Number.isInteger(requested) || requested < 1) throw new Error(`FILEDECK_WORKERS must be a whole number of 1 or more, not ${process.env.FILEDECK_WORKERS}`);
const n = requested;
const started = Date.now();
const children = new Set();
let stopping = false;

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    stopping = true;
    for (const child of children) child.kill(signal);
  });
}

function run(i) {
  return new Promise((resolve) => {
    const shard = { i, passed: 0, ran: 0, totals: false, failed: [], code: null, signal: null, seconds: 0 };
    const t0 = Date.now();
    const prefix = `[${i}/${n}] `;
    const child = spawn(process.execPath, [script], { env: { ...process.env, FILEDECK_SHARD: `${i}/${n}` }, stdio: ['ignore', 'pipe', 'pipe'] });
    children.add(child);
    const pipe = (stream, out) => {
      let rest = '';
      const line = (text) => {
        out.write(`${prefix}${text}\n`);
        const done = /^(\d+)\/(\d+) checks passed/.exec(text);
        if (done) { shard.passed = Number(done[1]); shard.ran = Number(done[2]); shard.totals = true; }
        const fail = /^FAIL {2}(.*) \(\d+ ms\)$/.exec(text);
        if (fail) shard.failed.push(fail[1]);
      };
      stream.on('data', (chunk) => {
        rest += chunk;
        const parts = rest.split('\n');
        rest = parts.pop();
        parts.forEach(line);
      });
      stream.on('end', () => { if (rest) line(rest); });
    };
    pipe(child.stdout, process.stdout);
    pipe(child.stderr, process.stderr);
    const finish = (code, signal) => {
      children.delete(child);
      Object.assign(shard, { code, signal, seconds: Math.round((Date.now() - t0) / 1000) });
      resolve(shard);
    };
    child.on('error', (error) => { console.error(`${prefix}could not start: ${error.message}`); finish(1, null); });
    child.on('close', finish);
  });
}

const shards = await Promise.all(Array.from({ length: n }, (_, k) => run(k + 1)));

let bad = false;
let passed = 0;
let ran = 0;
const failedNames = [];
console.log('\nSummary');
for (const s of shards) {
  // A shard that ends without its totals line, or with a signal, did not finish.
  const abnormal = s.signal !== null || (s.code !== 0 && s.code !== 1) || !s.totals;
  const status = abnormal ? `ABNORMAL (code ${s.code}, signal ${s.signal})` : s.code === 0 ? 'ok' : 'FAILED';
  if (abnormal || s.code !== 0) bad = true;
  passed += s.passed;
  ran += s.ran;
  failedNames.push(...s.failed);
  console.log(`  [${s.i}/${n}] ${s.passed}/${s.ran} checks passed in ${s.seconds} s, ${status}`);
}
console.log(`Total: ${passed}/${ran} checks passed in ${Math.round((Date.now() - started) / 1000)} s wall time`);
if (failedNames.length) console.error(`Failed checks: ${failedNames.join('; ')}`);
if (stopping) console.error('Stopped by a signal.');
process.exitCode = bad || stopping ? 1 : 0;
