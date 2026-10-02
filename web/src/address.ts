import { decodeState, leaves } from "./urlState.ts";

/** Pure helpers for the address bar: URI formatting, parsing pasted forms and fuzzy matching. */

export interface Where {
  node: string;
  path: string;
}
export type Parsed = { node: string; path: string; select?: string } | { error: string };

export const fmtAddr = (node: string, path: string) => `${node}:${path}`;

/** Resolve `.`, `..` and repeated slashes; relative paths start from `base`. Always absolute, no trailing slash (except "/"). */
export function normPath(p: string, base = "/"): string {
  const parts = (p.startsWith("/") ? p : base + "/" + p).split("/");
  const out: string[] = [];
  for (const s of parts) {
    if (!s || s === ".") continue;
    if (s === "..") out.pop();
    else out.push(s);
  }
  return "/" + out.join("/");
}

const findNode = (name: string, nodes: string[]) => nodes.find((n) => n === name) ?? nodes.find((n) => n.toLowerCase() === name.toLowerCase());
const NODE_FORM = /^([^/:\s][^/:]*):(.*)$/;

/**
 * Accepts `node:/path`, `/path` (current node), a bare name (a node, else a folder under the current one) and a
 * full app URL (its `?s=` state: the active panel's location and selection).
 */
export function parseAddress(text: string, cur: Where, nodes: string[]): Parsed {
  const t = text.trim();
  if (!t) return { error: "Type a location, for example node-a:/home" };
  if (/^https?:\/\//i.test(t)) {
    try {
      const st = decodeState(new URL(t).search);
      const l = st && leaves(st.tree).find((x) => x.id === st.active);
      if (!st || !l) return { error: "That link has no panel location" };
      return { node: l.node, path: normPath(l.path), ...(l.sel ? { select: l.sel } : {}) };
    } catch {
      return { error: "Not a valid link" };
    }
  }
  const m = NODE_FORM.exec(t);
  if (m) {
    const name = m[1]!;
    const node = nodes.length ? findNode(name, nodes) : name;
    if (!node) return { error: `Unknown node or source "${name}"` };
    return { node, path: normPath(m[2] || "/") };
  }
  if (t.startsWith("/")) return { node: cur.node, path: normPath(t) };
  const bare = findNode(t, nodes);
  if (bare && !t.includes("/")) return { node: bare, path: "/" };
  return { node: cur.node, path: normPath(t, cur.path) };
}

/** What a half-typed address asks for: which folder to list and the name fragment being typed. */
export interface Typed {
  /** no `node:` and no `/` yet: the text may be a node name */
  bare: boolean;
  node: string;
  dir: string;
  leaf: string;
}
export function splitTyped(text: string, cur: Where, nodes: string[]): Typed | null {
  const t = text.trimStart();
  if (/^https?:\/\//i.test(t)) return null;
  let node = cur.node;
  let rest: string;
  const m = NODE_FORM.exec(t);
  if (m) {
    const n = nodes.length ? findNode(m[1]!, nodes) : m[1]!;
    if (!n) return null;
    node = n;
    rest = m[2]!.startsWith("/") ? m[2]! : "/" + m[2]!;
  } else if (t.startsWith("/")) rest = t;
  else rest = cur.path.replace(/\/$/, "") + "/" + t;
  const i = rest.lastIndexOf("/");
  const tail = rest.slice(i + 1);
  if (tail === "." || tail === "..") return { bare: false, node, dir: normPath(rest), leaf: "" };
  return { bare: !m && !t.startsWith("/") && !t.includes("/"), node, dir: normPath(rest.slice(0, i + 1)), leaf: tail };
}

/** Fuzzy score of `q` against `s` (higher is better, -1 no match): prefix, then substring, then subsequence. */
export function fuzzy(q: string, s: string): number {
  if (!q) return 0;
  const a = q.toLowerCase();
  const b = s.toLowerCase();
  if (b.startsWith(a)) return 1000 - (b.length - a.length);
  const at = b.indexOf(a);
  if (at >= 0) return 500 - at;
  let j = 0;
  let gaps = 0;
  let last = -1;
  for (const ch of a) {
    j = b.indexOf(ch, j);
    if (j < 0) return -1;
    if (last >= 0 && j > last + 1) gaps++;
    last = j++;
  }
  return 100 - gaps;
}

/** The URI a suggestion inserts: `node:/dir/name` with a trailing slash for folders. */
export const itemUri = (node: string, dir: string, name: string, isDir: boolean) => `${node}:${dir === "/" ? "" : dir}/${name}${isDir ? "/" : ""}`;
