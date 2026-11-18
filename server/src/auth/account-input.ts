import { validSystemName } from "../local-accounts.ts";
import { OWNER_NAME, PathError, cleanVirtual, isReservedName } from "../paths.ts";
import type { Grant, NodeAccess } from "./identity.ts";
import type { SourceAccess } from "./source-grants.ts";
import { parsePublicKey } from "./sshkey.ts";
import { cleanLogin, cleanTag } from "./tailnet.ts";
import type { Link } from "./tailnet-links.ts";

/**
 * Checks what an administrator sends to the admin routes. Each function takes the raw JSON value and gives back the cleaned value, or
 * throws `InputError`, whose message the hub answers with status 400. A message names the field and never repeats a password or a key.
 */
export class InputError extends Error {}

export const MIN_PASSWORD = 12;
export const MAX_PASSWORD = 1024;
export const MAX_GRANTS = 64;
export const MAX_KEYS = 32;
/** The most tailnet links (logins and tags together) one account may have. */
export const MAX_TAILNET_LINKS = 16;
/**
 * The most one machine's grants may take as JSON. They travel in the signed user header to the agent, whose server takes headers up to
 * 16 KiB in all; past that every request to the machine would fail with 431.
 */
export const MAX_GRANTS_JSON = 8192;
/** The longest public key line accepted, in bytes. */
const MAX_KEY_LINE = 8 * 1024;
/** The longest key comment kept, in characters. */
const MAX_KEY_COMMENT = 128;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** A virtual account name: the same rule as the account store and its folder names, never `root`, never a system administrator's name. */
export function accountName(v: unknown, systemAdmins: readonly string[]): string {
  if (typeof v !== "string" || !OWNER_NAME.test(v)) {
    throw new InputError("name must be 1 to 32 characters of a-z, 0-9, _, . and -, and start with a-z or _");
  }
  if (v === "root") throw new InputError("name root is not allowed");
  if (systemAdmins.includes(v)) throw new InputError(`name ${v} belongs to a system administrator`);
  return v;
}

/** A system user name (a `runAs`, or a system user given source grants): `validSystemName`, never `root`. */
export function systemName(v: unknown, field = "user name"): string {
  if (typeof v !== "string" || !validSystemName(v)) throw new InputError(`${field} is not a valid system user name`);
  if (v === "root") throw new InputError(`${field} may not be root`);
  return v;
}

export function newPassword(v: unknown): string {
  if (typeof v !== "string") throw new InputError("password must be text");
  const length = [...v].length; // in characters (code points), not UTF-16 units
  if (length < MIN_PASSWORD || length > MAX_PASSWORD) {
    throw new InputError(`password must be ${MIN_PASSWORD} to ${MAX_PASSWORD} characters`);
  }
  return v;
}

/** One folder path: absolute, cleaned to `/a/b`, with no reserved segment. */
function grantPath(v: unknown): string {
  if (typeof v !== "string" || !v.startsWith("/")) throw new InputError("folder path must be an absolute path");
  let parts: string[];
  try {
    parts = cleanVirtual(v);
  } catch (e) {
    if (e instanceof PathError) throw new InputError(`folder path: ${e.message}`);
    throw e;
  }
  if (parts.some(isReservedName)) throw new InputError("folder path may not go through a folder reserved for Filedeck's own use");
  return "/" + parts.join("/");
}

/**
 * A list of folder grants on one machine. Paths are cleaned; two entries for one path become one (writable if either is) at the place
 * of the first; the given order is kept otherwise (the first grant is the folder the web app opens).
 */
export function grants(v: unknown): Grant[] {
  if (!Array.isArray(v)) throw new InputError("folders must be a list");
  if (v.length > MAX_GRANTS) throw new InputError(`at most ${MAX_GRANTS} folders per machine`);
  const out: Grant[] = [];
  const at = new Map<string, number>();
  for (const g of v) {
    if (!isObject(g)) throw new InputError("each folder must be an object with path and write");
    const path = grantPath(g.path);
    if (typeof g.write !== "boolean") throw new InputError("folder write must be true or false");
    const i = at.get(path);
    if (i === undefined) {
      at.set(path, out.length);
      out.push({ path, write: g.write });
    } else if (g.write) out[i]!.write = true;
  }
  return out;
}

/** Per machine access of a virtual account: every machine known, a valid `runAs` and at least one folder. */
export function nodeAccess(v: unknown, knownNodes: ReadonlySet<string>): Record<string, NodeAccess> {
  if (!isObject(v)) throw new InputError("machines must be an object");
  const out: Record<string, NodeAccess> = {};
  for (const [node, a] of Object.entries(v)) {
    if (!knownNodes.has(node)) throw new InputError(`unknown machine ${node}`);
    if (!isObject(a)) throw new InputError(`access on ${node} must be an object with runAs and grants`);
    const runAs = systemName(a.runAs, `run-as user on ${node}`);
    const list = grants(a.grants);
    if (list.length === 0) throw new InputError(`give at least one folder on ${node}`);
    if (JSON.stringify(list).length > MAX_GRANTS_JSON) {
      throw new InputError(`the folders on ${node} are too long together: their paths may take about ${MAX_GRANTS_JSON / 1024} KiB in all`);
    }
    out[node] = { runAs, grants: list };
  }
  return out;
}

/** Network source grants: every source known, each `{ write: boolean }`. */
export function sourceAccess(v: unknown, knownSources: ReadonlySet<string>): Record<string, SourceAccess> {
  if (!isObject(v)) throw new InputError("sources must be an object");
  const out: Record<string, SourceAccess> = {};
  for (const [source, a] of Object.entries(v)) {
    if (!knownSources.has(source)) throw new InputError(`unknown network source ${source}`);
    if (!isObject(a) || typeof a.write !== "boolean") throw new InputError(`access to ${source} must be { write: true or false }`);
    out[source] = { write: a.write };
  }
  return out;
}

/**
 * One SSH public key line, as `parsePublicKey` accepts it (Ed25519 or ECDSA P-256, no options), given back as
 * `<type> <base64>[ <comment>]`. Control (Cc: C0, DEL, C1) and format (Cf: bidi marks, zero-width characters) characters are
 * dropped from the comment, so it cannot fake text in the admin screens or the audit log; then it is cut to 128 characters and trimmed.
 */
export function publicKey(v: unknown): string {
  if (typeof v !== "string") throw new InputError("public key must be text");
  if (Buffer.byteLength(v, "utf8") > MAX_KEY_LINE) throw new InputError(`public key must be at most ${MAX_KEY_LINE / 1024} KiB`);
  if (!parsePublicKey(v)) {
    throw new InputError("public key must be one ssh-ed25519 or ecdsa-sha2-nistp256 line, without options");
  }
  const m = /^(\S+)[ \t]+(\S+)(?:[ \t]+(.*))?$/.exec(v.trim());
  if (!m) throw new InputError("public key must be one ssh-ed25519 or ecdsa-sha2-nistp256 line, without options");
  // Cut by code points, so a character outside the BMP is never split in half.
  const comment = Array.from((m[3] ?? "").replace(/[\p{Cc}\p{Cf}]/gu, ""))
    .slice(0, MAX_KEY_COMMENT)
    .join("")
    .trim();
  return comment ? `${m[1]} ${m[2]} ${comment}` : `${m[1]} ${m[2]}`;
}

const TAILNET_LINK_MESSAGE = "a tailnet link must be a login such as alice@github or a tag such as tag:server (letters, digits and dashes)";

/**
 * One tailnet link: trimmed and lowercased, then a tag when it starts with `tag:` (`cleanTag`), else a login (`cleanLogin`, never
 * `tagged-devices`). Gives the cleaned subject with its kind.
 */
export function tailnetLink(v: unknown): Link {
  if (typeof v !== "string") throw new InputError(TAILNET_LINK_MESSAGE);
  const isTag = v.trim().toLowerCase().startsWith("tag:");
  const subject = isTag ? cleanTag(v) : cleanLogin(v);
  if (subject === null) throw new InputError(TAILNET_LINK_MESSAGE);
  return { subject, kind: isTag ? "tag" : "login" };
}

/** The whole list of an account's tailnet links: each cleaned, duplicates merged at the place of the first, at most 16 after that. */
export function tailnetLinks(v: unknown): Link[] {
  if (!Array.isArray(v)) throw new InputError("tailnet links must be a list");
  const out: Link[] = [];
  const seen = new Set<string>();
  for (const x of v) {
    const l = tailnetLink(x);
    if (seen.has(l.subject)) continue;
    seen.add(l.subject);
    out.push(l);
    if (out.length > MAX_TAILNET_LINKS) throw new InputError(`at most ${MAX_TAILNET_LINKS} tailnet links per account`);
  }
  return out;
}
