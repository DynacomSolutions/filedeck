import assert from "node:assert/strict";
import test from "node:test";
import { notificationsFor } from "../src/jobNotify.ts";
import type { HistoryEntry } from "../src/jobHistory.ts";
import { DEFAULT_SETTINGS, normalizeSettings } from "../src/settings.ts";

const job = (key: string, outcome: HistoryEntry["outcome"], extra: Partial<HistoryEntry> = {}): HistoryEntry => ({ key, title: `Copy ${key}`, outcome, at: 1, ...extra });
const on = { hidden: true, enabled: true, permission: "granted" };

test("no notification while the page is shown, the switch is off, or permission is not granted", () => {
  const ended = [job("a", "done")];
  assert.deepEqual(notificationsFor(ended, { ...on, hidden: false }), []);
  assert.deepEqual(notificationsFor(ended, { ...on, enabled: false }), []);
  assert.deepEqual(notificationsFor(ended, { ...on, permission: "default" }), []);
  assert.deepEqual(notificationsFor(ended, { ...on, permission: "denied" }), []);
  assert.deepEqual(notificationsFor([], on), []);
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
