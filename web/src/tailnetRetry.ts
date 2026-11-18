import { me as askMe, retryDelayMs, type Me } from "./auth";

/** What the waiting screen and the banner show: a try in flight ("Trying…"), and how many tries failed (the text changes after one). */
export type RetryView = { trying: boolean; failures: number };

type Deps = {
  me?: () => Promise<Me | "signed-out">;
  /** each change of the view */
  onView: (v: RetryView) => void;
  /** the first answer that is not a failure; the loop has stopped by then */
  onResult: (m: Me | "signed-out") => void;
};

/**
 * Asks `me` again while a Tailscale session's tailscaled does not answer (the hub's tailnet 503), outside React so it can
 * be tested with fake timers. The waits grow as `retryDelayMs` (1 s, 2 s, 4 s … 30 s). Every failure counts, also one
 * that is not a 503, so a hub that is down too is asked again later. `tryNow` asks at once unless a try is in flight.
 * `start` while running does nothing: every request the app makes reports the same 503.
 */
export class TailnetRetry {
  running = false;
  private trying = false;
  private failures = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  /** counts loops, so an answer from a stopped loop is dropped */
  private gen = 0;
  private readonly me: () => Promise<Me | "signed-out">;

  constructor(private readonly deps: Deps) {
    this.me = deps.me ?? askMe;
  }

  private emit() {
    this.deps.onView({ trying: this.trying, failures: this.failures });
  }

  /** The next try after `retryDelayMs(failures)`: 1 s after the 503 that started the loop, then 2 s, 4 s … */
  private schedule() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.ask(), retryDelayMs(this.failures));
  }

  /** Starts the loop after a 503 (the first try after 1 s). Nothing while it runs already. */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.trying = false;
    this.failures = 0;
    this.gen++;
    this.emit();
    this.schedule();
  }

  /** Asks at once ("Try now"); ignored while a try is in flight or the loop is not running. */
  tryNow(): void {
    if (this.running && !this.trying) this.ask();
  }

  stop(): void {
    this.running = false;
    this.trying = false;
    this.gen++;
    clearTimeout(this.timer);
  }

  private ask() {
    if (!this.running || this.trying) return;
    clearTimeout(this.timer);
    const gen = this.gen;
    this.trying = true;
    this.emit();
    this.me().then(
      (m) => {
        if (gen !== this.gen) return;
        this.stop();
        this.deps.onResult(m);
      },
      () => {
        if (gen !== this.gen) return;
        this.trying = false;
        this.failures++;
        this.emit();
        this.schedule();
      },
    );
  }
}
