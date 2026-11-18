// Pure decisions for the installable app (pwa.ts does the browser side). No browser imports, so the tests run it directly.
import { HubAnswerError } from "./auth.ts";

/**
 * - `none`: this tab runs the newest version it knows of
 * - `ready`: a new version is installed and waits; the page offers "Reload"
 * - `updated`: another tab switched to a new version; this tab still runs the old one until it is reloaded
 */
export type UpdateState = "none" | "ready" | "updated";
export type UpdateEvent = { type: "waiting" } | { type: "controllerchange"; asked: boolean; hadController: boolean };

/** The next state, and whether this tab reloads now (only the tab whose user pressed "Reload"). */
export function nextUpdate(s: UpdateState, e: UpdateEvent): { state: UpdateState; reload: boolean } {
  if (e.type === "waiting") return { state: s === "updated" ? s : "ready", reload: false };
  // the first worker claiming a page that had none is an install, not an update
  if (!e.hadController) return { state: s, reload: false };
  if (e.asked) return { state: s, reload: true };
  return { state: "updated", reload: false };
}

/** A network failure (fetch rejected), or a gateway in front of the hub saying the hub is down. */
export function hubUnreachable(e: unknown): boolean {
  if (e instanceof HubAnswerError) return e.status === 502 || e.status === 503 || e.status === 504;
  return e instanceof TypeError;
}

/** Title bar colour per theme: the header colour of theme.css (--surface). The manifest carries the dark one. */
export const THEME_COLOR = { dark: "#151518", light: "#ffffff" } as const;
