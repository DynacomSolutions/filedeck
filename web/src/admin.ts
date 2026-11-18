/**
 * Calls to the hub's admin routes (server/src/auth/admin-routes.ts, sign-in on and administrators only). Each function writes its own
 * `fetch` with a literal URL and method, as in auth.ts, so the request guard's route test can read it. A password goes in the JSON body
 * only, never in a URL. A refusal throws `AdminError` with the hub's `error` text, ready to show.
 */

/** One folder a virtual account may use on a machine. */
export type Grant = { path: string; write: boolean };
/** A virtual account's access on one machine: the system user it acts as there and its folders, the first one the folder it opens. */
export type NodeAccess = { runAs: string; grants: Grant[] };
/** Access to one network source: read-only, or read and write. */
export type SourceAccess = { write: boolean };

/** One tailnet link: a login (`alice@github`) or a tag (`tag:server`) that may sign in as an account. */
export type TailnetLink = { subject: string; kind: "login" | "tag" };

/** A virtual account as administrators see it: never its password hash, keys only as fingerprint, type and comment. */
export type AccountView = {
  name: string;
  admin: boolean;
  hasPassword: boolean;
  keys: { fingerprint: string; type: string; comment?: string }[];
  nodes: Record<string, NodeAccess>;
  sources: Record<string, SourceAccess>;
  sessions: number;
  tailnet: TailnetLink[];
};

/** A system user the hub knows of: named in FILEDECK_ADMINS, given a source grant or a tailnet link, or signed in now. */
export type SystemView = { name: string; admin: boolean; sources: Record<string, SourceAccess>; sessions: number; tailnet: TailnetLink[] };

/** One signed-in session. `method` is how it signed in and `tailnet` the login or tag that matched for a Tailscale session; `tailnetSource` and `tailnetDevice` are shown when the hub gives them. `id` is derived from the session key and leads back to neither it nor the cookie. `current` marks the caller's. */
export type SessionInfo = { id: string; kind: "sys" | "virt"; name: string; created: number; lastUsed: number; address?: string; asRootUntil?: number; current?: true; method?: "password" | "key" | "tailscale"; tailnet?: string; tailnetSource?: "socket" | "headers"; tailnetDevice?: string };

/** `tailscale` is the configured Tailscale source, or null when Tailscale sign-in is off on this hub. */
export type Overview = { nodes: string[]; sources: { name: string; type: string }[]; systemAdmins: string[]; unownedPasswords: number; tailscale: "socket" | "headers" | null };

export type AccountInput = { name: string; password?: string; admin: boolean; nodes: Record<string, NodeAccess>; sources: Record<string, SourceAccess>; tailnet?: string[] };

/** A refused or failed admin call; the message is ready to show. `status` is 0 when the server could not be reached. */
export class AdminError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "AdminError";
  }
}

const same = { credentials: "same-origin" as const };
/** The JSON part of a request with a body. */
const jsonBody = (body: unknown) => ({ ...same, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const seg = (s: string) => encodeURIComponent(s);

async function reach(send: () => Promise<Response>): Promise<Response> {
  try {
    return await send();
  } catch {
    throw new AdminError("Cannot reach the server", 0);
  }
}

/** The answer's JSON, or an AdminError with the hub's `error` text (or the status when there is none). */
async function answer<T>(send: () => Promise<Response>): Promise<T> {
  const r = await reach(send);
  if (!r.ok) {
    const b = (await r.json().catch(() => null)) as { error?: unknown } | null;
    throw new AdminError(typeof b?.error === "string" && b.error ? b.error : `The server answered ${r.status}`, r.status);
  }
  return (await r.json().catch(() => {
    throw new AdminError(`The server answered ${r.status} without data`, r.status);
  })) as T;
}

export function overview(): Promise<Overview> {
  return answer(() => fetch("/api/admin/overview", { ...same }));
}

export function listAccounts(): Promise<{ accounts: AccountView[]; system: SystemView[] }> {
  return answer(() => fetch("/api/admin/accounts", { ...same }));
}

export function createAccount(input: AccountInput): Promise<AccountView> {
  return answer(() => fetch("/api/admin/accounts", { method: "POST", ...jsonBody(input) }));
}

/** Changes what `patch` names; `password: null` removes the password. Every change signs the account out everywhere. */
export function updateAccount(name: string, patch: Partial<Omit<AccountInput, "password">> & { password?: string | null }): Promise<AccountView> {
  return answer(() => fetch(`/api/admin/accounts/${seg(name)}`, { method: "PATCH", ...jsonBody(patch) }));
}

export async function deleteAccount(name: string): Promise<void> {
  await answer(() => fetch(`/api/admin/accounts/${seg(name)}`, { method: "DELETE", ...same }));
}

export function addKey(name: string, publicKey: string): Promise<AccountView> {
  return answer(() => fetch(`/api/admin/accounts/${seg(name)}/keys`, { method: "POST", ...jsonBody({ publicKey }) }));
}

export function removeKey(name: string, fingerprint: string): Promise<AccountView> {
  return answer(() => fetch(`/api/admin/accounts/${seg(name)}/keys/${seg(fingerprint)}`, { method: "DELETE", ...same }));
}

/** A system user's network sources, replaced as a whole (`{}` takes them all away). */
export function setSystemSources(name: string, sources: Record<string, SourceAccess>): Promise<SystemView> {
  return answer(() => fetch(`/api/admin/system/${seg(name)}/sources`, { method: "PUT", ...jsonBody({ sources }) }));
}

/** A system user's tailnet links (logins and tags), replaced as a whole (`[]` takes them all away). Ends the sessions that came through a removed link. */
export function setSystemTailnet(name: string, links: string[]): Promise<SystemView> {
  return answer(() => fetch(`/api/admin/system/${seg(name)}/tailnet`, { method: "PUT", ...jsonBody({ links }) }));
}

export async function listSessions(): Promise<SessionInfo[]> {
  return (await answer<{ sessions: SessionInfo[] }>(() => fetch("/api/admin/sessions", { ...same }))).sessions;
}

/** Ends one session and its streams. The account's jobs go on. */
export async function endSession(id: string): Promise<void> {
  await answer(() => fetch(`/api/admin/sessions/${seg(id)}`, { method: "DELETE", ...same }));
}

/** Ends every session of one account, and cancels its jobs. */
export async function endAccountSessions(kind: "sys" | "virt", name: string): Promise<void> {
  await answer(() => fetch("/api/admin/end-sessions", { method: "POST", ...jsonBody({ kind, name }) }));
}

/** Forgets the passwords saved while sign-in was off; gives back how many went. */
export async function forgetUnownedPasswords(): Promise<number> {
  return (await answer<{ removed: number }>(() => fetch("/api/admin/vault/unowned", { method: "DELETE", ...same }))).removed;
}

/** The client's twin of the hub's system user name check (never root); the hub checks again and its text is what is shown. "" when fine. */
export function systemUserProblem(raw: string): string {
  const name = raw.trim();
  if (name === "") return "Give the system user's name.";
  if (name === "root") return "root cannot be given sources here.";
  if (!/^[A-Za-z0-9_][A-Za-z0-9_.@-]{0,63}$/.test(name)) return "This is not a valid system user name.";
  return "";
}

/** The sessions of each account together, accounts in the order they first appear (the hub lists the most recently used first). */
export function sessionsByAccount(list: SessionInfo[]): { kind: "sys" | "virt"; name: string; sessions: SessionInfo[] }[] {
  const groups = new Map<string, { kind: "sys" | "virt"; name: string; sessions: SessionInfo[] }>();
  for (const s of list) {
    const key = `${s.kind}:${s.name}`;
    const g = groups.get(key) ?? { kind: s.kind, name: s.name, sessions: [] };
    g.sessions.push(s);
    groups.set(key, g);
  }
  return [...groups.values()];
}
