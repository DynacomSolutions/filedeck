import assert from "node:assert/strict";
import test from "node:test";
import { methodView } from "../src/sessionMethod.ts";

test("methodView names how a session signed in", () => {
  assert.deepEqual(methodView({ method: "password" }), { label: "Password" });
  assert.deepEqual(methodView({ method: "key" }), { label: "Key" });
  assert.deepEqual(methodView({}), { label: "Unknown" });
});

test("a Tailscale session shows its source, the login or tag and the device when known", () => {
  assert.deepEqual(methodView({ method: "tailscale", tailnet: "tag:ci", tailnetSource: "socket", tailnetDevice: "ci-runner" }), { label: "Tailscale (socket)", subject: "tag:ci", device: "ci-runner" });
  assert.deepEqual(methodView({ method: "tailscale", tailnet: "alice@github", tailnetSource: "headers" }), { label: "Tailscale (headers)", subject: "alice@github" });
  assert.deepEqual(methodView({ method: "tailscale", tailnet: "alice@github" }), { label: "Tailscale", subject: "alice@github" });
});
