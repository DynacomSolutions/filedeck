import { useSyncExternalStore } from "react";

export type ReadingFont = "system" | "serif" | "mono";

export interface PresentationSettings {
  foreground: string;
  background: string;
  font: ReadingFont;
  fontSize: number;
  lineHeight: number;
  paragraphSpace: number;
  lineMeasure: number;
}

export const DEFAULT_PRESENTATION: PresentationSettings = {
  foreground: "",
  background: "",
  font: "system",
  fontSize: 16,
  lineHeight: 1.6,
  paragraphSpace: 2.4,
  lineMeasure: 80,
};

/** Convert computed theme colours to the opaque hex format accepted by input[type=color]. */
export function cssColourToHex(value: string, fallback = "#ffffff"): string {
  const input = value.trim().toLowerCase();
  if (/^#[\da-f]{6}$/.test(input)) return input;
  if (/^#[\da-f]{3}$/.test(input)) return `#${input[1]}${input[1]}${input[2]}${input[2]}${input[3]}${input[3]}`;
  const match = input.match(/^rgba?\(\s*([\d.]+%?)[, ]+\s*([\d.]+%?)[, ]+\s*([\d.]+%?)(?:\s*[,/]\s*[\d.]+%?)?\s*\)$/);
  if (!match) return fallback;
  const channels = match.slice(1, 4).map((channel) => Math.max(0, Math.min(255, Math.round(parseFloat(channel) * (channel.endsWith("%") ? 2.55 : 1)))));
  return `#${channels.map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
}

const KEY = "filedeck.presentation";
const listeners = new Set<() => void>();
const validColour = (value: unknown) => typeof value === "string" && /^#[\da-f]{6}$/i.test(value);
const bounded = (value: unknown, min: number, max: number, step: number, fallback: number) => {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.round(Math.min(max, Math.max(min, value)) / step) * step;
};

export function normalizePresentation(value: unknown): PresentationSettings {
  const raw = value && typeof value === "object" ? value as Partial<PresentationSettings> : {};
  const lineHeight = bounded(raw.lineHeight, 1.5, 2, 0.1, 1.6);
  const paragraphMin = Math.ceil(Math.max(2, lineHeight * 1.5) * 10) / 10;
  return {
    foreground: validColour(raw.foreground) ? raw.foreground : "",
    background: validColour(raw.background) ? raw.background : "",
    font: raw.font === "serif" || raw.font === "mono" ? raw.font : "system",
    fontSize: bounded(raw.fontSize, 14, 32, 1, 16),
    lineHeight,
    paragraphSpace: bounded(raw.paragraphSpace, paragraphMin, 3, 0.1, paragraphMin),
    lineMeasure: bounded(raw.lineMeasure, 45, 100, 5, 80),
  };
}

function load(): PresentationSettings {
  try { return normalizePresentation(JSON.parse(typeof localStorage === "undefined" ? "{}" : localStorage.getItem(KEY) ?? "{}")); }
  catch { return DEFAULT_PRESENTATION; }
}

let current = load();
function apply(settings: PresentationSettings) {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  const font = settings.font === "serif" ? "Georgia, 'Times New Roman', serif" : settings.font === "mono" ? "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace" : "system-ui, -apple-system, 'Segoe UI', sans-serif";
  root.style.setProperty("--user-reading-font", font);
  root.style.setProperty("--font", font);
  root.style.setProperty("--user-reading-size", `${settings.fontSize}px`);
  root.style.setProperty("--user-line-height", String(settings.lineHeight));
  root.style.setProperty("--user-paragraph-space", `${settings.paragraphSpace}em`);
  root.style.setProperty("--user-line-measure", `${settings.lineMeasure}ch`);
  if (settings.foreground) {
    root.style.setProperty("--user-foreground", settings.foreground);
    root.style.setProperty("--fg", settings.foreground);
    root.style.setProperty("--fg-soft", settings.foreground);
    root.style.setProperty("--muted", settings.foreground);
  } else {
    root.style.removeProperty("--user-foreground");
    root.style.removeProperty("--fg");
    root.style.removeProperty("--fg-soft");
    root.style.removeProperty("--muted");
  }
  if (settings.background) {
    root.style.setProperty("--user-background", settings.background);
    for (const token of ["--bg", "--surface", "--surface-1", "--surface-2", "--surface-3"]) root.style.setProperty(token, settings.background);
  } else {
    root.style.removeProperty("--user-background");
    for (const token of ["--bg", "--surface", "--surface-1", "--surface-2", "--surface-3"]) root.style.removeProperty(token);
  }
  root.toggleAttribute("data-user-presentation", settings.foreground !== "" || settings.background !== "" || settings.font !== "system" || settings.fontSize !== 16 || settings.lineHeight !== 1.6 || settings.paragraphSpace !== 2.4 || settings.lineMeasure !== 80);
}

if (typeof window !== "undefined") {
  apply(current);
  window.addEventListener("storage", (event) => {
    if (event.key === KEY || event.key === null) {
      current = load();
      apply(current);
      listeners.forEach((listener) => listener());
    }
  });
}

export function setPresentation(patch: Partial<PresentationSettings>) {
  current = normalizePresentation({ ...current, ...patch });
  try { if (typeof localStorage !== "undefined") localStorage.setItem(KEY, JSON.stringify(current)); } catch { /* keep the current page choice */ }
  apply(current);
  listeners.forEach((listener) => listener());
}

export const usePresentation = () => useSyncExternalStore((listener) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}, () => current);
