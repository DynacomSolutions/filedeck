// The installable app, browser side: the service worker (sw.ts) and its updates, the browser's install prompt, the title
// bar colour, and job notifications. The decisions are in pwaState.ts and jobNotify.ts.
import { useSyncExternalStore } from "react";
import { THEME_COLOR, nextUpdate, type UpdateState } from "./pwaState";

type Listener = () => void;
function store<T>(initial: T) {
  let v = initial;
  const subs = new Set<Listener>();
  return {
    get: () => v,
    set(n: T) {
      if (n === v) return;
      v = n;
      subs.forEach((f) => f());
    },
    subscribe(f: Listener) {
      subs.add(f);
      return () => void subs.delete(f);
    },
  };
}

// ---- service worker and updates ----

const update = store<UpdateState>("none");
let registration: ServiceWorkerRegistration | undefined;
/** this tab's user pressed "Reload": the next change of worker reloads it */
let asked = false;
/** how often an open page asks the hub for a new version */
const UPDATE_CHECK_MS = 30 * 60 * 1000;

export const useUpdateState = (): UpdateState => useSyncExternalStore(update.subscribe, update.get);

function onWaiting() {
  update.set(nextUpdate(update.get(), { type: "waiting" }).state);
}

function watch(reg: ServiceWorkerRegistration) {
  if (reg.waiting && navigator.serviceWorker.controller) onWaiting();
  reg.addEventListener("updatefound", () => {
    const w = reg.installing;
    w?.addEventListener("statechange", () => {
      // installed with a controller in place: a new version waits (without one, it is the first install and takes over)
      if (w.state === "installed" && navigator.serviceWorker.controller) onWaiting();
    });
  });
}

function registerWorker() {
  if (!("serviceWorker" in navigator)) return;
  let controlled = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    const n = nextUpdate(update.get(), { type: "controllerchange", asked, hadController: controlled });
    controlled = true;
    update.set(n.state);
    if (n.reload) location.reload();
  });
  navigator.serviceWorker
    .register("/sw.js", { scope: "/" })
    .then((reg) => {
      registration = reg;
      watch(reg);
      const check = () => void reg.update().catch(() => undefined);
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") check();
      });
      window.setInterval(check, UPDATE_CHECK_MS);
    })
    .catch(() => undefined); // no worker (private mode, blocked): the app works as before, without offline start
}

/** "Reload" pressed: let the waiting version take over (this tab reloads when it has), or reload a tab another tab updated. */
export function applyUpdate() {
  const w = registration?.waiting;
  if (!w) return location.reload();
  asked = true;
  w.postMessage({ type: "skip-waiting" });
}

// ---- install ----

interface InstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}
const install = store<InstallPromptEvent | null>(null);

const standalone = () => window.matchMedia?.("(display-mode: standalone)").matches || (navigator as { standalone?: boolean }).standalone === true;

function catchInstallPrompt() {
  window.addEventListener("beforeinstallprompt", (e) => {
    // kept for "Install app" in Settings; the browser's own install entry stays in its menu
    e.preventDefault();
    install.set(e as InstallPromptEvent);
  });
  window.addEventListener("appinstalled", () => install.set(null));
}

/** Whether "Install app" can be offered: the browser gave its install prompt and the app is not already running installed. */
export const useCanInstall = (): boolean => useSyncExternalStore(install.subscribe, () => install.get() !== null && !standalone());

export async function promptInstall(): Promise<void> {
  const e = install.get();
  if (!e) return;
  install.set(null); // a prompt can be shown once
  await e.prompt();
  await e.userChoice.catch(() => undefined);
}

// ---- title bar colour ----

function followTheme() {
  const apply = () => {
    const t = document.documentElement.dataset.theme === "light" ? "light" : "dark";
    for (const m of document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')) {
      m.removeAttribute("media");
      m.content = THEME_COLOR[t];
    }
  };
  apply();
  new MutationObserver(apply).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
}

// ---- notifications ----

export type NotifySupport = "unsupported" | NotificationPermission;

export const notifySupport = (): NotifySupport => (typeof Notification === "undefined" ? "unsupported" : Notification.permission);

/** Asks the browser for permission; only ever called from the Settings switch (a user action). */
export async function requestNotify(): Promise<NotifySupport> {
  if (typeof Notification === "undefined") return "unsupported";
  try {
    return await Notification.requestPermission();
  } catch {
    return Notification.permission;
  }
}

/** Shows a notification through the service worker (needed on Android), else from the page. */
export async function showNotification(n: { title: string; body: string; tag: string }): Promise<void> {
  if (notifySupport() !== "granted") return;
  const opts: NotificationOptions = { body: n.body, tag: n.tag, icon: "/icon-192.png", badge: "/icon-monochrome.png" };
  const reg = registration ?? (await navigator.serviceWorker?.getRegistration().catch(() => undefined));
  if (reg) {
    try {
      return await reg.showNotification(n.title, opts);
    } catch {
      /* fall through to a page notification */
    }
  }
  try {
    new Notification(n.title, opts);
  } catch {
    /* this browser shows notifications only through a worker */
  }
}

/** Called once at start-up. The worker is registered only in a production build (the dev server has no /sw.js). */
export function installPwa() {
  catchInstallPrompt();
  followTheme();
  if (import.meta.env.PROD) registerWorker();
}
