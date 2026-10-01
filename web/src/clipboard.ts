import { useSyncExternalStore } from "react";

/** The file clipboard is shared by every panel (and node), so copy here and paste there works. */
export interface Clip {
  mode: "copy" | "cut";
  /** items can come from any node (and, with a cross-panel selection, from several) */
  items: { node: string; path: string }[];
}
let clip: Clip | null = null;
const subs = new Set<() => void>();
export const getClip = () => clip;
export function setClip(c: Clip | null) {
  clip = c;
  subs.forEach((f) => f());
}
const subscribe = (f: () => void) => {
  subs.add(f);
  return () => void subs.delete(f);
};
export const useClip = () => useSyncExternalStore(subscribe, getClip);

/** Copy text to the system clipboard; falls back to a hidden textarea where the async API is unavailable. */
export async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    return;
  } catch {
    /* insecure context or permission denied */
  }
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.cssText = "position:fixed;opacity:0;top:0;left:0";
  document.body.appendChild(ta);
  ta.select();
  const ok = document.execCommand("copy");
  ta.remove();
  if (!ok) throw new Error("clipboard unavailable");
}
