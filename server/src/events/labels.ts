/**
 * Labels from path templates. A template is a path whose segments are either text (must match exactly) or `{name}` (matches any one segment
 * and gives it to the label `name`): `/srv/repos/{org}/{repo}`. A path below the template's depth gets the labels of every folder level it
 * passes, so every file inside `/srv/repos/acme/app` has `org=acme` and `repo=app`. Matching is by whole segments, never by a regular
 * expression, so a template can neither stall the process nor be used to attack it.
 *
 * When several templates match a path, the one with the most text segments wins (the more specific one); on a tie, the first one written.
 * So `/srv/repos/.worktrees/{org}/{task}/{repo}` wins over `/srv/repos/{org}/{repo}` for a path below `.worktrees`.
 */

interface Template {
  /** per segment: text, or null for a `{name}` */
  text: (string | null)[];
  names: (string | null)[];
  literals: number;
}

const NAME = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/;
const MAX_TEMPLATES = 64;
const MAX_SEGMENTS = 16;

export class LabelRules {
  private templates: Template[] = [];
  private cache = new Map<string, Record<string, string> | null>();
  private depth = 0;

  /** `spec`: templates separated by a line feed, a semicolon or a comma. Throws on a bad template (so a typo in a setting is seen at start-up). */
  constructor(spec: string | string[] = []) {
    const list = (Array.isArray(spec) ? spec : spec.split(/[\n;,]/)).map((s) => s.trim()).filter(Boolean);
    if (list.length > MAX_TEMPLATES) throw new Error(`at most ${MAX_TEMPLATES} label templates`);
    for (const raw of list) {
      if (!raw.startsWith("/")) throw new Error(`label template must start with "/": ${raw}`);
      const segs = raw.split("/").filter(Boolean);
      if (!segs.length || segs.length > MAX_SEGMENTS) throw new Error(`label template has 1 to ${MAX_SEGMENTS} segments: ${raw}`);
      const t: Template = { text: [], names: [], literals: 0 };
      const seen = new Set<string>();
      for (const s of segs) {
        const m = /^\{([^{}]*)\}$/.exec(s);
        if (m) {
          if (!NAME.test(m[1]!) || seen.has(m[1]!)) throw new Error(`bad or repeated label name in template: ${raw}`);
          seen.add(m[1]!);
          t.text.push(null);
          t.names.push(m[1]!);
        } else {
          if (s.includes("{") || s.includes("}")) throw new Error(`a label name takes a whole segment: ${raw}`);
          t.text.push(s);
          t.names.push(null);
          t.literals++;
        }
      }
      this.templates.push(t);
      this.depth = Math.max(this.depth, segs.length);
    }
  }

  get empty(): boolean {
    return this.templates.length === 0;
  }

  /** The labels of a virtual path, or undefined. The same object comes back for paths that share their first segments (do not change it). */
  labels(p: string): Record<string, string> | undefined {
    if (!this.templates.length) return undefined;
    // the first `depth` segments of the path decide, so they are the cache key
    let end = 1;
    for (let n = 0; n < this.depth && end > 0; n++) {
      end = p.indexOf("/", end);
      if (end < 0) break;
      end++;
    }
    const head = end > 0 ? p.slice(0, end - 1) : p; // (without a trailing "/")
    const hit = this.cache.get(head);
    if (hit !== undefined) return hit ?? undefined;
    const r = this.compute(head);
    if (this.cache.size >= 20_000) this.cache.delete(this.cache.keys().next().value as string);
    this.cache.set(head, r);
    return r ?? undefined;
  }

  private compute(head: string): Record<string, string> | null {
    const segs = head.split("/").filter(Boolean);
    let best: Template | null = null;
    for (const t of this.templates) {
      if (segs.length < t.text.length) continue;
      let ok = true;
      for (let i = 0; i < t.text.length && ok; i++) ok = t.text[i] === null ? true : t.text[i] === segs[i];
      if (ok && (!best || t.literals > best.literals)) best = t;
    }
    if (!best) return null;
    const out: Record<string, string> = {};
    for (let i = 0; i < best.names.length; i++) if (best.names[i]) out[best.names[i]!] = segs[i]!;
    return out;
  }
}
