import { useEffect, useState } from "react";
import { LogOut, RefreshCw } from "lucide-react";
import { brand } from "./brand";
import type { RetryView } from "./tailnetRetry";

type Props = { view: RetryView; onRetry: () => void; onSignOut: () => void };

/** The status line: it changes after a failed try, so a screen reader says it again. */
const statusText = (v: RetryView) => (v.failures > 0 ? "Tailscale is still not answering, trying again." : "Tailscale is not answering, trying again.");

/**
 * "Try now" (shows "Trying…" while a try is in flight; presses are then ignored, and the button stays focusable so focus
 * does not jump) and "Sign out" (the way to the password form while tailscaled stays down).
 */
function Actions({ view, onRetry, onSignOut }: Props) {
  const [leaving, setLeaving] = useState(false);
  return (
    <>
      <button type="button" aria-disabled={view.trying || undefined} onClick={() => !view.trying && onRetry()}>
        <RefreshCw aria-hidden="true" /> {view.trying ? "Trying…" : "Try now"}
      </button>
      <button type="button" aria-disabled={leaving || undefined} onClick={() => !leaving && (setLeaving(true), onSignOut())}>
        <LogOut aria-hidden="true" /> Sign out
      </button>
    </>
  );
}

/**
 * Shown instead of the app when the first `GET /api/auth/me` answers the hub's tailnet 503: a Tailscale session whose
 * tailscaled does not answer. The hub keeps the session, so this is not the sign-in screen; the app asks again with a
 * growing wait (tailnetRetry.ts).
 */
export function TailnetWaiting(p: Props) {
  useEffect(() => {
    document.title = brand.title;
  }, []);
  return (
    <main className="signin">
      <div className="modal signin-form" role="group" aria-labelledby="tailnet-wait-h">
        <h1 id="tailnet-wait-h">{brand.title}</h1>
        <p className="pad0" role="status">{statusText(p.view)}</p>
        <div className="modal-actions">
          <Actions {...p} />
        </div>
      </div>
    </main>
  );
}

/**
 * The same state while the app is open: a banner over the app, which stays mounted (open panels and editors keep their
 * state). It goes once `me` answers again.
 */
export function TailnetBanner(p: Props) {
  return (
    <div className="tailnet-banner" role="region" aria-label="Tailscale">
      <p role="status">{statusText(p.view)}</p>
      <div className="tailnet-banner-acts">
        <Actions {...p} />
      </div>
    </div>
  );
}
