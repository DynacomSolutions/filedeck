/**
 * The direct children of one folder on a node or network source, complete however many there are.
 *
 * `/api/fs/list` is a page for the browser and stops at MAX_LIST entries; a copy or move that relied on it would quietly
 * leave the rest behind. `/api/fs/walk` with depth 1 streams every child (bounded by the walk limit of the node) and says
 * when even that was cut, so the caller can refuse instead of reporting success.
 */
export interface Child {
  name: string;
  /** full path on the node */
  path: string;
  type: string;
  size: number;
  mtime: number;
}

export interface ChildList {
  entries: Child[];
  /** the node stopped listing before the end */
  truncated: boolean;
}

export type Fetcher = (rest: string, init?: RequestInit) => Promise<Response>;

const WALK_MAX = 100_000_000; // the node clamps this to its own walk limit

export async function listChildren(fetcher: Fetcher, dir: string, signal: AbortSignal | undefined, fail: (r: Response) => Promise<Error>): Promise<ChildList> {
  const r = await fetcher(`/api/fs/walk?path=${encodeURIComponent(dir)}&depth=1&max=${WALK_MAX}&hidden=1`, { signal });
  if (!r.ok) throw await fail(r);
  const out: Child[] = [];
  let truncated = false;
  const prefix = dir === "/" ? "" : dir;
  const eat = (line: string) => {
    if (!line) return;
    const m = JSON.parse(line) as { e?: { p: string; t: string; s: number; m: number }[]; done?: { truncated?: boolean } };
    for (const e of m.e ?? []) out.push({ name: e.p, path: `${prefix}/${e.p}`, type: e.t, size: e.s, mtime: e.m });
    if (m.done?.truncated) truncated = true;
  };
  const dec = new TextDecoder();
  let buf = "";
  if (r.body) {
    for await (const chunk of r.body as unknown as AsyncIterable<Uint8Array>) {
      buf += dec.decode(chunk, { stream: true });
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        eat(buf.slice(0, i));
        buf = buf.slice(i + 1);
      }
    }
  }
  eat(buf + dec.decode());
  return { entries: out, truncated };
}
