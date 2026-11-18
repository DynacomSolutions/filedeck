/**
 * Sign-in calls to the hub (server/src/auth/routes.ts) and the signed-out signal. With auth off the hub answers
 * `GET /api/auth/me` with `{auth:false}` and nothing else here is used.
 */
/**
 * A system administrator's act-as-root switch, when the hub reports it: `asRootUntil` is the end by the hub's clock,
 * `asRootLeftMs` the time left by the hub's clock, and `asRootEndsAt` the end by this browser's clock, worked out when
 * the answer arrived (now + time left), so a browser clock that is off does not hide or keep the switch.
 */
/** `method` is how the session signed in (`password`, `key` or `tailscale`); `tailnet` is the login or tag that matched, for a Tailscale session. */
export type Account = { auth: true; kind: "sys" | "virt"; name: string; admin: boolean; asRootUntil?: number; asRootLeftMs?: number; asRootEndsAt?: number; method?: string; tailnet?: string };
export type Me = { auth: false } | Account;

/** A sign-in that did not work; the message is ready to show. */
export class SignInError extends Error {}

/**
 * `GET /api/auth/me` answered the gate's tailnet 503 (with its header): a Tailscale session while tailscaled does not
 * answer. The hub keeps the session, so this is not a sign-out; ask again later (`retryDelayMs`).
 */
export class TailnetUnavailableError extends Error {}

/** The wait before the next `me` after the `n`th 503 in a row (from 0): 1 s, doubled each time, at most 30 s. */
export const retryDelayMs = (n: number): number => Math.min(30_000, 1000 * 2 ** Math.max(0, n));

/** The header the hub's gate sets on its 401. Other 401s (an archive that needs its password) do not have it. */
const SIGNED_OUT = "x-filedeck-auth";
const isSignedOut = (r: Response) => r.status === 401 && r.headers.get(SIGNED_OUT) === "signed-out";
/** The gate's 503 for a Tailscale session while tailscaled does not answer (the session is kept). Any other 503 is not this. */
const isTailnetDown = (r: Pick<Response, "status"> & { headers: { get(h: string): string | null } }) => r.status === 503 && r.headers.get(SIGNED_OUT) === "tailnet-unavailable";

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** Told who is signed in each time `me` learns it, before `me` returns (the saved node list is kept per account, data.ts). */
const accountListeners = new Set<(m: Me) => void>();
export function onAccountKnown(fn: (m: Me) => void): void {
  accountListeners.add(fn);
}

/** Who is signed in, `{auth:false}` when the hub has no sign-in, or "signed-out". Other failures throw. */
export async function me(): Promise<Me | "signed-out"> {
  const r = await fetch("/api/auth/me", { credentials: "same-origin" });
  if (isSignedOut(r)) return "signed-out";
  if (isTailnetDown(r)) throw new TailnetUnavailableError("Tailscale is not answering");
  if (!r.ok) throw new Error(`/api/auth/me answered ${r.status}`);
  const b = (await r.json()) as Partial<Account>;
  const m = whoFrom(b);
  for (const f of accountListeners) f(m);
  return m;
}

function whoFrom(b: Partial<Account>): Me {
  if (b.auth !== true || typeof b.name !== "string") return { auth: false };
  const kind = b.kind === "virt" ? "virt" : "sys";
  // only a system account can act as root; a virtual account never carries the switch
  const asRoot = kind === "sys" && finite(b.asRootUntil) && finite(b.asRootLeftMs) ? { asRootUntil: b.asRootUntil, asRootLeftMs: b.asRootLeftMs, asRootEndsAt: Date.now() + Math.max(0, b.asRootLeftMs) } : {};
  const how = typeof b.method === "string" ? { method: b.method, ...(typeof b.tailnet === "string" ? { tailnet: b.tailnet } : {}) } : {};
  return { auth: true, kind, name: b.name, admin: b.admin === true, ...asRoot, ...how };
}

/**
 * The tailnet identity the hub sees for this request, for the sign-in page's button: a login (with its display name),
 * or a tagged device's tags, and the device name when known. `{unavailable:true}` when the hub's source does not
 * answer (503). Null when there is no identity (`{}`), and for every other failure: the button is then not shown.
 */
export type Tailnet = { login?: string; displayName?: string; tags?: string[]; node?: string } | { unavailable: true } | null;

export async function tailnet(): Promise<Tailnet> {
  try {
    const r = await fetch("/api/auth/tailnet", { credentials: "same-origin" });
    if (isTailnetDown(r)) return { unavailable: true };
    if (r.status === 503) {
      // (the header is the sign; the body is the fallback for a proxy that drops headers)
      const e = (await r.json().catch(() => null)) as { error?: unknown } | null;
      return e?.error === "tailnet identity unavailable" ? { unavailable: true } : null;
    }
    if (!r.ok) return null;
    const b = (await r.json()) as { login?: unknown; displayName?: unknown; tags?: unknown; node?: { name?: unknown } | null } | null;
    if (!b || typeof b !== "object") return null;
    const tags = Array.isArray(b.tags) ? b.tags.filter((x): x is string => typeof x === "string") : [];
    const login = typeof b.login === "string" ? b.login : undefined;
    if (login === undefined && tags.length === 0) return null;
    const node = b.node && typeof b.node === "object" && typeof b.node.name === "string" ? b.node.name : undefined;
    return {
      ...(login !== undefined ? { login } : {}),
      ...(login !== undefined && typeof b.displayName === "string" ? { displayName: b.displayName } : {}),
      ...(tags.length > 0 ? { tags } : {}),
      ...(node !== undefined ? { node } : {}),
    };
  } catch {
    return null;
  }
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

/** The JSON part of a sign-in POST. Each caller writes its own `fetch` with a literal URL and method, so the request guard's route test can read it. */
const jsonBody = (body: unknown) => ({ credentials: "same-origin" as const, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

async function reach(send: () => Promise<Response>): Promise<Response> {
  try {
    return await send();
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
  return signedIn(await reach(() => fetch("/api/auth/login", { method: "POST", ...jsonBody({ name, password }) })));
}

/**
 * Signs in with the tailnet identity the hub sees for this request (an empty JSON body). A refusal says "Sign-in failed",
 * as for a password, whatever the reason (the hub's audit line has it).
 */
export async function loginTailscale(): Promise<Account> {
  const r = await reach(() => fetch("/api/auth/login-tailscale", { method: "POST", ...jsonBody({}) }));
  if (isTailnetDown(r)) throw new SignInError("Tailscale is not answering. Try again soon.");
  if (r.status === 503) throw new SignInError("The server is not answering. Try again soon.");
  return signedIn(r);
}

/**
 * Signs in with an SSH key file. The file text and passphrase stay in the browser: the hub gets a fresh challenge
 * signed with the key, and the public key line. Throws KeyFileError for a file or passphrase problem.
 */
export async function loginKey(name: string, keyText: string, passphrase?: string): Promise<Account> {
  const r = await reach(() => fetch("/api/auth/challenge", { method: "POST", ...jsonBody({ name }) }));
  if (!r.ok) throw new SignInError(await signInMessage(r));
  const { challenge, hubId } = (await r.json()) as { challenge: string; hubId: string };
  const ch = Uint8Array.from(atob(challenge), (c) => c.charCodeAt(0));
  // loaded only here: bcrypt-pbkdf and its SHA-512 are not needed by anyone who signs in with a password
  const { signLogin, toBase64 } = await import("./sshkey");
  const { publicKey, signature } = await signLogin(keyText, passphrase, hubId, name, ch);
  return signedIn(await reach(() => fetch("/api/auth/login-key", { method: "POST", ...jsonBody({ name, publicKey, challenge, signature: toBase64(signature) }) })));
}

/** A fresh proof for act as root: the password, or a key file (its text and passphrase stay here) for the signed-in account's own name. */
export type RootProof = { password: string } | { keyText: string; passphrase?: string; name: string };

/**
 * Turns on act as root for this session (system administrators only). The password goes in the JSON body only; a key
 * file signs a fresh challenge for `name` (the hub checks it against the session's own name) and only the public key
 * line and the signature are sent. Failures throw SignInError with the same messages as sign-in, or KeyFileError.
 */
/** Loads the key reader (./sshkey) on the key path only. An object, so a test can make the load fail. */
export const keyReader = { load: () => import("./sshkey") };

/**
 * The end of the switch by this browser's clock, from the hub's answer: now + the time left by the hub's clock.
 * `asRootUntil` stays as the hub gave it.
 */
export async function startAsRoot(proof: RootProof): Promise<{ asRootUntil: number; asRootEndsAt: number }> {
  let r: Response;
  if ("password" in proof) {
    r = await reach(() => fetch("/api/auth/as-root", { method: "POST", ...jsonBody({ password: proof.password }) }));
  } else {
    const c = await reach(() => fetch("/api/auth/challenge", { method: "POST", ...jsonBody({ name: proof.name }) }));
    if (!c.ok) throw new SignInError(await signInMessage(c));
    const { challenge, hubId } = (await c.json()) as { challenge: string; hubId: string };
    const ch = Uint8Array.from(atob(challenge), (x) => x.charCodeAt(0));
    let reader: Awaited<ReturnType<typeof keyReader.load>>;
    try {
      reader = await keyReader.load();
    } catch {
      throw new SignInError("Could not load the key reader. Reload the page.");
    }
    const { signLogin, toBase64 } = reader;
    const { publicKey, signature } = await signLogin(proof.keyText, proof.passphrase, hubId, proof.name, ch);
    r = await reach(() => fetch("/api/auth/as-root", { method: "POST", ...jsonBody({ publicKey, challenge, signature: toBase64(signature) }) }));
  }
  if (!r.ok) throw new SignInError(await signInMessage(r));
  const b = (await r.json().catch(() => null)) as { asRootUntil?: unknown; asRootLeftMs?: unknown } | null;
  if (!b || !finite(b.asRootUntil) || !finite(b.asRootLeftMs)) throw new SignInError("Act as root failed");
  return { asRootUntil: b.asRootUntil, asRootEndsAt: Date.now() + Math.max(0, b.asRootLeftMs) };
}

/** Turns act as root off for this session. Throws when the hub does not confirm it. */
export async function stopAsRoot(): Promise<void> {
  const r = await fetch("/api/auth/as-root", { method: "DELETE", credentials: "same-origin" });
  if (!r.ok) throw new Error(`stopping act as root failed (${r.status})`);
}

export async function logout(): Promise<void> {
  await fetch("/api/auth/logout", { method: "POST", credentials: "same-origin" });
}

let signedOutHandler: (() => void) | null = null;
let tailnetDownHandler: (() => void) | null = null;

/**
 * Calls `onSignedOut` when any response is the gate's signed-out 401. Only the header counts: an archive's
 * "password_required" 401 is left alone, so its password prompt still opens. The response itself is passed on
 * as it is. `onTailnetDown` is called for the gate's tailnet 503 (a Tailscale session while tailscaled does not
 * answer; the session is kept). Uploads use XMLHttpRequest; they report through `noteXhr`, which calls the same
 * functions. Returns a function that puts the old fetch back.
 */
export function installSignedOutWatch(onSignedOut: () => void, onTailnetDown?: () => void): () => void {
  const inner = globalThis.fetch;
  signedOutHandler = onSignedOut;
  tailnetDownHandler = onTailnetDown ?? null;
  const watched: typeof fetch = async (...args) => {
    const r = await inner(...args);
    if (isSignedOut(r)) onSignedOut();
    else if (isTailnetDown(r)) onTailnetDown?.();
    return r;
  };
  globalThis.fetch = watched;
  return () => {
    if (globalThis.fetch === watched) globalThis.fetch = inner;
    if (signedOutHandler === onSignedOut) signedOutHandler = null;
    if (tailnetDownHandler === (onTailnetDown ?? null)) tailnetDownHandler = null;
  };
}

/** For an XMLHttpRequest that has loaded: the same signed-out and tailnet checks as the fetch watch. */
export function noteXhr(x: Pick<XMLHttpRequest, "status" | "getResponseHeader">): void {
  if (x.status === 401 && x.getResponseHeader(SIGNED_OUT) === "signed-out") signedOutHandler?.();
  else if (isTailnetDown({ status: x.status, headers: { get: (h) => x.getResponseHeader(h) } })) tailnetDownHandler?.();
}
