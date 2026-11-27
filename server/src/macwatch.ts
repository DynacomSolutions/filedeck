import { watch as fsWatch, type FSWatcher } from "node:fs";
import { lstat } from "node:fs/promises";
import type { EventBus } from "./events/bus.ts";
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { listMounts, type Mount } from "./mounts.ts";

const execFileAsync = promisify(execFile);

export interface MacWatchStore {
  applyChanged(virtual: string): Promise<boolean | void>;
  markStale(virtual: string): void;
  notePending?(items: { path: string; dueAt: number; modify: boolean }[], modifyMs: number): Promise<boolean>;
}

export interface MacWatchOptions { root: string; procMounts: string; settleMs?: number; reconcileMs?: number; /** every change is published here as well, as well as FSEvents tells it (no entry names for a rename: a lookup tells created from removed) */ bus?: EventBus }

export interface MacWatchStatus {
  running: boolean; ready: boolean; mounts: number; watched: number; unwatched: number; excluded: number;
  backlog: number; lostEvents: number; reconcileError: string;
}

/** Native macOS watcher using Node's recursive FSEvents-backed fs.watch implementation. */
export class MacWatch {
  private watchers = new Map<string, FSWatcher>();
  private mounts: Mount[] = [];
  private unwatched = new Set<string>();
  private pending = new Map<string, ReturnType<typeof setTimeout>>();
  private reconcileTimer?: ReturnType<typeof setInterval>;
  private stopped = false;
  private ready = false;
  private lostEvents = 0;
  private excluded = 0;
  private reconcileError = "";
  private readonly settleMs: number;

  constructor(private readonly store: MacWatchStore, private readonly o: MacWatchOptions) { this.settleMs = o.settleMs ?? 1000; }

  private virtual(p: string) {
    if (this.o.root === "/") return p || "/";
    if (p === this.o.root) return "/";
    return p.startsWith(this.o.root + "/") ? p.slice(this.o.root.length) : null;
  }

  /** Best effort: FSEvents through fs.watch says "change" or "rename" and the name, so a rename is a create when the entry exists and a delete when it does not. */
  private publish(event: string, p: string) {
    const bus = this.o.bus;
    const v = this.virtual(p);
    if (!bus || !v) return;
    if (event === "change") return bus.publish({ kind: "modify", dir: false, path: v });
    void lstat(p).then(
      (st) => bus.publish({ kind: "create", dir: st.isDirectory(), path: v }),
      () => bus.publish({ kind: "delete", dir: false, path: v }),
    );
  }

  private schedule(p: string) {
    const v = this.virtual(path.dirname(p));
    if (!v || this.pending.has(v)) return;
    this.pending.set(v, setTimeout(() => {
      this.pending.delete(v);
      void (async () => {
        const dueAt = Date.now();
        if (this.store.notePending && await this.store.notePending([{ path: v, dueAt, modify: false }], 30_000)) return;
        await this.store.applyChanged(v);
      })();
    }, this.settleMs));
  }

  private async mountList(): Promise<Mount[]> {
    const fromProc = await listMounts(this.o.root, this.o.procMounts);
    if (fromProc.length) return fromProc;
    try {
      const { stdout } = await execFileAsync("df", ["-P"], { timeout: 5000, maxBuffer: 1024 * 1024 });
      const out: Mount[] = [];
      for (const line of stdout.split("\n").slice(1)) {
        const fields = line.trim().split(/\s+/);
        const mountpoint = fields.at(-1);
        if (!mountpoint?.startsWith("/")) continue;
        out.push({ device: fields[0] ?? "unknown", mountpoint, fstype: "darwin", total: 0, used: 0, free: 0, network: false });
      }
      return [...new Map(out.map((m) => [m.mountpoint, m])).values()].sort((a, b) => a.mountpoint.localeCompare(b.mountpoint));
    } catch {
      return [{ device: "unknown", mountpoint: this.o.root, fstype: "darwin", total: 0, used: 0, free: 0, network: false }];
    }
  }

  private async reconcile() {
    if (this.stopped) return;
    try {
      const mounts = await this.mountList();
      const virtual = (p: string) => p === "/dev" || p === "/System/Volumes/VM" || p === "/System/Volumes/Preboot" || p === "/System/Volumes/Update" || p.startsWith("/private/var/vm");
      const local = mounts.filter((m) => !m.network && !m.unreachable && !virtual(m.mountpoint));
      this.excluded = mounts.length - local.length;
      const wanted = new Set(local.map((m) => m.mountpoint));
      for (const [mp, watcher] of this.watchers) if (!wanted.has(mp)) { watcher.close(); this.watchers.delete(mp); this.store.markStale(this.virtual(mp) ?? "/"); }
      for (const m of local) if (!this.watchers.has(m.mountpoint)) {
        try {
          const watcher = fsWatch(m.mountpoint, { recursive: true }, (event, filename) => {
            const full = filename ? path.join(m.mountpoint, filename.toString()) : m.mountpoint;
            this.publish(event, full);
            this.schedule(full);
          });
          watcher.on("error", (e) => { this.lostEvents++; const now = Date.now(); this.o.bus?.publish({ kind: "overflow", scope: "filesystem", path: this.virtual(m.mountpoint) ?? "/", window: { from: now, to: now }, reason: "the watcher failed" }); this.unwatched.add(m.mountpoint); this.store.markStale(this.virtual(m.mountpoint) ?? "/"); this.reconcileError = String(e); });
          this.watchers.set(m.mountpoint, watcher);
        } catch (e) {
          this.unwatched.add(m.mountpoint); this.reconcileError = String(e); this.store.markStale(this.virtual(m.mountpoint) ?? "/");
        }
      }
      this.mounts = mounts;
      const first = !this.ready;
      this.ready = true;
      this.readyAt = Date.now();
      if (this.o.bus) {
        this.o.bus.ready = this.unwatched.size === 0;
        if (first) this.o.bus.publish({ kind: "ready", scope: "node", ...(this.unwatched.size ? { unwatched: [...this.unwatched].map((p) => this.virtual(p) ?? p) } : {}) });
      }
    } catch (e) { this.reconcileError = String(e); this.ready = false; }
  }

  async start() {
    if (this.stopped) return;
    await this.reconcile();
    this.reconcileTimer = setInterval(() => void this.reconcile(), this.o.reconcileMs ?? 30_000);
    this.reconcileTimer.unref?.();
  }

  status(): MacWatchStatus { return { running: this.watchers.size > 0, ready: this.ready && this.unwatched.size === 0, mounts: this.mounts.length, watched: this.watchers.size, unwatched: this.unwatched.size, excluded: 0, backlog: this.pending.size, lostEvents: this.lostEvents, reconcileError: this.reconcileError }; }
  /** Last reconciled mount list in the agent's path space. */
  mountCoverage(): { path: string; state: "watched" | "unwatched" }[] {
    return this.mounts.flatMap((mount) => {
      const p = this.virtual(mount.mountpoint);
      if (p === null) return [];
      return [{ path: p, state: this.watchers.has(mount.mountpoint) && !this.unwatched.has(mount.mountpoint) ? "watched" : "unwatched" }];
    });
  }
  covers(virtual: string) { return this.ready && this.unwatched.size === 0 && [...this.watchers.keys()].some((m) => { const v = this.virtual(m); return v === "/" || v === virtual || virtual.startsWith(v + "/"); }); }
  settled(virtual: string) { return ![...this.pending.keys()].some((p) => p === virtual || p.startsWith(virtual + "/") || virtual.startsWith(p + "/")); }
  private readyAt = Infinity;
  watchedSince() { return this.ready ? this.readyAt : Infinity; }
  chainMin() { return null; }
  storeReplaced() { for (const m of this.mounts) this.store.markStale(this.virtual(m.mountpoint) ?? "/"); }
  async handover() { this.stop(); }
  stop() { this.stopped = true; if (this.o.bus) this.o.bus.ready = false; if (this.reconcileTimer) clearInterval(this.reconcileTimer); for (const t of this.pending.values()) clearTimeout(t); for (const w of this.watchers.values()) w.close(); this.watchers.clear(); this.pending.clear(); this.readyAt = Infinity; }
}
