import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { PushStore, pushHostAllowed } from "../src/push/store.ts";

const sub = (n: number, owner = "sys:alice", session: string | null = "s1") => ({
  endpoint: `https://fcm.googleapis.com/fcm/send/e${n}`,
  p256dh: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
  auth: "BTBZMqHH6r4Tts7J_aSIgg",
  owner,
  session,
});

test("the key pair is made once, and two stores on one file (two hub pods) use the same one", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fd-push-"));
  try {
    const f = path.join(dir, "push.sqlite");
    const a = new PushStore(f);
    const b = new PushStore(f);
    const ka = a.keys();
    assert.deepEqual(b.keys(), ka);
    assert.deepEqual(a.keys(), ka);
    assert.equal(fs.statSync(f).mode & 0o777, 0o600);
    a.close();
    b.close();
    const c = new PushStore(f);
    assert.deepEqual(c.keys(), ka);
    c.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a subscription is kept per endpoint: subscribing again moves it to the new account and session", () => {
  const s = new PushStore(":memory:", () => 1000);
  s.add(sub(1));
  s.add(sub(2, "sys:alice", "s2"));
  s.add({ ...sub(1), owner: "virt:bob", session: "s9" });
  assert.deepEqual(s.owners().sort(), ["sys:alice", "virt:bob"]);
  assert.deepEqual(s.of("virt:bob").map((x) => [x.endpoint, x.session, x.created]), [[sub(1).endpoint, "s9", 1000]]);
  assert.equal(s.of("sys:alice").length, 1);
});

test("subscriptions end by session, by account, by endpoint (only the owner's own)", () => {
  const s = new PushStore(":memory:");
  s.add(sub(1, "sys:alice", "s1"));
  s.add(sub(2, "sys:alice", "s2"));
  s.add(sub(3, "virt:bob", "s3"));
  assert.equal(s.removeSession("s1"), 1);
  assert.deepEqual(s.of("sys:alice").map((x) => x.session), ["s2"]);
  assert.equal(s.remove(sub(3).endpoint, "sys:alice"), 0, "another account's endpoint is not removed");
  assert.equal(s.remove(sub(3).endpoint, "virt:bob"), 1);
  s.add(sub(4, "sys:alice", "s4"));
  assert.equal(s.removeOwner("sys:alice"), 2);
  assert.deepEqual(s.owners(), []);
  s.add(sub(5));
  assert.equal(s.drop(sub(5).endpoint), 1);
});

test("a job end is claimed once across stores; old claims are pruned", () => {
  let t = 1000;
  const s = new PushStore(":memory:", () => t);
  assert.equal(s.claim("sys:alice|ops|j1"), true);
  assert.equal(s.claim("sys:alice|ops|j1"), false);
  t += 3 * 86_400_000;
  s.prune();
  assert.equal(s.claim("sys:alice|ops|j1"), true);
});

test("only https endpoints on push service hosts are accepted", () => {
  for (const u of [
    "https://fcm.googleapis.com/fcm/send/x",
    "https://updates.push.services.mozilla.com/wpush/v2/x",
    "https://web.push.apple.com/x",
    "https://wns2-db5p.notify.windows.com/w/?token=x",
  ])
    assert.ok(pushHostAllowed(u, []), u);
  for (const u of ["http://fcm.googleapis.com/x", "https://127.0.0.1/x", "https://evilgoogleapis.com/x", "https://fcm.googleapis.com.evil.test/x", "not a url", "https://user@fcm.googleapis.com:8443/x"])
    assert.ok(!pushHostAllowed(u, []), u);
  assert.ok(pushHostAllowed("https://push.example.test/x", ["push.example.test"]));
});

test("subscribing again for the same account keeps its start time; another account starts again", () => {
  let t = 1000;
  const s = new PushStore(":memory:", () => t);
  s.add(sub(1, "sys:alice", "s1"));
  t = 5000;
  s.add(sub(1, "sys:alice", "s2"));
  assert.deepEqual(s.of("sys:alice").map((x) => [x.session, x.created]), [["s2", 1000]]);
  s.add(sub(1, "virt:bob", "s3"));
  assert.deepEqual(s.of("virt:bob").map((x) => x.created), [5000]);
});

test("an idle session's subscriptions are kept until the session's absolute end, without the session", () => {
  const s = new PushStore(":memory:");
  s.add(sub(1, "sys:alice", "s1"));
  s.add(sub(2, "sys:alice", "s2"));
  assert.equal(s.detach("s1", 9000), 1);
  assert.deepEqual(s.of("sys:alice").map((x) => [x.endpoint.slice(-2), x.session, x.until]), [["e1", null, 9000], ["e2", "s2", null]]);
});

test("a claim can be given back when its send failed", () => {
  const s = new PushStore(":memory:");
  assert.equal(s.claim("k"), true);
  s.unclaim("k");
  assert.equal(s.claim("k"), true);
});

test("the Google push host is the FCM host only", () => {
  assert.ok(!pushHostAllowed("https://storage.googleapis.com/bucket/x", []));
  assert.ok(!pushHostAllowed("https://push.apple.com.evil.test/x", []));
  assert.ok(pushHostAllowed("https://web.push.apple.com/x", []));
});
