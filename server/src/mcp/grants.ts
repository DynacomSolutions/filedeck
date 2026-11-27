import { createHash, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";

/**
 * Grants: each one is a read-only access with its own token and its own scope. The hub reads the list from a JSON file and each token from a file
 * (both mounted by the chart) and reads them again every few seconds, so a grant that is removed, or whose token or scope changes, stops working with
 * no restart. A grant never gives more than the tools do (every tool only reads); it gives less: only the tools and resources it names.
 *
 * File format: an array of `{ "id", "tokenFile", "resources": [...], "tools": [...], "account"? }`.
 */

export interface Grant {
  id: string;
  /** hash of the id, the scope, the account and the token: it changes when any of them changes */
  fingerprint: string;
  resources: readonly string[];
  tools: readonly string[];
  account?: string;
  tokenDigest: Buffer;
}

export const GRANT_ID = /^[a-z0-9][a-z0-9-]{0,31}$/;
const MIN_TOKEN = 16;
const digest = (s: string) => createHash("sha256").update(s).digest();

/**
 * A resource entry is a URI template (it has `{name}` parts; each matches one path segment), a URI prefix (it ends with `/`: every URI that starts
 * with it) or a single URI (the rest: an exact match only, so `filedeck://nodes` is the node list and nothing below it).
 */
export function uriMatches(entry: string, uri: string): boolean {
  if (!entry.includes("{")) return entry.endsWith("/") ? uri.startsWith(entry) : uri === entry;
  return templateRegExp(entry).test(uri);
}

const templateRegExp = (entry: string) =>
  new RegExp(`^${entry.split(/\{[^}]+\}/).map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("[^/]+")}$`);

const literalPrefix = (s: string) => s.slice(0, s.includes("{") ? s.indexOf("{") : s.length);

/** Whether an entry can match some URI of a template: the literal beginnings agree. A single URI must fit the template itself. */
export function couldMatch(entry: string, template: string): boolean {
  if (!entry.includes("{") && !entry.endsWith("/")) return templateRegExp(template).test(entry);
  const a = literalPrefix(entry);
  const b = literalPrefix(template);
  return a.startsWith(b) || b.startsWith(a);
}

/** What a session may do: the grant's tools and resources. */
export class Scope {
  constructor(private readonly grant: Pick<Grant, "tools" | "resources">) {}

  allowsTool(name: string): boolean {
    return this.grant.tools.includes("*") || this.grant.tools.includes(name);
  }

  allowsResource(uri: string): boolean {
    return this.grant.resources.some((e) => uriMatches(e, uri));
  }

  /** Whether the grant may use a resource template at all (some URI of it may match). */
  allowsTemplate(template: string): boolean {
    return this.grant.resources.some((e) => couldMatch(e, template));
  }

  /**
   * A tool with a `node` argument, and the node watches, need the node itself in the grant: the prefix `filedeck://nodes/<node>/` (or a template
   * such as `filedeck://nodes/{node}/`). A grant for one resource of a node (its status, scans or jobs) does not give the tools on that node.
   */
  allowsNode(node: string): boolean {
    return this.allowsResource(`filedeck://nodes/${encodeURIComponent(node)}/`);
  }

  get allowsHubJobs(): boolean {
    return this.allowsResource("filedeck://hub/jobs");
  }
}

export interface GrantStoreOptions {
  file: string;
  pollMs?: number;
  log?: (msg: string) => void;
}

export class GrantStore {
  private current = new Map<string, Grant>();
  private timer?: NodeJS.Timeout;
  private readonly listeners: ((revoked: string[]) => void)[] = [];
  private loaded = false;

  constructor(private readonly o: GrantStoreOptions) {}

  get ready(): boolean {
    return this.loaded;
  }

  get grants(): Grant[] {
    return [...this.current.values()];
  }

  /** Called with the ids of grants that were removed or changed, after each reload. */
  onRevoked(f: (revoked: string[]) => void): void {
    this.listeners.push(f);
  }

  /** The grant whose token this is. Every grant is compared, so the time does not tell which one is close. */
  match(token: string): Grant | undefined {
    const d = digest(token);
    let found: Grant | undefined;
    for (const g of this.current.values()) if (timingSafeEqual(d, g.tokenDigest)) found = g;
    return found;
  }

  /** Reads the files. Returns false when the list file is unreadable or invalid (the old list stays: a half-written file must not revoke everyone). */
  async reload(): Promise<boolean> {
    const log = this.o.log ?? ((m: string) => console.error(m));
    let list: unknown;
    try {
      list = JSON.parse(await readFile(this.o.file, "utf8"));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
        log(`MCP grants file is not readable JSON, the grants stay as they were: ${(e as Error).message}`);
        return false;
      }
      list = [];
    }
    if (!Array.isArray(list)) {
      log("MCP grants file must hold a JSON array, the grants stay as they were");
      return false;
    }
    const next = new Map<string, Grant>();
    const tokens = new Set<string>();
    for (const raw of list as Record<string, unknown>[]) {
      const id = typeof raw?.id === "string" ? raw.id : "";
      const strings = (v: unknown) => (Array.isArray(v) && v.every((x) => typeof x === "string" && x) ? (v as string[]) : undefined);
      const resources = strings(raw?.resources);
      const tools = strings(raw?.tools);
      if (!GRANT_ID.test(id) || next.has(id) || !resources?.length || !tools?.length || typeof raw.tokenFile !== "string") {
        log(`MCP grant ${JSON.stringify(id)} is ignored: it needs a unique id (a-z, 0-9, -), resources, tools and tokenFile`);
        continue;
      }
      let token: string;
      try {
        token = (await readFile(raw.tokenFile, "utf8")).trim();
      } catch {
        log(`MCP grant ${id} is off: its token file cannot be read`);
        continue;
      }
      if (token.length < MIN_TOKEN) {
        log(`MCP grant ${id} is off: its token is shorter than ${MIN_TOKEN} characters`);
        continue;
      }
      if (tokens.has(token)) {
        log(`MCP grant ${id} is off: it has the same token as another grant`);
        continue;
      }
      tokens.add(token);
      const account = typeof raw.account === "string" && raw.account ? raw.account : undefined;
      next.set(id, {
        id,
        resources,
        tools,
        account,
        tokenDigest: digest(token),
        fingerprint: createHash("sha256").update(JSON.stringify([id, resources, tools, account ?? null, token])).digest("hex"),
      });
    }
    const revoked = [...this.current.values()].filter((g) => next.get(g.id)?.fingerprint !== g.fingerprint).map((g) => g.id);
    this.current = next;
    this.loaded = true;
    if (revoked.length) for (const f of this.listeners) f(revoked);
    return true;
  }

  start(): void {
    this.timer = setInterval(() => void this.reload().catch(() => undefined), this.o.pollMs ?? 2000);
    this.timer.unref();
  }

  stop(): void {
    clearInterval(this.timer);
  }
}
