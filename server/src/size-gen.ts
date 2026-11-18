import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

/**
 * Generations of a size store file (see docs/superpowers/specs/2026-11-18-size-store-self-heal-design.md).
 *
 * `<base>` is generation 0 (the name every version before generations used); generation N > 0 is `<base>.gen<N>` (a name nobody picks by hand: a copy an operator once renamed to `<base>.1` is never taken for a store). The store in use is the highest generation
 * whose main file exists. A path is never used again for another database: SQLite finds `-wal` and `-shm` by name, so a process still holding an old file
 * would otherwise share them with the new one. Numbers only grow, a lower generation is deleted only once a higher one exists, and no open creates a file
 * (see `rwUri`) except generation 0 when there is none.
 */
export interface Gen {
  gen: number;
  file: string;
}

export const genFile = (base: string, gen: number): string => (gen === 0 ? base : `${base}.gen${gen}`);

/** The SQLite URI that opens an existing file read-write and never creates it (a missing file fails with SQLITE_CANTOPEN). */
export const rwUri = (file: string): string => "file:" + path.resolve(file).replace(/%/g, "%25").replace(/\?/g, "%3f").replace(/#/g, "%23") + "?mode=rw";

/** a heal's temporary file older than this is left over from a process that died */
const TMP_STALE_MS = 3600_000;

interface Listing {
  /** main files of every generation, highest first */
  gens: Gen[];
  /** every file of the base (main, -wal, -shm, -journal, temporary) with its generation */
  all: { name: string; gen: number; tmp: boolean }[];
}

function parse(base: string, names: string[]): Listing {
  const b = path.basename(base);
  const dir = path.dirname(base);
  const gens: Gen[] = [];
  const all: Listing["all"] = [];
  for (const name of names) {
    if (!name.startsWith(b)) continue;
    const rest = name.slice(b.length);
    // `<base>` or `<base>.<N>`, then nothing, a SQLite side file, or a heal's temporary name
    const m = /^(?:\.gen(\d+))?(-wal|-shm|-journal|\.tmp-[0-9A-Za-z-]+)?$/.exec(rest);
    if (!m) continue;
    const gen = m[1] === undefined ? 0 : Number(m[1]);
    if (m[1] !== undefined && (gen < 1 || String(gen) !== m[1])) continue;
    const tmp = !!m[2]?.startsWith(".tmp-");
    all.push({ name, gen, tmp });
    if (!m[2]) gens.push({ gen, file: path.join(dir, name) });
  }
  gens.sort((x, y) => y.gen - x.gen);
  return { gens, all };
}

export function listGensSync(base: string): Listing {
  let names: string[] = [];
  try {
    names = fs.readdirSync(path.dirname(base));
  } catch {
    /* no folder yet */
  }
  return parse(base, names);
}

export async function listGens(base: string): Promise<Listing> {
  let names: string[] = [];
  try {
    names = await fsp.readdir(path.dirname(base));
  } catch {
    /* no folder yet */
  }
  return parse(base, names);
}

/**
 * Delete every file of the generations below `gen` (main, -wal, -shm, journal), and temporary files of heals that died. A process that still has one
 * of them open keeps using the deleted file until it follows (Linux frees the space then); it never shares a name with generation `gen` or above.
 */
export async function removeBelow(base: string, gen: number, l?: Listing): Promise<string[]> {
  l ??= await listGens(base);
  const dir = path.dirname(base);
  const gone: string[] = [];
  for (const f of l.all) {
    const p = path.join(dir, f.name);
    if (f.tmp) {
      // a heal in progress in another process uses its temporary file for a moment: only old ones are left over
      try {
        if (Date.now() - (await fsp.stat(p)).mtimeMs < TMP_STALE_MS) continue;
      } catch {
        continue;
      }
    } else if (f.gen >= gen) continue;
    try {
      await fsp.unlink(p);
      gone.push(p);
    } catch {
      /* gone already */
    }
  }
  return gone;
}
