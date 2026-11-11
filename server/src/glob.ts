/**
 * Small glob matcher for folder-diff filters (gitignore-flavoured):
 *  - `*` any run of characters except "/", `**` any run including "/", `?` one character
 *  - `[abc]` / `[a-z]` / `[!abc]` classes, `{a,b}` alternatives
 *  - no "/" in the pattern: match the base name at any depth; with "/": match the whole relative path
 *  - leading "/" anchors at the compared root; trailing "/" matches directories only
 * Patterns are matched by a linear-time automaton simulation (no regular expressions, no backtracking) and are
 * length-capped, so a hostile pattern cannot stall the process.
 */
import { FsError } from "./fsops.ts";

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

/** Most rules (after brace expansion) and tokens in one matcher: more is refused (400), so the cost per path stays bounded. */
export const MAX_RULES = 512;
export const MAX_TOTAL_TOKENS = 2048;

const LIT = 0, ONE = 1, CLS = 2, STAR = 3, DSTAR = 4, DSA = 5, DSB = 6;

/** A glob ready to run: parallel arrays, class tables for ASCII, scratch lists reused between calls. */
interface Prog {
  m: number;
  kind: Uint8Array;
  lit: string[];
  neg: Uint8Array;
  tab: (Uint8Array | null)[];
  cls: ([string, string][] | null)[];
  ic: boolean;
  a: Int32Array;
  b: Int32Array;
  seen: Uint32Array;
  stamp: number;
}

function buildProg(toks: Tok[], ic: boolean): Prog {
  const m = toks.length;
  const p: Prog = { m, kind: new Uint8Array(m), lit: new Array(m).fill(""), neg: new Uint8Array(m), tab: new Array(m).fill(null), cls: new Array(m).fill(null), ic, a: new Int32Array(m + 3), b: new Int32Array(m + 3), seen: new Uint32Array(m + 3), stamp: 0 };
  toks.forEach((t, i) => {
    switch (t.k) {
      case "lit":
        p.kind[i] = LIT;
        p.lit[i] = ic ? t.c.toLowerCase() : t.c;
        break;
      case "one":
        p.kind[i] = ONE;
        break;
      case "cls": {
        p.kind[i] = CLS;
        p.neg[i] = t.neg ? 1 : 0;
        p.cls[i] = t.items;
        const tab = new Uint8Array(128);
        for (let c = 0; c < 128; c++) tab[c] = inClass(t.items, String.fromCharCode(c), ic) !== t.neg ? 1 : 0;
        p.tab[i] = tab;
        break;
      }
      case "star":
        p.kind[i] = STAR;
        break;
      case "dstar":
        p.kind[i] = DSTAR;
        break;
      case "dsa":
        p.kind[i] = DSA;
        break;
      case "dsb":
        p.kind[i] = DSB;
        break;
    }
  });
  return p;
}

function inClass(items: [string, string][], ch: string, ic: boolean): boolean {
  if (ic) {
    const lo = ch.toLowerCase();
    const up = ch.toUpperCase();
    return items.some(([a, b]) => (ch >= a && ch <= b) || (lo >= a && lo <= b) || (up >= a && up <= b));
  }
  return items.some(([a, b]) => ch >= a && ch <= b);
}

/**
 * Match `text` (already lower-cased when the matcher ignores case) by simulating the automaton one character at a time,
 * keeping only the states that are alive: the work is at most (text length x token count) whatever the pattern looks
 * like, and for ordinary patterns one or two states are alive, so it is close to a plain comparison.
 * (A backtracking matcher can take exponential or high-polynomial time on patterns such as `*a*a*a*b`.)
 */
function run(p: Prog, text: string): boolean {
  const { m, kind, lit, tab, cls, neg, seen, ic } = p;
  let cur = p.a;
  let nxt = p.b;
  let nc = 0;
  let nn = 0;
  let stamp = ++p.stamp;
  // adds state i and what it reaches without consuming a character
  const add = (list: Int32Array, n: number, i: number): number => {
    for (;;) {
      if (seen[i] === stamp) return n;
      seen[i] = stamp;
      list[n++] = i;
      const k = kind[i]!;
      if (i >= m) return n;
      if (k === STAR || k === DSTAR) i += 1;
      else if (k === DSA) i += 2;
      else return n;
    }
  };
  nc = add(cur, 0, 0);
  for (let pos = 0; pos < text.length; pos++) {
    const ch = text[pos] as string;
    const code = text.charCodeAt(pos);
    stamp = ++p.stamp;
    nn = 0;
    for (let j = 0; j < nc; j++) {
      const i = cur[j]!;
      if (i >= m) continue;
      switch (kind[i]) {
        case LIT:
          if (lit[i] === ch) nn = add(nxt, nn, i + 1);
          break;
        case ONE:
          if (ch !== "/") nn = add(nxt, nn, i + 1);
          break;
        case CLS: {
          const hit = code < 128 ? tab[i]![code] === 1 : inClass(cls[i]!, ch, ic) !== (neg[i] === 1);
          if (hit) nn = add(nxt, nn, i + 1);
          break;
        }
        case STAR:
          if (ch !== "/") nn = add(nxt, nn, i);
          break;
        case DSTAR:
          nn = add(nxt, nn, i);
          break;
        case DSA: // first character of the run: enter it
          nn = add(nxt, nn, i + 1);
          if (ch === "/") nn = add(nxt, nn, i + 2);
          break;
        case DSB:
          nn = add(nxt, nn, i);
          if (ch === "/") nn = add(nxt, nn, i + 1);
          break;
      }
    }
    if (nn === 0) return false;
    [cur, nxt] = [nxt, cur];
    nc = nn;
  }
  for (let j = 0; j < nc; j++) if (cur[j] === m) return true;
  return false;
}

/** Patterns made of plain text with at most one `*` at an end are compared directly. */
type Fast = { f: "eq" | "prefix" | "suffix"; lit: string };
function fastOf(toks: Tok[], ic: boolean): Fast | null {
  const plain = (ts: Tok[]) => ts.every((t) => t.k === "lit");
  const text = (ts: Tok[]) => ts.map((t) => (t as { c: string }).c).join("");
  const fold = (s: string) => (ic ? s.toLowerCase() : s);
  if (plain(toks)) return { f: "eq", lit: fold(text(toks)) };
  if (toks[0]!.k === "star" && plain(toks.slice(1))) return { f: "suffix", lit: fold(text(toks.slice(1))) };
  if (toks.at(-1)!.k === "star" && plain(toks.slice(0, -1))) return { f: "prefix", lit: fold(text(toks.slice(0, -1))) };
  return null;
}

interface Rule {
  prog: Prog;
  fast: Fast | null;
  base: boolean;
  dirOnly: boolean;
}

export function compileGlobs(patterns: string[], ignoreCase: boolean): Matcher {
  const rules: Rule[] = [];
  let tokens = 0;
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
      if (!toks || !toks.length) continue;
      tokens += toks.length;
      if (rules.length >= MAX_RULES || tokens > MAX_TOTAL_TOKENS) throw new FsError(400, "the glob patterns are too large: use fewer patterns or fewer {alternatives}");
      rules.push({ prog: buildProg(toks, ignoreCase), fast: fastOf(toks, ignoreCase), base, dirOnly });
    }
  }
  return {
    test(rel, isDir) {
      if (!rules.length) return false;
      const name = rel.slice(rel.lastIndexOf("/") + 1);
      let lname: string | null = null;
      let lrel: string | null = null;
      for (const r of rules) {
        if (r.dirOnly && !isDir) continue;
        let t = r.base ? name : rel;
        if (ignoreCase) t = r.base ? (lname ??= name.toLowerCase()) : (lrel ??= rel.toLowerCase());
        const f = r.fast;
        let hit: boolean;
        if (f) {
          if (f.f === "eq") hit = t === f.lit;
          else if (f.f === "suffix") hit = t.endsWith(f.lit) && (r.base || !t.slice(0, t.length - f.lit.length).includes("/"));
          else hit = t.startsWith(f.lit) && (r.base || !t.slice(f.lit.length).includes("/"));
        } else hit = run(r.prog, t);
        if (hit) return true;
      }
      return false;
    },
  };
}

/**
 * A time slicer for loops that match many paths: `const tick = timeSlicer(); ... const w = tick(); if (w) await w;`
 * gives the event loop a turn whenever the loop has run for `sliceMs` since its last turn.
 */
export function timeSlicer(sliceMs = 8): () => Promise<void> | null {
  let last = performance.now();
  return () => {
    if (performance.now() - last < sliceMs) return null;
    return new Promise<void>((r) => setImmediate(() => ((last = performance.now()), r())));
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
