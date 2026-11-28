import { test } from "node:test";
import assert from "node:assert/strict";
import { HDR_BYTES, HF_LOSSY, HF_TRUNCATED, HT, HolderDecoder, encodeRecord, kernelDev } from "../src/holders-proto.ts";

test("holders proto: a record round-trips, in one piece or in many", () => {
  const a = encodeRecord({ type: HT.FD, pid: 4321, aux: 7, dev: (259 << 20) | 3, ino: 123456789, comm: "postgres", chain: [30, 20, 10, 2] });
  const b = encodeRecord({ type: HT.EXIT, pid: 9 });
  const all = Buffer.concat([a, b]);
  const whole = new HolderDecoder().push(all);
  assert.ok("recs" in whole);
  assert.equal(whole.recs.length, 2);
  const [r, e] = whole.recs;
  assert.deepEqual({ type: r!.type, pid: r!.pid, aux: r!.aux, dev: r!.dev, ino: r!.ino, comm: r!.comm, chain: [...r!.chain] }, { type: HT.FD, pid: 4321, aux: 7, dev: (259 << 20) | 3, ino: 123456789, comm: "postgres", chain: [30, 20, 10, 2] });
  assert.equal(e!.type, HT.EXIT);
  assert.equal(a.length, HDR_BYTES + 32);

  const d = new HolderDecoder();
  const got: number[] = [];
  for (let i = 0; i < all.length; i++) {
    const out = d.push(all.subarray(i, i + 1));
    assert.ok("recs" in out);
    got.push(...out.recs.map((x) => x.type));
  }
  assert.deepEqual(got, [HT.FD, HT.EXIT]);
  assert.equal(d.records, 2);
});

test("holders proto: inode numbers above 2^53 are marked, not rounded silently", () => {
  const b = encodeRecord({ type: HT.FD, pid: 1, ino: 5, chain: [1] });
  b.writeUInt32LE(0x400000, 28); // the high half of ino: 2^54
  const out = new HolderDecoder().push(b);
  assert.ok("recs" in out);
  assert.ok(out.recs[0]!.flags & HF_LOSSY);
  assert.ok(out.recs[0]!.flags & HF_TRUNCATED, "a number that cannot be compared proves no absence");
});

test("holders proto: a start failure is one line of JSON and nothing after it is read", () => {
  const d = new HolderDecoder();
  assert.deepEqual(d.push(Buffer.from('{"ok":false,"error":"not permit')), { recs: [] });
  assert.deepEqual(d.push(Buffer.from('ted: needs CAP_BPF"}\n')), { failure: "not permitted: needs CAP_BPF" });
  assert.deepEqual(d.push(Buffer.from("more")), { recs: [] });
});

test("holders proto: a record with a wrong length is a failure, not a guess", () => {
  const bad = encodeRecord({ type: HT.EXIT, pid: 1 });
  bad.writeUInt32LE(13, 0);
  const out = new HolderDecoder().push(bad);
  assert.ok("failure" in out);
  const cnt = encodeRecord({ type: HT.FD, pid: 1, chain: [1, 2] });
  cnt.writeUInt16LE(5, 6);
  assert.ok("failure" in new HolderDecoder().push(cnt));
});

test("holders proto: the kernel device number of a stat device", () => {
  // glibc: dev = (minor & 0xff) | (major << 8) | ((minor & ~0xff) << 12) | ((major & ~0xfff) << 32)
  const enc = (major: number, minor: number) => BigInt((minor & 0xff) | (major << 8) | ((minor & ~0xff) << 12));
  assert.equal(kernelDev(enc(8, 1)), (8 << 20) | 1);
  assert.equal(kernelDev(enc(259, 3)), (259 << 20) | 3);
  assert.equal(kernelDev(enc(0, 0x12345)), 0x12345);
  assert.equal(kernelDev(enc(254, 0x1ff)), (254 << 20) | 0x1ff);
});
