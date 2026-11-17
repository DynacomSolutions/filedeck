import assert from "node:assert/strict";
import test from "node:test";
import { attemptFailure, missingProof, MAX_KEY_FILE } from "../src/proofFields.ts";
import { SignInError } from "../src/auth.ts";
import { KeyFileError } from "../src/sshkey.ts";

// The sign-in screen and the act-as-root dialog share these, so both show the same messages.
test("what is missing before an attempt, in the order the sign-in screen checks it", () => {
  const base = { method: "password" as const, password: "", keyText: "", keyEncrypted: false, passphrase: "" };
  assert.deepEqual(missingProof(base), { message: "Enter your password", field: "password" });
  assert.equal(missingProof({ ...base, password: "pw" }), null);
  assert.deepEqual(missingProof({ ...base, method: "key" }), { message: "Choose a key file", field: "key" });
  assert.deepEqual(missingProof({ ...base, method: "key", keyText: "k", keyEncrypted: true }), { message: "Enter the passphrase for this key", field: "passphrase" });
  assert.equal(missingProof({ ...base, method: "key", keyText: "k", keyEncrypted: true, passphrase: "p" }), null);
  assert.equal(missingProof({ ...base, method: "key", keyText: "k" }), null);
});

test("a failed attempt: the message, the field it is about, and whether the chosen key file is kept", () => {
  assert.deepEqual(attemptFailure(new KeyFileError("wrong passphrase")), { message: "Wrong passphrase", field: "passphrase", keepKey: true });
  assert.deepEqual(attemptFailure(new KeyFileError("key type not supported")), { message: "Key type not supported", field: "key", keepKey: false });
  assert.deepEqual(attemptFailure(new SignInError("Too many attempts. Try again in 3 seconds")), { message: "Too many attempts. Try again in 3 seconds", field: null, keepKey: false });
  assert.deepEqual(attemptFailure(new Error("boom")), { message: "Sign-in failed", field: null, keepKey: false });
  assert.equal(MAX_KEY_FILE, 64 * 1024);
});
