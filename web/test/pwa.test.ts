import assert from "node:assert/strict";
import test from "node:test";
import { HubAnswerError } from "../src/auth.ts";
import { THEME_COLOR, hubUnreachable, nextUpdate, type UpdateState } from "../src/pwaState.ts";

test("a new version waiting makes the page offer a reload", () => {
  assert.deepEqual(nextUpdate("none", { type: "waiting" }), { state: "ready", reload: false });
});

test("the first service worker taking control of a fresh page is not an update", () => {
  assert.deepEqual(nextUpdate("none", { type: "controllerchange", asked: false, hadController: false }), { state: "none", reload: false });
});

test("the tab that asked for the new version reloads; another tab is told and never reloaded by itself", () => {
  assert.deepEqual(nextUpdate("ready", { type: "controllerchange", asked: true, hadController: true }), { state: "ready", reload: true });
  for (const s of ["none", "ready"] as UpdateState[]) assert.deepEqual(nextUpdate(s, { type: "controllerchange", asked: false, hadController: true }), { state: "updated", reload: false });
});

test("an updated tab stays updated when yet another version waits", () => {
  assert.deepEqual(nextUpdate("updated", { type: "waiting" }), { state: "updated", reload: false });
});

test("the hub counts as not reachable on a network failure or a gateway's 502, 503 or 504, not on its own errors", () => {
  assert.ok(hubUnreachable(new TypeError("Failed to fetch")));
  assert.ok(hubUnreachable(new TypeError("NetworkError when attempting to fetch resource.")));
  for (const s of [502, 503, 504]) assert.ok(hubUnreachable(new HubAnswerError(s)), String(s));
  assert.ok(!hubUnreachable(new HubAnswerError(500)));
  assert.ok(!hubUnreachable(new HubAnswerError(404)));
  assert.ok(!hubUnreachable(new Error("other")));
  assert.ok(!hubUnreachable(new SyntaxError("Unexpected token")));
});

test("the title bar colour follows the app's theme", () => {
  assert.equal(THEME_COLOR.dark, "#151518");
  assert.equal(THEME_COLOR.light, "#ffffff");
});
