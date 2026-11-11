/**
 * Small glob matcher for folder-diff filters (gitignore-flavoured):
 *  - `*` any run of characters except "/", `**` any run including "/", `?` one character
 *  - `[abc]` / `[a-z]` / `[!abc]` classes, `{a,b}` alternatives
 *  - no "/" in the pattern: match the base name at any depth; with "/": match the whole relative path
 *  - leading "/" anchors at the compared root; trailing "/" matches directories only
 * Patterns are matched by a linear-time automaton simulation (no regular expressions, no backtracking) and are
 * length-capped, so a hostile pattern cannot stall the process.
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

/**
 * One element of a compiled glob. `star` is `*`, `dstar` is `**`. `**` followed by "/" (which also matches zero
 * directories) is two elements: `dsa` (skippable, entered before the first character) and `dsb` (inside the run, ends at a "/").
 */
type Tok = { k: "lit"; c: string } | { k: "one" } | { k: "cls"; neg: boolean; items: [string, string][] } | { k: "star" } | { k: "dstar" } | { k: "dsa" } | { k: "dsb" };

/** Glob text to tokens; null when it is not a valid glob (an inverted range in a class), as a bad pattern is ignored. */
function tokenise(g: string): Tok[] | null {
  const out: Tok[] = [];
  for (let i = 0; i < g.length; i++) {
    const c = g[i] as string;
    if (c === "*") {
      if (g[i + 1] === "*") {
        while (g[i + 1] === "*") i++;
        if (g[i + 1] === "/") {
          i++;
          out.push({ k: "dsa" }, { k: "dsb" }); // "**/" also matches zero directories
        } else out.push({ k: "dstar" });
      } else out.push({ k: "star" });
    } else if (c === "?") out.push({ k: "one" });
    else if (c === "[" && g.indexOf("]", i + 2) >= 0) {
      const end = g.indexOf("]", i + 2);
      let body = g.slice(i + 1, end);
      const neg = body[0] === "!" || body[0] === "^";
      if (neg) body = body.slice(1);
      const items: [string, string][] = [];
      for (let j = 0; j < body.length; j++) {
        if (body[j + 1] === "-" && j + 2 < body.length) {
          if (body[j]! > body[j + 2]!) return null;
          items.push([body[j]!, body[j + 2]!]);
          j += 2;
        } else items.push([body[j]!, body[j]!]);
      }
      out.push({ k: "cls", neg, items });
      i = end;
    } else out.push({ k: "lit", c });
  }
  return out;
}

const fold = (s: string, ic: boolean) => (ic ? s.toLowerCase() : s);

/**
 * Match `text` against the tokens by simulating the automaton one character at a time: the set of live positions is
 * advanced for every character, so the work is at most (text length x token count) whatever the pattern looks like.
 * (A backtracking matcher can take exponential or high-polynomial time on patterns such as `*a*a*a*b`.)
 */
function matchTokens(toks: Tok[], text: string, ic: boolean): boolean {
  const m = toks.length;
  let cur = new Uint8Array(m + 1);
  let next = new Uint8Array(m + 1);
  const close = (set: Uint8Array) => {
    for (let i = 0; i < m; i++) {
      if (!set[i]) continue;
      const k = toks[i]!.k;
      if (k === "star" || k === "dstar") set[i + 1] = 1;
      else if (k === "dsa") set[i + 2] = 1; // "**/" matching nothing skips both of its elements
    }
  };
  cur[0] = 1;
  close(cur);
  for (let n = 0; n < text.length; n++) {
    const ch = text[n] as string;
    const lc = ic ? ch.toLowerCase() : ch;
    next.fill(0);
    let live = false;
    for (let i = 0; i < m; i++) {
      if (!cur[i]) continue;
      const t = toks[i]!;
      switch (t.k) {
        case "lit":
          if (fold(t.c, ic) === lc) next[i + 1] = 1;
          break;
        case "one":
          if (ch !== "/") next[i + 1] = 1;
          break;
        case "cls": {
          const forms = ic ? [ch, ch.toLowerCase(), ch.toUpperCase()] : [ch];
          const inSet = t.items.some(([lo, hi]) => forms.some((f) => f >= lo && f <= hi));
          if (inSet !== t.neg) next[i + 1] = 1;
          break;
        }
        case "star":
          if (ch !== "/") next[i] = 1;
          break;
        case "dstar":
          next[i] = 1;
          break;
        case "dsa": // first character of the run: enter it
          next[i + 1] = 1;
          if (ch === "/") next[i + 2] = 1;
          break;
        case "dsb":
          next[i] = 1;
          if (ch === "/") next[i + 1] = 1;
          break;
      }
    }
    close(next);
    for (let i = 0; i <= m; i++) if (next[i]) live = true;
    if (!live) return false;
    [cur, next] = [next, cur];
  }
  return cur[m] === 1;
}

interface Rule {
  toks: Tok[];
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
      const toks = tokenise(g);
      if (toks) rules.push({ toks, base, dirOnly });
    }
  }
  return {
    test(rel, isDir) {
      if (!rules.length) return false;
      const name = rel.slice(rel.lastIndexOf("/") + 1);
      for (const r of rules) {
        if (r.dirOnly && !isDir) continue;
        if (matchTokens(r.toks, r.base ? name : rel, ignoreCase)) return true;
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
