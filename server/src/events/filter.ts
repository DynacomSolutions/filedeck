import { FsError } from "../fsops.ts";
import { GLOB_SKIP, compileGlobs, type Matcher } from "../glob.ts";
import { CONTROL_KINDS, KINDS, type Matchable } from "./types.ts";

/**
 * A subscriber's filter, evaluated in the agent before any byte is sent. Every part is optional; an event passes when it passes all parts
 * that are given (a part with several values passes when any one value matches, except `label`, which needs every key to match).
 *  - `prefix`: the event's path (or, for a move, the path it came from) is the prefix or is below it
 *  - `glob`: the event's path (or its old path) matches one of the globs (the matcher of the folder compare, see glob.ts: linear time)
 *  - `kind`: one of the kinds
 *  - `type`: `file` or `dir`
 *  - `label`: `key:value`; the same key twice means either value
 * Control events (overflow, reset, ready) always pass: a client that filters must still learn that it has to look again.
 */
export interface FilterSpec {
  prefix?: string[];
  glob?: string[];
  kind?: string[];
  type?: string;
  label?: string[];
}

const MAX_VALUES = 32;
const MAX_LEN = 4096;

const list = (v: unknown, what: string): string[] => {
  if (v === undefined || v === null || v === "") return [];
  const a = Array.isArray(v) ? v : [v];
  if (a.length > MAX_VALUES) throw new FsError(400, `filter: at most ${MAX_VALUES} values for ${what}`);
  for (const x of a) if (typeof x !== "string" || x.length > MAX_LEN) throw new FsError(400, `filter: ${what} must be text of at most ${MAX_LEN} characters`);
  return a as string[];
};

export class Filter {
  readonly spec: FilterSpec;
  private prefixes: string[];
  private globs: Matcher | null;
  private kinds: ReadonlySet<string> | null;
  private type: "file" | "dir" | null;
  private labels: Map<string, Set<string>> | null;

  /** Throws FsError 400 on a bad filter. */
  constructor(input: FilterSpec = {}) {
    const prefix = list(input.prefix, "prefix");
    const glob = list(input.glob, "glob");
    const kind = list(input.kind, "kind").flatMap((k) => k.split(",")).map((k) => k.trim()).filter(Boolean);
    const label = list(input.label, "label");
    for (const k of kind) if (!(KINDS as readonly string[]).includes(k)) throw new FsError(400, `filter: unknown kind "${k}"`);
    if (input.type !== undefined && input.type !== "" && input.type !== "file" && input.type !== "dir") throw new FsError(400, 'filter: type is "file" or "dir"');
    this.prefixes = prefix.map((p) => {
      if (!p.startsWith("/")) throw new FsError(400, "filter: a prefix is an absolute path");
      return p.length > 1 ? p.replace(/\/+$/, "") || "/" : p;
    });
    this.globs = glob.length ? compileGlobs(glob, false) : null;
    this.kinds = kind.length ? new Set(kind) : null;
    this.type = input.type === "file" || input.type === "dir" ? input.type : null;
    if (label.length) {
      this.labels = new Map();
      for (const l of label) {
        const i = l.indexOf(":");
        if (i <= 0) throw new FsError(400, 'filter: a label is "key:value"');
        const k = l.slice(0, i);
        let s = this.labels.get(k);
        if (!s) this.labels.set(k, (s = new Set()));
        s.add(l.slice(i + 1));
      }
    } else this.labels = null;
    this.spec = { ...(prefix.length ? { prefix } : {}), ...(glob.length ? { glob } : {}), ...(kind.length ? { kind } : {}), ...(this.type ? { type: this.type } : {}), ...(label.length ? { label } : {}) };
  }

  get empty(): boolean {
    return !this.prefixes.length && !this.globs && !this.kinds && !this.type && !this.labels;
  }

  match(e: Matchable): boolean {
    if (CONTROL_KINDS.has(e.kind)) return true;
    if (this.kinds && !this.kinds.has(e.kind)) return false;
    if (this.type && e.dir !== (this.type === "dir")) return false;
    if (this.labels) {
      if (!e.labels) return false;
      for (const [k, vs] of this.labels) if (!vs.has(e.labels[k] as string)) return false;
    }
    if (this.prefixes.length && !this.underPrefix(e.path) && !this.underPrefix(e.from)) return false;
    if (this.globs && !this.globHit(e)) return false;
    return true;
  }

  private underPrefix(p: string | undefined): boolean {
    if (p === undefined) return false;
    for (const x of this.prefixes) if (x === "/" || p === x || (p.startsWith(x) && p.charCodeAt(x.length) === 47)) return true;
    return false;
  }

  private globHit(e: Matchable): boolean {
    const g = this.globs!;
    for (const p of [e.path, e.from]) if (p !== undefined && g.test(p.slice(1), e.dir) === true) return true;
    return false;
  }

  /** the query string that sends this filter to another agent (the hub's fan-in) */
  toParams(into: URLSearchParams = new URLSearchParams()): URLSearchParams {
    for (const [k, v] of Object.entries(this.spec)) for (const x of Array.isArray(v) ? v : [v]) into.append(k, x as string);
    return into;
  }
}

export { GLOB_SKIP };

/** The filter a query string asks for: `prefix`, `glob`, `kind` (also comma separated), `type` and `label`, each as often as needed. */
export function filterFromParams(q: URLSearchParams): Filter {
  const type = q.getAll("type");
  if (type.length > 1) throw new FsError(400, "filter: type is given once");
  return new Filter({ prefix: q.getAll("prefix"), glob: q.getAll("glob"), kind: q.getAll("kind"), label: q.getAll("label"), ...(type[0] ? { type: type[0] } : {}) });
}
