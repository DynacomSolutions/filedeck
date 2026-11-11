import assert from "node:assert/strict";
import test from "node:test";
import { cancelUpload, dropPart, enqueueUpload, lostFinal, resumeUpload, pauseUpload, retryFailed, dismissUpload, uploadsActive, type UpBatch } from "../src/uploads.ts";

/** A browser XHR that only does what the test tells it to. */
class FakeXhr {
  static all: FakeXhr[] = [];
  upload: { onprogress: ((e: unknown) => void) | null } = { onprogress: null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  ontimeout: (() => void) | null = null;
  status = 0;
  responseText = "";
  aborted = false;
  url = "";
  open(_m: string, url: string) {
    this.url = url;
    FakeXhr.all.push(this);
  }
  send() {}
  abort() {
    this.aborted = true;
  }
  reply(status: number, body: unknown = {}) {
    this.status = status;
    this.responseText = JSON.stringify(body);
    this.onload?.();
  }
}
(globalThis as unknown as { XMLHttpRequest: unknown }).XMLHttpRequest = FakeXhr;

const file = (name: string, size = 10) => ({ rel: name, file: new File([new Uint8Array(size)], name) });
const tick = () => new Promise((r) => setTimeout(r, 5));
const waitFor = async (cond: () => boolean) => {
  for (let i = 0; i < 200 && !cond(); i++) await tick();
  assert.ok(cond(), "condition not reached");
};
const reset = () => (FakeXhr.all.length = 0);
const states = (b: UpBatch) => b.files.map((f) => f.state);

test("lostFinal: only the last chunk with a finished file and no part counts", () => {
  assert.equal(lostFinal(100, 100, { offset: 0, exists: true }), true);
  assert.equal(lostFinal(50, 100, { offset: 0, exists: true }), false);
  assert.equal(lostFinal(100, 100, { offset: 40, exists: false }), false);
  assert.equal(lostFinal(100, 100, {}), false);
});

test("retry failed after a cancel retries the failed files only", async () => {
  reset();
  const b = enqueueUpload("n", "/d", [file("a"), file("b"), file("c"), file("d"), file("e")]);
  await waitFor(() => FakeXhr.all.length === 3); // three at a time
  FakeXhr.all[0]!.reply(500, { error: "disk full" });
  await waitFor(() => b.files[0]!.state === "failed");
  await waitFor(() => FakeXhr.all.length === 4);
  cancelUpload(b.id);
  assert.equal(b.state, "canceled");
  await tick();
  const before = FakeXhr.all.length;
  retryFailed(b.id);
  await waitFor(() => FakeXhr.all.length > before);
  await tick();
  const started = FakeXhr.all.slice(before).map((x) => decodeURIComponent(/name=([^&]+)/.exec(x.url)![1]!));
  assert.deepEqual(started, ["a"], "files that were only waiting when the batch was cancelled stay out");
  FakeXhr.all[before]!.reply(200, {});
  await waitFor(() => b.state === "done");
  dismissUpload(b.id);
});

test("an upload in progress asks before the page is left, and stops asking when it ends", async () => {
  reset();
  const b = enqueueUpload("n", "/d", [file("a")]);
  await waitFor(() => FakeXhr.all.length === 1);
  assert.equal(uploadsActive(), true);
  pauseUpload(b.id);
  assert.equal(uploadsActive(), false, "a paused upload is not being cut short");
  await tick(); // let the aborted request settle, as it does in a browser
  resumeUpload(b.id);
  await waitFor(() => FakeXhr.all.length === 2);
  assert.equal(uploadsActive(), true);
  FakeXhr.all[1]!.reply(200, {});
  await waitFor(() => b.state === "done");
  assert.equal(uploadsActive(), false);
  dismissUpload(b.id);
});

test("dropPart tries again while the server still has the cut-short chunk in progress", async () => {
  const real = globalThis.fetch;
  const codes = [409, 409, 200];
  let calls = 0;
  globalThis.fetch = (async () => new Response("{}", { status: codes[calls++] ?? 200 })) as typeof fetch;
  try {
    await dropPart("n", { dir: "/d", name: "big", id: "abcdef012345" }, 1);
    assert.equal(calls, 3);
  } finally {
    globalThis.fetch = real;
  }
});
