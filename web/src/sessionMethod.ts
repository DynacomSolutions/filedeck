import type { SessionInfo } from "./admin";

/** How a session signed in, as the Signed in tab shows it: "Password", "Key", "Tailscale (socket)", or "Tailscale" when the source is not known. */
export function methodView(s: Pick<SessionInfo, "method" | "tailnet" | "tailnetSource" | "tailnetDevice">): { label: string; subject?: string; device?: string } {
  if (s.method === "tailscale") {
    return { label: s.tailnetSource ? `Tailscale (${s.tailnetSource})` : "Tailscale", ...(s.tailnet ? { subject: s.tailnet } : {}), ...(s.tailnetDevice ? { device: s.tailnetDevice } : {}) };
  }
  if (s.method === "password") return { label: "Password" };
  if (s.method === "key") return { label: "Key" };
  return { label: "Unknown" };
}
