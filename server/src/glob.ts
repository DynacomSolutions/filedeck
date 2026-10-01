/**
 * Small glob matcher for folder-diff filters (gitignore-flavoured):
 *  - `*` any run of characters except "/", `**` any run including "/", `?` one character
 *  - `[abc]` / `[a-z]` / `[!abc]` classes, `{a,b}` alternatives
 *  - no "/" in the pattern: match the base name at any depth; with "/": match the whole relative path
 *  - leading "/" anchors at the compared root; trailing "/" matches directories only
 * Patterns are compiled to anchored RegExps without nested quantifiers on
 * unbounded input, and length-capped, so a hostile pattern cannot stall a job.
 */
export interface Matcher {
  test(rel: string, isDir: boolean): boolean;
}

const MAX_PATTERN = 256;
const MAX_PATTERNS = 100;

function expandBraces(p: string, depth = 0): string[] {
  const open = p.indexOf("{");
  if (open < 0 || depth > 4) return [p];
  let level = 0;
  let close = -1;
  for (let i = open; i < p.length; i++) {
    if (p[i] === "{") level++;
    else if (p[i] === "}" && --level === 0) {
      close = i;
      break;
    }
  }
  if (close < 0) return [p];
  const parts: string[] = [];
  let cur = "";
  level = 0;
  for (const ch of p.slice(open + 1, close)) {
    if (ch === "{") level++;
    if (ch === "}") level--;
    if (ch === "," && level === 0) {
      parts.push(cur);
      cur = "";
    } else cur += ch;
  }
  parts.push(cur);
  const out: string[] = [];
  for (const alt of parts) for (const rest of expandBraces(p.slice(close + 1), depth + 1)) out.push(...expandBraces(p.slice(0, open) + alt + rest, depth + 1));
  return out.slice(0, 64);
}

function toRegex(g: string): string {
  let re = "";
  for (let i = 0; i < g.length; i++) {
    const c = g[i] as string;
    if (c === "*") {
      if (g[i + 1] === "*") {
        while (g[i + 1] === "*") i++;
        if (g[i + 1] === "/") {
          i++;
          re += "(?:.*/)?"; // "**/" also matches zero directories
        } else re += ".*";
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else if (c === "[") {
      const end = g.indexOf("]", i + 2);
      if (end < 0) re += "\\[";
      else {
        let body = g.slice(i + 1, end);
        const neg = body[0] === "!" || body[0] === "^";
        if (neg) body = body.slice(1);
        re += "[" + (neg ? "^" : "") + body.replace(/[\\\]^]/g, "\\$&") + "]";
        i = end;
      }
    } else re += c.replace(/[.+^${}()|\\/]/g, "\\$&");
  }
  return re;
}

interface Rule {
  re: RegExp;
  base: boolean;
  dirOnly: boolean;
}

export function compileGlobs(patterns: string[], ignoreCase: boolean): Matcher {
  const rules: Rule[] = [];
  for (let raw of patterns.slice(0, MAX_PATTERNS)) {
    raw = raw.trim();
    if (!raw || raw.length > MAX_PATTERN) continue;
    const dirOnly = raw.endsWith("/");
    if (dirOnly) raw = raw.slice(0, -1);
    const anchored = raw.startsWith("/");
    if (anchored) raw = raw.slice(1);
    if (!raw) continue;
    const base = !anchored && !raw.includes("/");
    for (const g of expandBraces(raw)) {
      try {
        rules.push({ re: new RegExp("^" + toRegex(g) + "$", ignoreCase ? "i" : ""), base, dirOnly });
      } catch {
        /* invalid class: ignore the pattern */
      }
    }
  }
  return {
    test(rel, isDir) {
      if (!rules.length) return false;
      const name = rel.slice(rel.lastIndexOf("/") + 1);
      for (const r of rules) {
        if (r.dirOnly && !isDir) continue;
        if (r.re.test(r.base ? name : rel)) return true;
      }
      return false;
    },
  };
}

/** "*.log, node_modules/\n.git" -> patterns (commas inside {braces} are kept) */
export function splitPatterns(s: string): string[] {
  const out: string[] = [];
  let cur = "";
  let level = 0;
  for (const ch of s) {
    if (ch === "{") level++;
    else if (ch === "}") level = Math.max(0, level - 1);
    if ((ch === "," && level === 0) || ch === "\n") {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out.map((x) => x.trim()).filter(Boolean);
}
