import { test } from "node:test";
import assert from "node:assert/strict";
import { LoginLimiter, addressKey } from "../src/auth/limiter.ts";

const clock = () => {
  const c = { t: 1_000_000, now: () => c.t };
  return c;
};

test("five failures in any sliding minute block; spread out they do not", () => {
  const c = clock();
  const l = new LoginLimiter(c.now);
  // four failures 100 ms apart, then a fifth 60 s after the first: the first has left the window
  for (let i = 0; i < 4; i++) {
    l.reserve("a", "1.1.1.1");
    c.t += 100;
  }
  c.t += 59_600; // 60 s after the first failure
  l.reserve("a", "1.1.1.1");
  assert.deepEqual(l.check("a", "1.1.1.1"), { ok: true });
  // one more while the other four are still in the window: five in 60 s
  c.t += 50;
  l.reserve("a", "1.1.1.1");
  const r = l.check("a", "1.1.1.1");
  assert.equal(r.ok, false);
  assert.equal((r as { retryAfterMs: number }).retryAfterMs, 1000);
});

test("the block doubles with each failure and stops at 15 minutes", () => {
  const c = clock();
  const l = new LoginLimiter(c.now);
  for (let i = 0; i < 5; i++) l.reserve("a", "ip");
  const waits: number[] = [];
  for (let i = 0; i < 12; i++) {
    const r = l.check("a", "ip");
    assert.equal(r.ok, false);
    const w = (r as { retryAfterMs: number }).retryAfterMs;
    waits.push(w);
    c.t += w; // wait the block out, then fail again
    assert.deepEqual(l.check("a", "ip"), { ok: true });
    l.reserve("a", "ip");
  }
  assert.deepEqual(waits.slice(0, 6), [1000, 2000, 4000, 8000, 16_000, 32_000]);
  assert.equal(Math.max(...waits), 15 * 60_000);
  // a quiet minute after the block ends forgives the key
  c.t += 15 * 60_000 + 60_000;
  l.reserve("a", "ip");
  assert.deepEqual(l.check("a", "ip"), { ok: true });
});

test("a reservation that succeeds clears the name and gives the address its failure back", () => {
  const c = clock();
  const l = new LoginLimiter(c.now);
  for (let i = 0; i < 4; i++) l.reserve("x" + i, "ip");
  for (let i = 0; i < 4; i++) l.reserve("a", "other" + i);
  l.reserve("a", "ip").succeed();
  assert.deepEqual(l.check("z", "ip"), { ok: true }, "the address is back at four failures");
  assert.deepEqual(l.check("a", "other9"), { ok: true }, "the name was cleared");
  l.reserve("y", "ip"); // the fifth real failure of the address
  assert.equal(l.check("z", "ip").ok, false);
  // while it runs, the reservation counts: here it is the fifth failure, so the address is blocked
  const l2 = new LoginLimiter(c.now);
  for (let i = 0; i < 4; i++) l2.reserve("x" + i, "ip");
  l2.reserve("a", "ip");
  assert.equal(l2.check("z", "ip").ok, false);
});

test("IPv6 addresses count by their /64; mapped IPv4 as IPv4", () => {
  assert.equal(addressKey("2001:db8:1:2:aaaa::1"), addressKey("2001:db8:1:2:bbbb:cccc:dddd:eeee"));
  assert.notEqual(addressKey("2001:db8:1:2::1"), addressKey("2001:db8:1:3::1"));
  assert.equal(addressKey("2001:DB8:0001:0002::"), "2001:db8:1:2::/64");
  assert.equal(addressKey("::1"), "0:0:0:0::/64");
  assert.equal(addressKey("::ffff:10.0.0.5"), "10.0.0.5");
  assert.equal(addressKey("10.0.0.5"), "10.0.0.5");
  for (const m of ["::ffff:0a00:0005", "::FFFF:A00:5", "0:0:0:0:0:ffff:0a00:0005", "0000:0000:0000:0000:0000:FFFF:0A00:0005", "0:0:0:0:0:ffff:10.0.0.5", "::ffff:10.0.0.5"]) {
    assert.equal(addressKey(m), "10.0.0.5", m);
  }
  const c = clock();
  const l = new LoginLimiter(c.now);
  for (let i = 0; i < 5; i++) l.reserve("n" + i, `2001:db8:1:2::${i + 1}`);
  assert.equal(l.check("other", "2001:db8:1:2:ffff::9").ok, false);
  assert.equal(l.check("other", "2001:db8:1:3::9").ok, true);
});

test("over the key cap, unblocked keys are evicted before blocked ones", () => {
  const c = clock();
  const l = new LoginLimiter(c.now, 10);
  for (let i = 0; i < 5; i++) l.reserve("victim", "a" + i); // the oldest key, and blocked
  // fill the map with unblocked keys (one failure each, name and address)
  for (let i = 0; i < 20; i++) l.reserve("n" + i, "b" + i);
  assert.equal(l.check("victim", "zz").ok, false, "the blocked name survived");
});

test("a good reservation undoes only its own failure, not a block that others set meanwhile", () => {
  const c = clock();
  const l = new LoginLimiter(c.now);
  const slow = l.reserve("good", "ip"); // a slow good sign-in starts: one failure counted
  for (let i = 0; i < 4; i++) l.reserve("bad" + i, "ip"); // four parallel failures: the fifth failure starts a block
  assert.equal(l.check("z", "ip").ok, false);
  slow.succeed();
  assert.equal(l.check("z", "ip").ok, false, "the block set by the other failures stays");
  // the count stays too: after the block, one more failure blocks again (the streak goes on)
  c.t += 1000;
  assert.equal(l.check("z", "ip").ok, true);
  l.reserve("bad", "ip");
  assert.equal(l.check("z", "ip").ok, false);

  // when the reservation itself was the fifth failure, success takes back the block but keeps the four failures
  const l2 = new LoginLimiter(c.now);
  for (let i = 0; i < 4; i++) l2.reserve("bad" + i, "ip");
  const r = l2.reserve("good", "ip");
  assert.equal(l2.check("z", "ip").ok, false);
  r.succeed();
  assert.equal(l2.check("z", "ip").ok, true);
  l2.reserve("bad", "ip");
  assert.equal(l2.check("z", "ip").ok, false, "the four earlier failures still count");
});

test("a flood of one-failure keys does not evict a key with four failures", () => {
  const c = clock();
  const l = new LoginLimiter(c.now, 10);
  for (let i = 0; i < 4; i++) l.reserve("victim", "a" + i); // the oldest key, four failures, not blocked
  for (let i = 0; i < 50; i++) l.reserve("n" + i, "b" + i);
  l.reserve("victim", "c");
  assert.equal(l.check("victim", "d").ok, false, "the fifth failure blocks: the four were kept");
});
