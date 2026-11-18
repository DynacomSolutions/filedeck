import type { AccountInput, AccountView, NodeAccess, SourceAccess } from "./admin";

/**
 * The account editor's form, and the step to and from what the hub takes and gives. `formProblems` is the client-side twin of the hub's
 * checks (server/src/auth/account-input.ts) for the messages it can give at once; the hub checks everything again.
 */

export type SourceChoice = "none" | "read" | "write";
export type MachineForm = { node: string; runAs: string; grants: { path: string; write: boolean }[] };
export type AccountForm = { name: string; password: string; admin: boolean; machines: MachineForm[]; sources: Record<string, SourceChoice>; tailnet: string[] };

/** The same rule as the hub's account names. */
const NAME = /^[a-z_][a-z0-9_.-]{0,31}$/;
export const MIN_PASSWORD = 12;
export const MAX_PASSWORD = 1024;
/** The hub's limit on tailnet links per account. */
export const MAX_LINKS = 16;

/** The same rules as the hub's links (server/src/auth/tailnet.ts): printable ASCII, trimmed and lowercased. */
const LOGIN = /^[a-z0-9!#$%&'*+/=?^_`{|}~.-]{1,64}@[a-z0-9-]+(\.[a-z0-9-]+)*$/;
const TAG = /^tag:[a-z0-9-]{1,63}$/;

/**
 * One link as the hub keeps it: ASCII white space trimmed, then (only when what is left is printable ASCII) lowercased. A value with other
 * characters stays as typed, so no case folding (the Kelvin sign lowercases to `k`) can turn it into a near match. Not checked.
 */
export const cleanLink = (v: string): string => {
  const s = v.replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, "");
  return /^[\x21-\x7e]*$/.test(s) ? s.toLowerCase() : s;
};

/** What a value is as a tailnet link: a login, a tag, or null when it is neither (the client twin of the hub's `tailnetLink`). */
export function linkKind(v: string): "login" | "tag" | null {
  const s = cleanLink(v);
  if (!/^[\x21-\x7e]*$/.test(s)) return null;
  if (s.startsWith("tag:")) return TAG.test(s) ? "tag" : null;
  return s.length <= 254 && LOGIN.test(s) ? "login" : null;
}

/** The links of a list in one fixed order, as a string: two lists with the same links are the same, whatever the order they were added in. */
export const linksKey = (list: readonly string[]): string => JSON.stringify(cleanLinks(list).sort());

/** The links of a list, cleaned, empty ones dropped and duplicates merged at the first place. */
export const cleanLinks = (list: readonly string[]): string[] => [...new Set(list.map(cleanLink).filter((x) => x !== ""))];

/** A machine counts once it has a run-as user or a folder; an untouched section is left out. */
const used = (m: MachineForm) => m.runAs.trim() !== "" || m.grants.some((g) => g.path.trim() !== "");

/** The machines and network sources the hub has configured now (`overview()`). */
export type Configured = { nodes: readonly string[]; sources: readonly string[] };

/** The machines and sources the form names that are not configured now: the hub refuses them, so `toInput` leaves them out. */
export function notConfigured(f: AccountForm, known: Configured): { machines: string[]; sources: string[] } {
  return {
    machines: f.machines.filter((m) => used(m) && !known.nodes.includes(m.node)).map((m) => m.node),
    sources: Object.entries(f.sources).filter(([name, c]) => c !== "none" && !known.sources.includes(name)).map(([name]) => name),
  };
}

/**
 * What the hub takes: trimmed, without untouched machines, sources set to none or an empty password. With `known`, machines and sources
 * that are not configured now are left out too: the hub would refuse the whole change for them, and machines and sources are replaced
 * as a whole, so saving drops those grants.
 */
export function toInput(f: AccountForm, known?: Configured): AccountInput {
  const nodes: Record<string, NodeAccess> = {};
  for (const m of f.machines) {
    if (!used(m) || (known && !known.nodes.includes(m.node))) continue;
    nodes[m.node] = { runAs: m.runAs.trim(), grants: m.grants.filter((g) => g.path.trim() !== "").map((g) => ({ path: g.path.trim(), write: g.write })) };
  }
  const sources: Record<string, SourceAccess> = {};
  for (const [name, choice] of Object.entries(f.sources)) if (choice !== "none" && (!known || known.sources.includes(name))) sources[name] = { write: choice === "write" };
  // a password is sent as typed: spaces at its ends are part of it
  return { name: f.name.trim(), ...(f.password !== "" ? { password: f.password } : {}), admin: f.admin, nodes, sources, tailnet: cleanLinks(f.tailnet) };
}

/** The form for an existing account. Its password is never known here, so the field starts empty. */
export function fromView(v: AccountView): AccountForm {
  const sources: Record<string, SourceChoice> = {};
  for (const [name, a] of Object.entries(v.sources)) sources[name] = a.write ? "write" : "read";
  return {
    name: v.name,
    password: "",
    admin: v.admin,
    machines: Object.entries(v.nodes).map(([node, a]) => ({ node, runAs: a.runAs, grants: a.grants.map((g) => ({ path: g.path, write: g.write })) })),
    sources,
    tailnet: v.tailnet.map((l) => l.subject),
  };
}

/** Whether `now` holds changes against `start`: a typed password, or any field that differs. Sources set to none count as absent. */
export function formChanged(start: AccountForm, now: AccountForm): boolean {
  if (now.password !== "") return true;
  const norm = (f: AccountForm) =>
    JSON.stringify([f.name.trim(), f.admin, f.machines.map((m) => [m.node, m.runAs.trim(), m.grants]), Object.entries(f.sources).filter(([, c]) => c !== "none").sort(([a], [b]) => (a < b ? -1 : 1)), linksKey(f.tailnet)]);
  return norm(start) !== norm(now);
}

/** The problems that can be seen before asking the hub, as sentences to show. Empty when there are none. */
export function formProblems(f: AccountForm): string[] {
  const out: string[] = [];
  const name = f.name.trim();
  if (name === "root") out.push("The name root is not allowed.");
  else if (!NAME.test(name)) out.push("The name must be 1 to 32 characters of a-z, 0-9, _, . and -, and start with a-z or _.");
  // counted in characters (code points), as the hub counts them
  const length = [...f.password].length;
  if (f.password !== "" && (length < MIN_PASSWORD || length > MAX_PASSWORD)) out.push(`The password must be ${MIN_PASSWORD} to ${MAX_PASSWORD} characters.`);
  for (const m of f.machines) {
    const grants = m.grants.filter((g) => g.path.trim() !== "");
    if (m.runAs.trim() === "" && grants.length > 0) out.push(`Give a run-as user on ${m.node}, or remove its folders.`);
    if (m.runAs.trim() !== "" && grants.length === 0) out.push(`Give at least one folder on ${m.node}, or clear its run-as user.`);
    for (const g of grants) if (!g.path.trim().startsWith("/")) out.push(`A folder on ${m.node} must start with /: ${g.path.trim()}`);
  }
  const links = cleanLinks(f.tailnet);
  for (const l of links) if (linkKind(l) === null) out.push(`This is not a tailnet login or tag: ${l}`);
  if (links.length > MAX_LINKS) out.push(`At most ${MAX_LINKS} tailnet links per account.`);
  return out;
}

/**
 * Whether a link can sign in with the hub's Tailscale source (the same rule as the hub's `lockOut`): with the socket every link counts,
 * with headers only a login does (a tag cannot sign in), and with no source none.
 */
export function linkCounts(subject: string, mode: "socket" | "headers" | null): boolean {
  if (mode === null) return false;
  return mode === "socket" || linkKind(subject) !== "tag";
}

/** Whether any of `subjects` counts for `mode` (`linkCounts`). */
export const anyLinkCounts = (subjects: readonly string[], mode: "socket" | "headers" | null): boolean => subjects.some((l) => linkCounts(l, mode));
