// The service worker, built to /sw.js by the plugin in vite.config.ts, which puts the precache list and the version in
// front of this code. It stores the app shell so the app opens without a network, and nothing else: see swPolicy.ts for
// what it handles (never /api). A new build waits until the page asks it to take over (the page shows "Reload").

import { SHELL_KEY, cacheName, isOwnCache, strategyFor } from "./swPolicy";

interface ExtendableEvent extends Event {
  waitUntil(p: Promise<unknown>): void;
}
interface FetchEvent extends ExtendableEvent {
  request: Request;
  respondWith(r: Response | Promise<Response>): void;
}
interface NotificationEvent extends ExtendableEvent {
  notification: Notification;
}
interface WindowClientLike {
  url: string;
  focus(): Promise<unknown>;
}
interface SwScope {
  __FD_PRECACHE__: string[];
  __FD_VERSION__: string;
  location: Location;
  skipWaiting(): Promise<void>;
  clients: {
    claim(): Promise<void>;
    matchAll(o: { type: "window"; includeUncontrolled: boolean }): Promise<WindowClientLike[]>;
    openWindow(url: string): Promise<unknown>;
  };
  addEventListener(type: "install" | "activate", fn: (e: ExtendableEvent) => void): void;
  addEventListener(type: "fetch", fn: (e: FetchEvent) => void): void;
  addEventListener(type: "notificationclick", fn: (e: NotificationEvent) => void): void;
  addEventListener(type: "message", fn: (e: MessageEvent) => void): void;
}

const sw = self as unknown as SwScope;
const PRECACHE = sw.__FD_PRECACHE__ ?? [];
const CACHE = cacheName(sw.__FD_VERSION__ ?? "dev");
const ORIGIN = sw.location.origin;
/** A gateway in front of the hub answers these when the hub itself is down. */
const GATEWAY_DOWN = new Set([502, 503, 504]);

const isHtml = (r: Response) => (r.headers.get("content-type") ?? "").startsWith("text/html");

async function storeShell(cache: Cache, r: Response) {
  if (r.ok && r.status === 200 && !r.redirected && isHtml(r)) await cache.put(SHELL_KEY, r);
}

sw.addEventListener("install", (e) => {
  e.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      await cache.addAll(PRECACHE.map((p) => new Request(p, { cache: "reload" })));
      // the shell as the hub renders it now (branding included); without it the first offline start has nothing to show
      await fetch(SHELL_KEY, { cache: "no-store" }).then((r) => storeShell(cache, r)).catch(() => undefined);
    })(),
  );
});

sw.addEventListener("activate", (e) => {
  e.waitUntil(
    (async () => {
      for (const k of await caches.keys()) if (isOwnCache(k) && k !== CACHE) await caches.delete(k);
      await sw.clients.claim();
    })(),
  );
});

sw.addEventListener("message", (e) => {
  if ((e.data as { type?: string } | null)?.type === "skip-waiting") void sw.skipWaiting();
});

async function shell(req: Request): Promise<Response> {
  const cache = await caches.open(CACHE);
  try {
    const r = await fetch(req);
    if (GATEWAY_DOWN.has(r.status)) return (await cache.match(SHELL_KEY, { ignoreVary: true })) ?? r;
    await storeShell(cache, r.clone());
    return r;
  } catch {
    return (await cache.match(SHELL_KEY, { ignoreVary: true })) ?? Response.error();
  }
}

async function asset(req: Request): Promise<Response> {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(req, { ignoreSearch: true, ignoreVary: true });
  if (hit) return hit;
  const r = await fetch(req);
  if (r.ok && r.status === 200) await cache.put(new URL(req.url).pathname, r.clone());
  return r;
}

async function staticFile(req: Request): Promise<Response> {
  const cache = await caches.open(CACHE);
  return (await cache.match(new URL(req.url).pathname, { ignoreVary: true })) ?? fetch(req);
}

sw.addEventListener("fetch", (e) => {
  const s = strategyFor({ method: e.request.method, url: e.request.url, mode: e.request.mode }, ORIGIN);
  if (s === "none") return;
  e.respondWith(s === "shell" ? shell(e.request) : s === "asset" ? asset(e.request) : staticFile(e.request));
});

// A job notification (jobNotify.ts) was clicked: bring the open Filedeck window forward, or open one.
sw.addEventListener("notificationclick", (e) => {
  e.notification.close();
  e.waitUntil(
    (async () => {
      const wins = await sw.clients.matchAll({ type: "window", includeUncontrolled: true });
      const own = wins.find((w) => new URL(w.url).origin === ORIGIN);
      if (own) await own.focus();
      else await sw.clients.openWindow("/");
    })(),
  );
});
