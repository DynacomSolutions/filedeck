import { compileGlobs, splitPatterns } from "./glob.ts";

/**
 * Folders whose changes never reach the folder-size store (FILEDECK_SIZE_EXCLUDE): build output, package folders, database logs and
 * git objects change very often and their size is not worth a write for each change. The size of such a folder comes from the scheduled
 * scans only. This list is for the size store alone: the change event journal, the socket and the change stream never use it.
 */
export const DEFAULT_SIZE_EXCLUDE = "pg_wal,node_modules,target,.git/objects,cargo-target";

/** "a, b/c" -> ["a", "b/c"] (commas inside {braces} stay in one pattern; surrounding "/" and blanks are removed) */
export function parseSizeExclude(s: string): string[] {
  return splitPatterns(s)
    .map((p) => p.trim().replace(/^\/+|\/+$/g, ""))
    .filter(Boolean);
}

const isGlob = (s: string) => /[*?[{]/.test(s);

/**
 * A test for an agent path: true when the path is, or lies inside, a folder that a pattern names. A pattern is a folder name or glob
 * (`node_modules`, `cargo-*`) that matches at any depth, or a run of such names (`.git/objects`) that must follow each other in the path.
 */
export function sizeExcluder(patterns: string[]): (virtual: string) => boolean {
  const rules = patterns
    .map((p) => p.split("/").filter(Boolean))
    .filter((segs) => segs.length)
    .map((segs) =>
      segs.map((s) => {
        if (!isGlob(s)) return (name: string) => name === s;
        const m = compileGlobs([s], false);
        return (name: string) => m.test(name, true) === true; // (an over-costly match is no match)
      }),
    );
  if (!rules.length) return () => false;
  const memo = new Map<string, boolean>();
  return (virtual: string) => {
    const hit = memo.get(virtual);
    if (hit !== undefined) return hit;
    const segs = virtual.split("/").filter(Boolean);
    let out = false;
    for (const rule of rules) {
      for (let i = 0; i + rule.length <= segs.length && !out; i++) {
        let all = true;
        for (let j = 0; j < rule.length && all; j++) all = rule[j]!(segs[i + j]!);
        out = all;
      }
      if (out) break;
    }
    if (memo.size >= 8192) memo.clear();
    memo.set(virtual, out);
    return out;
  };
}
