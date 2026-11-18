// What the service worker does with each request, and what the build puts in its precache. Pure: no browser or Node
// imports, so the unit tests and the Vite build (vite.config.ts) use it directly, and sw.ts bundles it.
//
// The one rule that must never break: nothing under /api is handled. Those answers carry the signed-in account's data
// (listings, file contents, thumbnails, sessions); a stored copy could be shown to the next account on this device.

/**
 * - `none`: not handled at all; the browser fetches as if there were no service worker
 * - `shell`: a page load; network first, the stored shell when the hub cannot be reached
 * - `asset`: a build file with a content hash in its name; it never changes, so cache first and stored on first use
 * - `static`: another file of the app (icons, fonts, theme.css); from the precache, else the network
 */
export type Strategy = "none" | "shell" | "asset" | "static";

export interface RequestLike {
  method: string;
  url: string;
  mode: string;
}

/** The cache key the page shell is stored under (the hub answers every app route with the same page). */
export const SHELL_KEY = "/";
const CACHE_PREFIX = "filedeck-shell-";
const HASHED_ASSET = /^\/assets\/[^/]+-[A-Za-z0-9_-]{8}\.[A-Za-z0-9]+$/;

/** The decoded path, or null when it cannot be decoded (never handled). */
function decodedPath(u: URL): string | null {
  try {
    return decodeURIComponent(u.pathname);
  } catch {
    return null;
  }
}

export function strategyFor(req: RequestLike, origin: string): Strategy {
  if (req.method !== "GET") return "none";
  let u: URL;
  try {
    u = new URL(req.url);
  } catch {
    return "none";
  }
  if (u.origin !== origin) return "none";
  const p = decodedPath(u);
  if (p === null || /^\/api(?:\/|$)/i.test(p) || p.includes("/../")) return "none";
  // the worker script; and the manifest, which carries the deployment's brand and may change without a new build
  if (p === "/sw.js" || p === "/site.webmanifest") return "none";
  if (req.mode === "navigate") return "shell";
  if (HASHED_ASSET.test(p)) return "asset";
  return "static";
}

/** One file of the Vite (rolldown) output, as far as the precache needs it. */
export type BundleEntry =
  | { type: "chunk"; fileName: string; isEntry: boolean; imports: string[]; css: string[] }
  | { type: "asset"; fileName: string };

/**
 * Files to store at install: every entry chunk with its static imports (followed through) and their CSS, plus the given
 * public files. Lazy chunks (the editor, previews) are stored when first used instead: the editor alone is several MB.
 */
export function precacheFrom(bundle: BundleEntry[], publicFiles: string[]): string[] {
  const chunks = new Map<string, Extract<BundleEntry, { type: "chunk" }>>();
  for (const b of bundle) if (b.type === "chunk") chunks.set(b.fileName, b);
  const out = new Set<string>();
  const visit = (name: string) => {
    if (out.has(name)) return;
    const c = chunks.get(name);
    if (!c) return;
    out.add(name);
    for (const css of c.css) out.add(css);
    for (const i of c.imports) visit(i);
  };
  for (const c of chunks.values()) if (c.isEntry) visit(c.fileName);
  for (const f of publicFiles) if (f !== "sw.js" && f !== "index.html") out.add(f);
  return [...out].map((f) => "/" + f.replace(/^\/+/, "")).filter((f) => strategyFor({ method: "GET", url: "http://x" + f, mode: "cors" }, "http://x") !== "none").sort();
}

/** A short hash of the precache list: a new build has new hashed names, so a new version and a new sw.js. */
export function swVersion(list: string[]): string {
  let h = 0x811c9dc5;
  for (const ch of list.join("\n")) {
    h ^= ch.codePointAt(0) as number;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

export const cacheName = (version: string): string => CACHE_PREFIX + version;
export const isOwnCache = (name: string): boolean => name.startsWith(CACHE_PREFIX);
