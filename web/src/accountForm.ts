import type { AccountInput, AccountView, NodeAccess, SourceAccess } from "./admin";

/**
 * The account editor's form, and the step to and from what the hub takes and gives. `formProblems` is the client-side twin of the hub's
 * checks (server/src/auth/account-input.ts) for the messages it can give at once; the hub checks everything again.
 */

export type SourceChoice = "none" | "read" | "write";
export type MachineForm = { node: string; runAs: string; grants: { path: string; write: boolean }[] };
export type AccountForm = { name: string; password: string; admin: boolean; machines: MachineForm[]; sources: Record<string, SourceChoice> };

/** The same rule as the hub's account names. */
const NAME = /^[a-z_][a-z0-9_.-]{0,31}$/;
export const MIN_PASSWORD = 12;
export const MAX_PASSWORD = 1024;

/** A machine counts once it has a run-as user or a folder; an untouched section is left out. */
const used = (m: MachineForm) => m.runAs.trim() !== "" || m.grants.some((g) => g.path.trim() !== "");

/** What the hub takes: trimmed, without untouched machines, sources set to none or an empty password. */
export function toInput(f: AccountForm): AccountInput {
  const nodes: Record<string, NodeAccess> = {};
  for (const m of f.machines) {
    if (!used(m)) continue;
    nodes[m.node] = { runAs: m.runAs.trim(), grants: m.grants.filter((g) => g.path.trim() !== "").map((g) => ({ path: g.path.trim(), write: g.write })) };
  }
  const sources: Record<string, SourceAccess> = {};
  for (const [name, choice] of Object.entries(f.sources)) if (choice !== "none") sources[name] = { write: choice === "write" };
  // a password is sent as typed: spaces at its ends are part of it
  return { name: f.name.trim(), ...(f.password !== "" ? { password: f.password } : {}), admin: f.admin, nodes, sources };
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
  };
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
  return out;
}
