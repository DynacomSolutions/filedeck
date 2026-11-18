import assert from "node:assert/strict";
import test from "node:test";
import { VISIBLE_FRESH_MS, notificationsFor, otherTabVisible, parseVisibleMark } from "../src/jobNotify.ts";
import type { HistoryEntry } from "../src/jobHistory.ts";
import { DEFAULT_SETTINGS, normalizeSettings } from "../src/settings.ts";

const job = (key: string, outcome: HistoryEntry["outcome"], extra: Partial<HistoryEntry> = {}): HistoryEntry => ({ key, title: `Copy ${key}`, outcome, at: 1, ...extra });
const on = { hidden: true, enabled: true, permission: "granted", otherTabVisible: false };

test("no notification while the page is shown, the switch is off, or permission is not granted", () => {
  const ended = [job("a", "done")];
  assert.deepEqual(notificationsFor(ended, { ...on, hidden: false }), []);
  assert.deepEqual(notificationsFor(ended, { ...on, enabled: false }), []);
  assert.deepEqual(notificationsFor(ended, { ...on, permission: "default" }), []);
  assert.deepEqual(notificationsFor(ended, { ...on, permission: "denied" }), []);
  assert.deepEqual(notificationsFor([], on), []);
  // another Filedeck tab is on screen: its tray shows the result, so this hidden tab stays quiet
  assert.deepEqual(notificationsFor(ended, { ...on, otherTabVisible: true }), []);
});

test("a tab counts as on screen while its mark is fresh, and never for itself", () => {
  assert.equal(otherTabVisible({ id: "b", at: 10_000 }, "a", 12_000), true);
  assert.equal(otherTabVisible({ id: "b", at: 10_000 }, "a", 10_000 + VISIBLE_FRESH_MS + 1), false);
  assert.equal(otherTabVisible({ id: "a", at: 10_000 }, "a", 10_500), false);
  assert.equal(otherTabVisible(null, "a", 10_500), false);
  assert.equal(otherTabVisible(parseVisibleMark("not json"), "a", 1), false);
  assert.deepEqual(parseVisibleMark(JSON.stringify({ id: "b", at: 5 })), { id: "b", at: 5 });
  assert.equal(parseVisibleMark(JSON.stringify({ id: 3, at: "x" })), null);
});

test("one finished or failed job gives one notification, tagged with the job", () => {
  assert.deepEqual(notificationsFor([job("a", "done", { detail: "12 done" })], on), [{ title: "Copy a finished", body: "12 done", tag: "filedeck-job:a" }]);
  assert.deepEqual(notificationsFor([job("b", "failed", { detail: "No space left on device" })], on), [{ title: "Copy b failed", body: "No space left on device", tag: "filedeck-job:b" }]);
  assert.deepEqual(notificationsFor([job("c", "done")], on), [{ title: "Copy c finished", body: "", tag: "filedeck-job:c" }]);
});

test("cancelled jobs never notify (the user cancelled them)", () => {
  assert.deepEqual(notificationsFor([job("a", "canceled")], on), []);
  assert.equal(notificationsFor([job("a", "canceled"), job("b", "done")], on)[0]?.title, "Copy b finished");
});

test("several jobs ending together fold into one notification that counts failures", () => {
  const n = notificationsFor([job("a", "done"), job("b", "failed"), job("c", "done"), job("d", "canceled")], on);
  assert.equal(n.length, 1);
  assert.equal(n[0]?.title, "3 jobs ended, 1 failed");
  assert.equal(n[0]?.body, "Copy a finished\nCopy b failed\nCopy c finished");
  assert.equal(n[0]?.tag, "filedeck-jobs");
  assert.equal(notificationsFor([job("a", "done"), job("b", "done")], on)[0]?.title, "2 jobs finished");
});

test("the notification switch is off unless set, and only a boolean is kept", () => {
  assert.equal(DEFAULT_SETTINGS.notifyJobs, false);
  assert.equal(normalizeSettings({}).notifyJobs, false);
  assert.equal(normalizeSettings({ notifyJobs: true }).notifyJobs, true);
  assert.equal(normalizeSettings({ notifyJobs: "yes" }).notifyJobs, false);
});

test("with push on, the hub notifies server jobs; the page itself only browser uploads (which the hub never sees)", async () => {
  const { localEnds } = await import("../src/jobNotify.ts");
  const ended = [job("o:1", "done"), job("u:2", "failed"), job("m:n1:3", "done")];
  assert.deepEqual(localEnds(ended, false).map((e) => e.key), ["o:1", "u:2", "m:n1:3"]);
  assert.deepEqual(localEnds(ended, true).map((e) => e.key), ["u:2"]);
});
