import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { claimFor, signClaim, verifyClaim, USER_HEADER, type Identity, type UserClaim } from "../src/auth/identity.ts";
import { loadConfig } from "../src/config.ts";

const T = "agent-token-one";
const claim: UserClaim = { kind: "virt", name: "alice", epoch: 3, runAs: "deploy", grants: [{ path: "/srv", write: true }], iat: 1_000_000 };

test("round trip", () => {
  assert.deepEqual(verifyClaim(signClaim(claim, T), T, claim.iat), claim);
});

test("wrong token", () => {
  assert.equal(verifyClaim(signClaim(claim, T), "another-token", claim.iat), null);
});

test("tampered payload", () => {
  const v = signClaim(claim, T);
  const flipped = (v[5] === "A" ? "B" : "A");
  assert.equal(verifyClaim(v.slice(0, 5) + flipped + v.slice(6), T, claim.iat), null);
  assert.equal(verifyClaim("nodot", T, claim.iat), null);
  assert.equal(verifyClaim("", T, claim.iat), null);
});

test("stale and future", () => {
  const v = signClaim(claim, T);
  assert.equal(verifyClaim(v, T, claim.iat + 60_001), null);
  assert.deepEqual(verifyClaim(v, T, claim.iat + 60_000), claim);
  assert.equal(verifyClaim(v, T, claim.iat - 5_001), null);
  assert.deepEqual(verifyClaim(v, T, claim.iat - 5_000), claim);
});

test("claimFor", () => {
  const virt: Identity = {
    kind: "virt", name: "alice", admin: false, epoch: 3,
    nodes: { a: { runAs: "deploy", grants: [{ path: "/srv", write: true }] }, b: { runAs: "other", grants: [] } },
  };
  assert.equal(claimFor(virt, "missing", 5), null);
  assert.deepEqual(claimFor(virt, "a", 5), { kind: "virt", name: "alice", epoch: 3, runAs: "deploy", grants: [{ path: "/srv", write: true }], iat: 5 });
  const sys: Identity = { kind: "sys", name: "bob", admin: true, epoch: 1 };
  const c = claimFor(sys, "a", 7);
  assert.deepEqual(c, { kind: "sys", name: "bob", epoch: 1, iat: 7 });
  assert.ok(c && !("runAs" in c) && !("grants" in c));
  assert.equal(USER_HEADER, "x-filedeck-user");
});

test("config", () => {
  const c = loadConfig({ FILEDECK_AUTH: "on", FILEDECK_ADMINS: "alice, bob" });
  assert.equal(c.auth, true);
  assert.deepEqual(c.admins, ["alice", "bob"]);
  assert.equal(c.sessionIdleMs, 8 * 3600_000);
  assert.equal(c.sessionMaxMs, 7 * 86400_000);
  assert.equal(c.authFile, ":memory:");
  assert.equal(c.bootstrapAdminFile, undefined);
  assert.equal(c.apiTokenAccount, undefined);
  assert.equal(loadConfig({}).auth, false);
  assert.deepEqual(loadConfig({}).admins, []);
  assert.equal(loadConfig({ FILEDECK_VAULT_FILE: "/data/v/vault.sqlite" }).authFile, path.join("/data/v", "auth.sqlite"));
  assert.equal(loadConfig({ FILEDECK_VAULT_FILE: "/data/v/vault.sqlite", FILEDECK_AUTH_FILE: "/x/a.db" }).authFile, "/x/a.db");
  const d = loadConfig({ FILEDECK_BOOTSTRAP_ADMIN_FILE: "/b", FILEDECK_API_TOKEN_ACCOUNT: "svc", FILEDECK_SESSION_IDLE_SECONDS: "60", FILEDECK_SESSION_MAX_SECONDS: "120" });
  assert.equal(d.bootstrapAdminFile, "/b");
  assert.equal(d.apiTokenAccount, "svc");
  assert.equal(d.sessionIdleMs, 60_000);
  assert.equal(d.sessionMaxMs, 120_000);
});
