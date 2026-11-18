import { useEffect, useRef, useState } from "react";
import { RefreshCw } from "lucide-react";
import { brand } from "./brand";
import { applyUpdate, checkForUpdate, useUpdateState } from "./pwa";

/** How often the "hub not reachable" screen tries again by itself. */
export const RETRY_MS = 15_000;

const Mark = () => (
  <svg className="brand-mark pwa-mark" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
    <path d="M8 3h8M5.5 6.5h13" />
    <path d="M3 19v-8a1 1 0 0 1 1-1h4a1 1 0 0 1 .7.3L10.5 12H20a1 1 0 0 1 1 1v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
  </svg>
);

/**
 * Shown in place of the app when the hub cannot be reached (the app opened from the stored shell, or the network is
 * gone). Tries again every RETRY_MS, when the browser goes online, and on "Try again".
 */
export function HubUnreachable({ retry }: { retry: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [tries, setTries] = useState(0);
  const heading = useRef<HTMLHeadingElement>(null);
  const again = useRef(retry);
  again.current = retry;
  const run = () => {
    setBusy(true);
    // the app may have opened from a stored older version: ask for the current one as soon as the hub answers
    void again.current().finally(() => {
      checkForUpdate();
      setBusy(false);
      setTries((n) => n + 1);
    });
  };
  useEffect(() => heading.current?.focus(), []);
  useEffect(() => {
    const t = window.setInterval(run, RETRY_MS);
    window.addEventListener("online", run);
    return () => {
      window.clearInterval(t);
      window.removeEventListener("online", run);
    };
  }, []);
  return (
    <main className="signin">
      <div className="modal signin-form pwa-offline">
        <Mark />
        <h1 ref={heading} tabIndex={-1}>{brand.name} hub not reachable</h1>
        <p className="signin-note">
          This device cannot reach the {brand.name} hub. Check the network connection; the app opens as soon as the hub answers.
        </p>
        <p className="signin-note" role="status">{busy ? "Trying again..." : tries > 0 ? "Still not reachable. Trying again every 15 seconds." : "Trying again every 15 seconds."}</p>
        <div className="modal-actions">
          <button type="button" disabled={busy} onClick={run}><RefreshCw aria-hidden="true" /> Try again</button>
        </div>
      </div>
    </main>
  );
}

/** "A new version is ready" with Reload, at the bottom of the window; never reloads by itself. */
export function UpdateBanner() {
  const s = useUpdateState();
  if (s === "none") return null;
  return (
    <div className="pwa-update" role="status">
      <span>{s === "ready" ? `A new version of ${brand.name} is ready.` : `${brand.name} was updated in another tab. Reload to use the new version.`}</span>
      <button type="button" onClick={applyUpdate}><RefreshCw aria-hidden="true" /> Reload</button>
    </div>
  );
}
