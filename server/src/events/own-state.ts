import fs from "node:fs";
import path from "node:path";

/**
 * The agent's own state: the event journal's folder, and the store files it keeps in the index folder (or, without one, in the temporary folder). A write
 * there must not become an event, else each write of the journal would be an event that is written to the journal.
 *
 * A name alone does not say that a path is the agent's own: a user may have a folder called `changes-<node>` somewhere else. So a path counts only when the
 * folder it names is the very same folder (device and inode) as the agent's own one. The check is made once for each candidate and remembered.
 */
export interface OwnStateOptions {
  node: string;
  /** the agent's root, as the agent sees it: a virtual path is `root + path` */
  root: string;
  /** the journal's folder (null: the journal is in memory) */
  journalDir: string | null;
  /** the index folder that holds the stores (empty: none) */
  stateDir: string;
  /** the temporary folder, where the stores are made without an index folder */
  tmpDir: string;
}

const MAX_CACHE = 4096;

export function ownState(o: OwnStateOptions): (virtual: string) => boolean {
  const ids = new Map<string, string | null>();
  const identity = (p: string): string | null => {
    const hit = ids.get(p);
    if (hit) return hit;
    try {
      const st = fs.statSync(p);
      if (!st.isDirectory()) return null;
      const id = `${st.dev}:${st.ino}`;
      ids.set(p, id);
      return id;
    } catch {
      return null;
    }
  };
  const verdicts = new Map<string, boolean>();
  const same = (prefix: string, ref: string): boolean => {
    const key = `${ref}\0${prefix}`;
    const hit = verdicts.get(key);
    if (hit !== undefined) return hit;
    const a = identity(o.root === "/" ? prefix || "/" : o.root + prefix);
    const b = identity(ref);
    const v = a !== null && a === b;
    if (verdicts.size >= MAX_CACHE) verdicts.clear();
    verdicts.set(key, v);
    return v;
  };
  const journalName = o.journalDir ? path.basename(o.journalDir) : null;
  const storeFile = new RegExp(`^(?:index|sizes|jobs)-${o.node.replace(/[^A-Za-z0-9_-]/g, "\\$&")}\\.db`);
  const spillFile = new RegExp(`^filedeck-(?:index|sizes|jobs)-${process.pid}-`);
  return (virtual) => {
    const segs = virtual.split("/").filter(Boolean);
    for (let i = 0; i < segs.length; i++) {
      const seg = segs[i]!;
      const prefix = "/" + segs.slice(0, i).join("/");
      const upTo = "/" + segs.slice(0, i + 1).join("/");
      if (journalName !== null && seg === journalName && o.journalDir && same(upTo, o.journalDir)) return true;
      if (i === segs.length - 1) {
        if (o.stateDir && storeFile.test(seg) && same(prefix === "/" ? "" : prefix, o.stateDir)) return true;
        if (spillFile.test(seg) && same(prefix === "/" ? "" : prefix, o.tmpDir)) return true;
      }
    }
    return false;
  };
}
