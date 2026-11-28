import type { EventBus } from "./bus.ts";
import { CONTROL_KINDS, type Matchable } from "./types.ts";

/**
 * Folder watches on top of the bus, in memory only: no kernel watch, no limit from the kernel. A callback is told when an entry of the folder it
 * names is created, removed, moved, changed or written, and when the bus says events may have been missed (an overflow, a reset: every callback).
 * The compare index and the live feed (`/api/events`) use this in place of their own inotify watches.
 */
export interface DirFeed {
  /** `virtual`: an agent path. null when no kernel watcher covers the folder (the caller then keeps its own way of noticing changes). */
  watch(virtual: string, cb: () => void): (() => void) | null;
  /** false once the watcher has stopped: a stream that follows a folder through this feed should end, so its client asks again */
  alive(): boolean;
}

export class DirWatchers implements DirFeed {
  private map = new Map<string, Set<() => void>>();
  private off: () => void;
  private offStopped: () => void;
  count = 0;

  /** `covers`: whether the watcher keeps `virtual` current (FanWatch.covers) */
  constructor(
    private bus: EventBus,
    private covers: (virtual: string) => boolean,
  ) {
    this.off = bus.listen((e) => this.event(e));
    // the kernel watcher stopped: no folder is kept current any more. Every watcher is told (it may have missed changes) and dropped, so the callers
    // fall back to their own way of noticing changes (the index to a watch of its own or the folder's modification time)
    this.offStopped = bus.onStopped(() => this.dropAll());
  }

  private dropAll() {
    const sets = [...this.map.values()];
    this.map.clear();
    this.count = 0;
    for (const set of sets) for (const cb of [...set]) cb();
  }

  private event(e: Matchable) {
    if (!this.count || e.kind === "pressure") return;
    if (CONTROL_KINDS.has(e.kind)) {
      if (e.kind === "ready") return;
      for (const set of [...this.map.values()]) for (const cb of [...set]) cb();
      return;
    }
    if (e.path !== undefined) this.fire(parent(e.path));
    if (e.from !== undefined) this.fire(parent(e.from));
  }

  private fire(dir: string) {
    const set = this.map.get(dir);
    if (set) for (const cb of [...set]) cb();
  }

  watch(virtual: string, cb: () => void): (() => void) | null {
    if (!this.bus.ready || !this.covers(virtual)) return null;
    let set = this.map.get(virtual);
    if (!set) this.map.set(virtual, (set = new Set()));
    set.add(cb);
    this.count++;
    return () => {
      const s = this.map.get(virtual);
      if (!s?.delete(cb)) return;
      this.count--;
      if (!s.size) this.map.delete(virtual);
    };
  }

  alive(): boolean {
    return this.bus.ready;
  }

  close() {
    this.off();
    this.offStopped();
    this.map.clear();
    this.count = 0;
  }
}

/** The folder that holds an entry (the entry's own path for "/"). */
export function parent(p: string): string {
  const i = p.lastIndexOf("/");
  return i <= 0 ? "/" : p.slice(0, i);
}
