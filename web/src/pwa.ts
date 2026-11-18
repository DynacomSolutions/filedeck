// The installable app, browser side: the service worker (sw.ts) and its updates, the browser's install prompt, the title
// bar colour, and job notifications. The decisions are in pwaState.ts and jobNotify.ts.
import { useSyncExternalStore } from "react";
import { THEME_COLOR, nextUpdate, type UpdateState } from "./pwaState";
import { VISIBLE_TICK_MS, localEnds, notificationsFor, otherTabVisible, parseVisibleMark } from "./jobNotify";
import type { HistoryEntry } from "./jobHistory";
import { currentSettings } from "./settings";

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
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") checkForUpdate();
      });
      // a start without a network could not check: ask as soon as the network is back
      window.addEventListener("online", checkForUpdate);
      window.setInterval(checkForUpdate, UPDATE_CHECK_MS);
    })
    .catch(() => undefined); // no worker (private mode, blocked): the app works as before, without offline start
}

/** Asks the hub whether a new version exists (the banner appears when one is installed). */
export function checkForUpdate() {
  void registration?.update().catch(() => undefined);
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

// ---- Web Push (the hub notifies, also while the app is closed) ----

/**
 * Whether this browser has a push subscription the hub took (set by enablePush, resyncPush and disablePush). Kept in local storage, so
 * every open tab knows it: a tab that does not would also notify the same end locally.
 */
const PUSH_KEY = "filedeck.push-on";
let pushOnHere = false;
const pushOn = (): boolean => {
  try {
    return localStorage.getItem(PUSH_KEY) === "1";
  } catch {
    return pushOnHere;
  }
};
const setPushOn = (on: boolean) => {
  pushOnHere = on;
  try {
    if (on) localStorage.setItem(PUSH_KEY, "1");
    else localStorage.removeItem(PUSH_KEY);
  } catch {
    /* storage unavailable: this tab alone knows */
  }
};

const b64u = (s: string): Uint8Array<ArrayBuffer> => {
  const t = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4));
  const out = new Uint8Array(t.length);
  for (let i = 0; i < t.length; i++) out[i] = t.charCodeAt(i);
  return out;
};
const sameKey = (a: ArrayBuffer | null | undefined, b: Uint8Array) => !!a && a.byteLength === b.length && new Uint8Array(a).every((x, i) => x === b[i]);

async function workerRegistration(): Promise<ServiceWorkerRegistration | undefined> {
  if (registration) return registration;
  if (!("serviceWorker" in navigator)) return undefined;
  return navigator.serviceWorker.getRegistration().catch(() => undefined);
}

/**
 * Subscribes this browser to the hub's push (permission must be granted already) and hands the subscription to the hub, which keeps it
 * with the account and session. "unavailable": no service worker or push here, or push is off at the hub; local notifications remain.
 */
export async function enablePush(): Promise<"on" | "unavailable"> {
  try {
    const reg = await workerRegistration();
    if (!reg?.pushManager || notifySupport() !== "granted") return "unavailable";
    const k = await fetch("/api/push/key");
    if (!k.ok) return "unavailable";
    const key = b64u(((await k.json()) as { publicKey: string }).publicKey);
    let sub = await reg.pushManager.getSubscription();
    // made for another hub key (the hub's store was reset): start over
    if (sub && !sameKey(sub.options.applicationServerKey, key)) {
      await sub.unsubscribe().catch(() => undefined);
      sub = null;
    }
    sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
    const r = await fetch("/api/push/subscribe", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(sub.toJSON()) });
    setPushOn(r.ok);
    return r.ok ? "on" : "unavailable";
  } catch {
    setPushOn(false);
    return "unavailable";
  }
}

/** The switch is off: the hub forgets this browser and the browser drops the subscription. */
export async function disablePush(): Promise<void> {
  setPushOn(false);
  try {
    const sub = await (await workerRegistration())?.pushManager?.getSubscription();
    if (!sub) return;
    await fetch("/api/push/subscribe", { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ endpoint: sub.endpoint }) }).catch(() => undefined);
    await sub.unsubscribe();
  } catch {
    /* nothing to undo */
  }
}

/** Each time the app is shown (start-up, a new sign-in): with the switch on, the hub gets this browser's subscription again for this session. */
export async function resyncPush(): Promise<void> {
  // (the worker is registered in a production build only; `ready` never settles without one)
  if (!import.meta.env.PROD || !currentSettings().notifyJobs || notifySupport() !== "granted") return;
  if ("serviceWorker" in navigator) await navigator.serviceWorker.ready.catch(() => undefined);
  await enablePush();
}

/** Jobs that just ended (the jobs tray): notify when the page is hidden and the Settings switch is on. */
export function notifyJobsEnded(all: HistoryEntry[]) {
  const ended = localEnds(all, pushOn());
  const ctx = {
    hidden: document.visibilityState === "hidden",
    otherTabVisible: otherTabVisible(readMark(), TAB_ID, Date.now()),
    enabled: currentSettings().notifyJobs,
    permission: notifySupport(),
  };
  for (const n of notificationsFor(ended, ctx)) void showNotification(n);
}

// ---- which tab is on screen ----

const VISIBLE_KEY = "filedeck.visible-tab";
const TAB_ID = Math.random().toString(36).slice(2);
const readMark = () => {
  try {
    return parseVisibleMark(localStorage.getItem(VISIBLE_KEY));
  } catch {
    return null;
  }
};

/** While this tab is on screen it renews its mark; hidden, it drops the mark if it is its own. */
function markVisibleTab() {
  const tick = () => {
    try {
      if (document.visibilityState === "visible") localStorage.setItem(VISIBLE_KEY, JSON.stringify({ id: TAB_ID, at: Date.now() }));
      else if (readMark()?.id === TAB_ID) localStorage.removeItem(VISIBLE_KEY);
    } catch {
      /* storage unavailable: every hidden tab may notify */
    }
  };
  tick();
  document.addEventListener("visibilitychange", tick);
  window.addEventListener("pagehide", () => {
    if (readMark()?.id === TAB_ID) localStorage.removeItem(VISIBLE_KEY);
  });
  window.setInterval(tick, VISIBLE_TICK_MS);
}

/** Called once at start-up. The worker is registered only in a production build (the dev server has no /sw.js). */
export function installPwa() {
  catchInstallPrompt();
  followTheme();
  markVisibleTab();
  if (import.meta.env.PROD) registerWorker();
}
