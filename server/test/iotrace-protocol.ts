import assert from "node:assert/strict";

/** One row of the output of filedeck-iotrace (the protocol of the disk pressure contract, "eBPF helper protocol"). */
export type IotraceRow = { dev: string; cg: number; pid: number; comm: string; r: number; w: number; rb: number; wb: number };
export type IotraceLine = { t: number; ok: true; rows: IotraceRow[] };

const ROW_KEYS = ["cg", "comm", "dev", "pid", "r", "rb", "w", "wb"];
const isCount = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;

/** Throws unless the text is one JSON line that follows the protocol exactly; returns the parsed line. */
export function assertIotraceLine(text: string): IotraceLine {
  assert.ok(!text.includes("\n"), "one line");
  const o = JSON.parse(text);
  assert.deepEqual(Object.keys(o).sort(), ["ok", "rows", "t"]);
  assert.equal(o.ok, true);
  assert.ok(isCount(o.t), "t is a millisecond epoch");
  assert.ok(Array.isArray(o.rows) && o.rows.length <= 512, "at most 512 rows");
  let previous = Infinity;
  for (const r of o.rows) {
    assert.deepEqual(Object.keys(r).sort(), ROW_KEYS);
    assert.match(r.dev, /^[0-9]+:[0-9]+$/);
    for (const k of ["cg", "pid", "r", "w", "rb", "wb"]) assert.ok(isCount(r[k]), `${k} is a count`);
    assert.equal(typeof r.comm, "string");
    assert.ok(r.comm.length <= 15, "comm is at most 15 characters");
    assert.ok(r.r + r.w > 0, "a row has at least one request");
    assert.ok(r.r + r.w <= previous, "rows are ordered by requests, busiest first");
    previous = r.r + r.w;
  }
  return o;
}

/** The failure line: printed once, then the helper exits with status 3. */
export function assertIotraceFailure(text: string): { ok: false; error: string } {
  const o = JSON.parse(text);
  assert.deepEqual(Object.keys(o).sort(), ["error", "ok"]);
  assert.equal(o.ok, false);
  assert.equal(typeof o.error, "string");
  assert.ok(o.error.length > 0);
  return o;
}
