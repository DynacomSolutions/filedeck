// Shared change feed for the file panels.
//
// Each open folder used to hold its own EventSource. A browser allows about six HTTP/1.1 connections per origin, shared by every
// tab, so a few panels (or a few tabs) used up the whole allowance and listings, previews and saves queued behind the streams.
// This module opens one stream per watched folder however many panels show it, keeps at most `maxStreams` open, lets the
// folders beyond that fall back to a slow poll, and drops every stream while the page is hidden (one catch-up notification on return).
// No browser imports at module level: the tests pass a fake `open`.

export interface StreamSource {
  addEventListener(type: string, fn: (e: { data?: unknown }) => void): void;
  close(): void;
}

export interface ChangeHubOptions {
  open: (url: string) => StreamSource;
  /** streams kept open at once; further folders are polled */
  maxStreams: number;
  pollMs: number;
  setInterval: (fn: () => void, ms: number) => unknown;
  clearInterval: (id: unknown) => void;
  url: (node: string, path: string) => string;
}

interface Entry {
  url: string;
  listeners: Set<() => void>;
  src?: StreamSource;
  poll?: unknown;
  /** the server refused the stream (for example its watch limit): never reopen it, poll instead */
  refused?: boolean;
}

export function createChangeHub(o: ChangeHubOptions) {
  const entries = new Map<string, Entry>();
  let visible = true;

  const notify = (en: Entry) => en.listeners.forEach((fn) => fn());
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
      if (!en.refused && streams() < o.maxStreams) {
        if (en.poll !== undefined) o.clearInterval(en.poll);
        en.poll = undefined;
        const src = o.open(en.url);
        en.src = src;
        src.addEventListener("change", () => notify(en));
        // A server-sent "error" event carries data; a dropped connection does not and is retried by the browser itself.
        src.addEventListener("error", (e) => {
          if (typeof e.data === "string" && en.src === src) {
            src.close();
            en.src = undefined;
            en.refused = true;
            rebalance();
          }
        });
      } else if (en.poll === undefined) {
        en.poll = o.setInterval(() => notify(en), o.pollMs);
      }
    }
  }

  return {
    /** call `fn` whenever the folder may have changed; returns the unsubscribe function */
    subscribe(node: string, path: string, fn: () => void): () => void {
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
  });
  document.addEventListener("visibilitychange", () => shared!.setVisible(document.visibilityState !== "hidden"));
  return shared;
}
