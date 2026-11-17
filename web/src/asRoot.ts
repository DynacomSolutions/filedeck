import type { Account, Me } from "./auth";

/** The banner's alert when the hub has not confirmed a Stop. */
export const STOP_FAILED = "Could not stop acting as root. Try again.";
/** While the switch is on the hub is asked this often, so an end it decides (admin removed, sessions ended) shows soon. */
export const POLL_MS = 60_000;
/** setTimeout cannot wait longer than this */
const MAX_DELAY = 2 ** 31 - 1;

/** `endsAt`: the end by this browser's clock while the hub reports the switch on, else undefined. */
export type AsRootView = { endsAt: number | undefined; stopping: boolean; stopFailed: boolean };

type Deps = { me: () => Promise<Me | "signed-out">; stop: () => Promise<void> };

/**
 * The act-as-root state of the signed-in account, outside React so it can be tested with fake timers. The hub decides
 * whether the switch is on: every answer it gives is applied, and the end is always a local time worked out from the
 * hub's time left, never compared with the hub's own end time. Only the newest me() answer counts (a counter), and
 * start/stop/end make older answers stale too. One timer ends it at the local end; while on, the hub is asked every
 * POLL_MS. Always off for auth off and for an account that is not a system administrator.
 */
export class AsRootState {
  private view: AsRootView;
  private readonly allowed: boolean;
  private seq = 0;
  private endTimer: ReturnType<typeof setTimeout> | undefined;
  private poll: ReturnType<typeof setInterval> | undefined;
  private readonly listeners = new Set<() => void>();
  private disposed = false;

  constructor(account: Account | undefined, private readonly deps: Deps) {
    this.allowed = account?.kind === "sys" && account.admin;
    this.view = { endsAt: this.allowed ? account?.asRootEndsAt : undefined, stopping: false, stopFailed: false };
    this.timers();
  }

  get = (): AsRootView => this.view;

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  private set(next: Partial<AsRootView>) {
    if (this.disposed) return;
    const v = { ...this.view, ...next };
    if (!this.allowed) v.endsAt = undefined;
    if (v.endsAt === undefined) v.stopFailed = false;
    if (v.endsAt === this.view.endsAt && v.stopping === this.view.stopping && v.stopFailed === this.view.stopFailed) return;
    const endChanged = v.endsAt !== this.view.endsAt;
    this.view = v;
    if (endChanged) this.timers();
    for (const fn of this.listeners) fn();
  }

  /** One timer to the local end, and the poll while on. */
  private timers() {
    clearTimeout(this.endTimer);
    this.endTimer = undefined;
    const at = this.view.endsAt;
    if (at === undefined || this.disposed) {
      clearInterval(this.poll);
      this.poll = undefined;
      return;
    }
    this.endTimer = setTimeout(() => this.end(), Math.min(Math.max(0, at - Date.now()), MAX_DELAY));
    this.poll ??= setInterval(() => void this.refresh(), POLL_MS);
  }

  /** The dialog turned it on; `endsAt` is the local end from the hub's answer. */
  start = (endsAt: number) => {
    this.seq++;
    this.set({ endsAt, stopFailed: false });
  };

  /**
   * Asks the hub and applies its answer if no newer question or change came meanwhile. Resolves to "on", "off",
   * "stale" (a newer question or change won) or "error" (the hub could not be reached: what is known is kept).
   */
  refresh = async (): Promise<"on" | "off" | "stale" | "error"> => {
    const id = ++this.seq;
    let m: Me | "signed-out";
    try {
      m = await this.deps.me();
    } catch {
      return id === this.seq ? "error" : "stale";
    }
    if (id !== this.seq) return "stale";
    const endsAt = m !== "signed-out" && m.auth && m.kind === "sys" && m.admin ? m.asRootEndsAt : undefined;
    this.set({ endsAt });
    return endsAt === undefined ? "off" : "on";
  };

  /**
   * Stop: DELETE, then ask the hub. The banner goes only when the hub then says off; when the DELETE failed and the
   * hub still reports the switch, or me() fails, or me() still reports it, the banner stays with the STOP_FAILED alert.
   */
  stop = async () => {
    this.seq++;
    this.set({ stopping: true, stopFailed: false });
    try {
      await this.deps.stop();
    } catch {
      // not confirmed; the hub's answer below decides
    }
    const r = await this.refresh();
    this.set({ stopping: false, stopFailed: r === "on" || r === "error" });
  };

  /** The local end time: off now, then ask the hub (which may still report it, for a moment, if the clocks drift). */
  end = () => {
    this.seq++;
    this.set({ endsAt: undefined });
    void this.refresh();
  };

  dispose() {
    this.disposed = true;
    this.seq++;
    clearTimeout(this.endTimer);
    clearInterval(this.poll);
    this.listeners.clear();
  }
}
