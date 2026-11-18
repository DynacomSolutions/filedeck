// Shared change feed for the file panels.
//
// Each open folder used to hold its own EventSource. A browser allows about six HTTP/1.1 connections per origin, shared by every
// tab, so a few panels (or a few tabs) used up the whole allowance and listings, previews and saves queued behind the streams.
// This module opens one stream per watched folder however many panels show it, keeps at most `maxStreams` open, lets the
// folders beyond that fall back to a slow poll, and drops every stream while the page is hidden (one catch-up notification on return).
// No browser imports at module level: the tests pass a fake `open`.
// Every notification is the app's own doing, never the person's: listeners get `{ background: true }` and send what they ask then with
// `BACKGROUND_HEADER`, so the hub does not count it as use of the session.

import { BACKGROUND_HEADER } from "./api";

/** What a listener hears: a notification of the change hub is always automatic. */
export type ChangeNote = { background: true };
const NOTE: ChangeNote = Object.freeze({ background: true as const });

/** Asks the hub who is signed in, as a background request: when the session has ended, the signed-out watch (auth.ts) sees the 401. */
export const checkSignedIn = (): Promise<void> => fetch("/api/auth/me", { headers: BACKGROUND_HEADER }).then(
  () => undefined,
  () => undefined,
);

export interface StreamSource {
  addEventListener(type: string, fn: (e: { data?: unknown }) => void): void;
  close(): void;
  /** EventSource's state: 2 (CLOSED) once the browser has given up reconnecting (a non-200 answer such as 401 or 503) */
  readonly readyState?: number;
}

export interface ChangeHubOptions {
  open: (url: string) => StreamSource;
  /** streams kept open at once; further folders are polled */
  maxStreams: number;
  pollMs: number;
  setInterval: (fn: () => void, ms: number) => unknown;
  clearInterval: (id: unknown) => void;
  url: (node: string, path: string) => string;
  /**
   * Called when a stream reports an error without data: a dropped connection, which is also how a stream the hub ended with its session,
   * or a 401, looks to EventSource. At most once per `DROP_MS`.
   */
  onDrop?: () => void;
  /** clock for the `onDrop` limit (tests) */
  now?: () => number;
}

/** `onDrop` is called at most once in this time. */
const DROP_MS = 10_000;

interface Entry {
  url: string;
  listeners: Set<(note: ChangeNote) => void>;
  src?: StreamSource;
  poll?: unknown;
  /** the server refused the stream (for example its watch limit): never reopen it, poll instead */
  refused?: boolean;
  /** the browser gave up on the stream (CLOSED): poll, and open it again no sooner than this */
  retryAt?: number;
  /** streams given up on in a row, for the wait before the next try; a `ready` resets it */
  fails?: number;
}

/** EventSource.CLOSED */
const CLOSED = 2;
/** The longest wait before a stream the browser gave up on is opened again. */
const MAX_RETRY_MS = 5 * 60_000;

export function createChangeHub(o: ChangeHubOptions) {
  const entries = new Map<string, Entry>();
  let visible = true;
  let lastDrop = -Infinity;
  const now = o.now ?? Date.now;
  const dropped = () => {
    const t = now();
    if (!o.onDrop || t - lastDrop < DROP_MS) return;
    lastDrop = t;
    o.onDrop();
  };

  const notify = (en: Entry) => en.listeners.forEach((fn) => fn(NOTE));
  const stop = (en: Entry) => {
    en.src?.close();
    en.src = undefined;
    if (en.poll !== undefined) o.clearInterval(en.poll);
    en.poll = undefined;
  };
  const streams = () => [...entries.values()].filter((e) => e.src).length;

  /** open streams for as many folders as the cap allows (oldest subscription first), poll the rest */
  function rebalance() {
    for (const en of entries.values()) {
      if (!visible) {
        stop(en);
        continue;
      }
      if (en.src) continue;
      if (!en.refused && (en.retryAt === undefined || now() >= en.retryAt) && streams() < o.maxStreams) {
        if (en.poll !== undefined) o.clearInterval(en.poll);
        en.poll = undefined;
        en.retryAt = undefined;
        const src = o.open(en.url);
        en.src = src;
        src.addEventListener("change", () => notify(en));
        // The agent says "ready" each time the stream (re)starts. After a reconnect, changes made while it was down were never sent, so
        // every ready but the first tells the listeners to look again.
        let readies = 0;
        src.addEventListener("ready", () => {
          en.fails = 0;
          if (readies++ > 0) notify(en);
        });
        // A server-sent "error" event carries data; a dropped connection does not and is retried by the browser itself (the hub is
        // asked who is signed in, as the drop may be the session's end).
        src.addEventListener("error", (e) => {
          if (typeof e.data === "string" && en.src === src) {
            src.close();
            en.src = undefined;
            en.refused = true;
            rebalance();
          } else if (typeof e.data !== "string") {
            dropped();
            // CLOSED: the browser will not reconnect (the hub answered 503 while tailscaled was down, say). Poll meanwhile, and open it
            // again after a wait that doubles with each failure in a row.
            if (src.readyState === CLOSED && en.src === src) {
              src.close();
              en.src = undefined;
              en.fails = (en.fails ?? 0) + 1;
              en.retryAt = now() + Math.min(MAX_RETRY_MS, o.pollMs * 2 ** (en.fails - 1));
              rebalance();
            }
          }
        });
      } else if (en.poll === undefined) {
        en.poll = o.setInterval(() => {
          notify(en);
          // a stream given up on is opened again once its wait is over (rebalance moves it from the poll back to a stream)
          if (en.retryAt !== undefined && now() >= en.retryAt) rebalance();
        }, o.pollMs);
      }
    }
  }

  return {
    /** call `fn` whenever the folder may have changed; returns the unsubscribe function */
    subscribe(node: string, path: string, fn: (note: ChangeNote) => void): () => void {
      const url = o.url(node, path);
      let en = entries.get(url);
      if (!en) entries.set(url, (en = { url, listeners: new Set() }));
      en.listeners.add(fn);
      rebalance();
      return () => {
        const cur = entries.get(url);
        if (!cur) return;
        cur.listeners.delete(fn);
        if (!cur.listeners.size) {
          stop(cur);
          entries.delete(url);
          rebalance();
        }
      };
    },
    /** the page was hidden or shown: hidden closes every stream, shown reopens them and tells every listener to look again */
    setVisible(v: boolean) {
      if (v === visible) return;
      visible = v;
      rebalance();
      if (v) for (const en of entries.values()) notify(en);
    },
    /** how many streams are open now (for the tests) */
    openStreams: streams,
  };
}

let shared: ReturnType<typeof createChangeHub> | null = null;

/** The hub the panels use: real EventSource, the agent's feed URL, four streams at most. */
export function changeHub() {
  if (shared) return shared;
  shared = createChangeHub({
    open: (url) => new EventSource(url),
    maxStreams: 4,
    pollMs: 15000,
    setInterval: (fn, ms) => window.setInterval(fn, ms),
    clearInterval: (id) => window.clearInterval(id as number),
    url: (node, path) => `/api/nodes/${encodeURIComponent(node)}/api/events?path=${encodeURIComponent(path)}`,
    // asks the hub who is signed in: when the session has ended, the signed-out watch (auth.ts) sees the 401 and shows the sign-in screen
    onDrop: () => void checkSignedIn(),
  });
  document.addEventListener("visibilitychange", () => shared!.setVisible(document.visibilityState !== "hidden"));
  return shared;
}
