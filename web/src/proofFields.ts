import { SignInError } from "./auth";

/**
 * The pure part of the password / key-file fields shared by the sign-in screen and the act-as-root dialog
 * (ProofFields.tsx), so both check and report in the same words.
 */
export type Method = "password" | "key";
export type ProofField = "password" | "key" | "passphrase";
export const METHODS: { value: Method; label: string }[] = [
  { value: "password", label: "Password" },
  { value: "key", label: "Key file" },
];
/** a larger file is not a private key we can use */
export const MAX_KEY_FILE = 64 * 1024;

export const sentence = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
/** KeyFileError from ./sshkey, which is loaded only on the key path, so it is told by name here. */
export const keyFileError = (e: unknown): string | null => (e instanceof Error && e.name === "KeyFileError" ? e.message : null);

/** What is missing before an attempt, or null. */
export function missingProof(f: { method: Method; password: string; keyText: string; keyEncrypted: boolean; passphrase: string }): { message: string; field: ProofField } | null {
  if (f.method === "password" && !f.password) return { message: "Enter your password", field: "password" };
  if (f.method === "key" && !f.keyText) return { message: "Choose a key file", field: "key" };
  if (f.method === "key" && f.keyEncrypted && !f.passphrase) return { message: "Enter the passphrase for this key", field: "passphrase" };
  return null;
}

/**
 * A failed attempt: the message, the field it is about, and whether the chosen key file is kept. After a wrong
 * passphrase the file text is kept on purpose (it is an encrypted key, and keeping it lets the user type only the
 * passphrase again); every other failure drops all the secrets.
 */
export function attemptFailure(e: unknown): { message: string; field: ProofField | null; keepKey: boolean } {
  const k = keyFileError(e);
  if (k === "wrong passphrase") return { message: "Wrong passphrase", field: "passphrase", keepKey: true };
  return { message: e instanceof SignInError ? e.message : k ? sentence(k) : "Sign-in failed", field: k ? "key" : null, keepKey: false };
}
