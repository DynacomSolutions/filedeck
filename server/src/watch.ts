import { watch, type FSWatcher } from "node:fs";

/**
 * Bounded live-change feed. One non-recursive fs.watch per directory that has at
 * least one subscriber (reference counted), debounced, capped at `max` watchers
 * so a misbehaving client cannot exhaust inotify.
 */
export class Watches {
  private map = new Map<string, { w: FSWatcher; subs: Set<() => void>; timer?: NodeJS.Timeout }>();
  constructor(private max = 256, private debounceMs = 150) {}

  get size() {
    return this.map.size;
  }

  /** Returns an unsubscribe function, or null if the cap is reached. */
  subscribe(real: string, onChange: () => void): (() => void) | null {
    let e = this.map.get(real);
    if (!e) {
      if (this.map.size >= this.max) return null;
      const w = watch(real, { persistent: false });
      const entry = { w, subs: new Set<() => void>() } as { w: FSWatcher; subs: Set<() => void>; timer?: NodeJS.Timeout };
      w.on("change", () => {
        clearTimeout(entry.timer);
        entry.timer = setTimeout(() => entry.subs.forEach((f) => f()), this.debounceMs);
      });
      w.on("error", () => this.drop(real));
      this.map.set(real, entry);
      e = entry;
    }
    e.subs.add(onChange);
    return () => {
      const cur = this.map.get(real);
      if (!cur) return;
      cur.subs.delete(onChange);
      if (cur.subs.size === 0) this.drop(real);
    };
  }

  private drop(real: string) {
    const e = this.map.get(real);
    if (!e) return;
    clearTimeout(e.timer);
    e.w.close();
    this.map.delete(real);
  }
}
