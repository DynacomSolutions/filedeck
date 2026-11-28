/**
 * Counts change events per top folder: the first `depth` parts of the path under the mount that holds it. It is a hot path (one call per event
 * while somebody reads the pressure), so it does string work only and keeps at most `max` folders per interval.
 */
export class PathCounter {
  private mounts: string[] = [];
  private counts = new Map<string, number>();
  private other = 0;

  constructor(private readonly depth: number, private readonly max = 5000) {}

  /** mount points of the machine (virtual paths); the longest match wins */
  setMounts(points: string[]): void {
    this.mounts = [...new Set(points)].sort((a, b) => b.length - a.length);
  }

  /** The top folder of a path, or undefined when no mount holds it. */
  topFolder(p: string): { mount: string; folder: string } | undefined {
    for (const m of this.mounts) {
      let rest: string;
      if (m === "/") rest = p;
      else if (p === m) rest = "";
      else if (p.startsWith(m + "/")) rest = p.slice(m.length);
      else continue;
      let end = 0;
      let parts = 0;
      while (parts < this.depth) {
        const next = rest.indexOf("/", end + 1);
        parts++;
        if (next < 0) {
          // the entry itself is the last part: its folder is the one above it
          end = Math.max(0, rest.lastIndexOf("/"));
          break;
        }
        end = next;
      }
      const folder = (m === "/" ? "" : m) + rest.slice(0, end);
      return { mount: m, folder: folder || "/" };
    }
    return undefined;
  }

  add(p: string | undefined): void {
    if (!p) return;
    const t = this.topFolder(p);
    if (!t) return;
    const n = this.counts.get(t.folder);
    if (n !== undefined) this.counts.set(t.folder, n + 1);
    else if (this.counts.size < this.max) this.counts.set(t.folder, 1);
    else this.other++;
  }

  /** The counts since the last call, with the mount that holds each folder. */
  take(): { folders: Map<string, { count: number; mount: string }>; other: number } {
    const folders = new Map<string, { count: number; mount: string }>();
    for (const [f, count] of this.counts) {
      const mount = this.topFolder(f)?.mount;
      if (mount !== undefined) folders.set(f, { count, mount });
    }
    const other = this.other;
    this.counts = new Map();
    this.other = 0;
    return { folders, other };
  }
}
