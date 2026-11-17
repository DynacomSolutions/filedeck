/**
 * Sign-in calls to the hub (server/src/auth/routes.ts) and the signed-out signal. With auth off the hub answers
 * `GET /api/auth/me` with `{auth:false}` and nothing else here is used.
 */
export type Account = { auth: true; kind: "sys" | "virt"; name: string; admin: boolean };
export type Me = { auth: false } | Account;

/** A sign-in that did not work; the message is ready to show. */
export class SignInError extends Error {}

/** The header the hub's gate sets on its 401. Other 401s (an archive that needs its password) do not have it. */
const SIGNED_OUT = "x-filedeck-auth";
const isSignedOut = (r: Response) => r.status === 401 && r.headers.get(SIGNED_OUT) === "signed-out";

/** Who is signed in, `{auth:false}` when the hub has no sign-in, or "signed-out". Other failures throw. */
export async function me(): Promise<Me | "signed-out"> {
  const r = await fetch("/api/auth/me", { credentials: "same-origin" });
  if (isSignedOut(r)) return "signed-out";
  if (!r.ok) throw new Error(`/api/auth/me answered ${r.status}`);
  const b = (await r.json()) as Partial<Account>;
  return b.auth === true && typeof b.name === "string" ? { auth: true, kind: b.kind === "virt" ? "virt" : "sys", name: b.name, admin: b.admin === true } : { auth: false };
}

/** The line to show for a failed sign-in answer. */
export async function signInMessage(r: Response): Promise<string> {
  if (r.status === 401) return "Sign-in failed";
  if (r.status === 429) {
    const s = Math.max(1, Number.parseInt(r.headers.get("retry-after") ?? "", 10) || 1);
    return `Too many attempts. Try again in ${s} ${s === 1 ? "second" : "seconds"}`;
  }
  const b = (await r.json().catch(() => null)) as { error?: unknown } | null;
  return typeof b?.error === "string" ? b.error : `Sign-in failed (${r.status})`;
}

async function post(path: string, body: unknown): Promise<Response> {
  try {
    return await fetch(path, { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  } catch {
    throw new SignInError("Cannot reach the server");
  }
}

async function signedIn(r: Response): Promise<Account> {
  if (!r.ok) throw new SignInError(await signInMessage(r));
  return (await r.json()) as Account;
}

/** Signs in with a name and password. The password goes in the JSON body only. */
export async function login(name: string, password: string): Promise<Account> {
  return signedIn(await post("/api/auth/login", { name, password }));
}

/**
 * Signs in with an SSH key file. The file text and passphrase stay in the browser: the hub gets a fresh challenge
 * signed with the key, and the public key line. Throws KeyFileError for a file or passphrase problem.
 */
export async function loginKey(name: string, keyText: string, passphrase?: string): Promise<Account> {
  const r = await post("/api/auth/challenge", { name });
  if (!r.ok) throw new SignInError(await signInMessage(r));
  const { challenge, hubId } = (await r.json()) as { challenge: string; hubId: string };
  const ch = Uint8Array.from(atob(challenge), (c) => c.charCodeAt(0));
  // loaded only here: bcrypt-pbkdf and its SHA-512 are not needed by anyone who signs in with a password
  const { signLogin, toBase64 } = await import("./sshkey");
  const { publicKey, signature } = await signLogin(keyText, passphrase, hubId, name, ch);
  return signedIn(await post("/api/auth/login-key", { name, publicKey, challenge, signature: toBase64(signature) }));
}

export async function logout(): Promise<void> {
  await fetch("/api/auth/logout", { method: "POST", credentials: "same-origin" });
}

let signedOutHandler: (() => void) | null = null;

/**
 * Calls `onSignedOut` when any response is the gate's signed-out 401. Only the header counts: an archive's
 * "password_required" 401 is left alone, so its password prompt still opens. The response itself is passed on
 * as it is. Uploads use XMLHttpRequest; they report through `noteXhr`, which calls the same function.
 * Returns a function that puts the old fetch back.
 */
export function installSignedOutWatch(onSignedOut: () => void): () => void {
  const inner = globalThis.fetch;
  signedOutHandler = onSignedOut;
  const watched: typeof fetch = async (...args) => {
    const r = await inner(...args);
    if (isSignedOut(r)) onSignedOut();
    return r;
  };
  globalThis.fetch = watched;
  return () => {
    if (globalThis.fetch === watched) globalThis.fetch = inner;
    if (signedOutHandler === onSignedOut) signedOutHandler = null;
  };
}

/** For an XMLHttpRequest that has loaded: the same signed-out check as the fetch watch. */
export function noteXhr(x: Pick<XMLHttpRequest, "status" | "getResponseHeader">): void {
  if (x.status === 401 && x.getResponseHeader(SIGNED_OUT) === "signed-out") signedOutHandler?.();
}
