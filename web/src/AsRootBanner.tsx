import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useSWRConfig } from "swr";
import { ShieldOff } from "lucide-react";
import { me, stopAsRoot, type Account } from "./auth";
import { AsRootState, STOP_FAILED } from "./asRoot";

/** "HH:MM" in local time, 24-hour. */
export const clockTime = (t: number) => {
  const d = new Date(t);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

/**
 * The header line while act as root is on: "Acting as root until HH:MM" (the local end) and a Stop button. When the
 * hub has not confirmed a Stop, an alert says so. The timer and the state live in AsRootState (useAsRoot).
 */
export function AsRootBanner({ endsAt, stopping, stopFailed, onStop }: { endsAt: number; stopping: boolean; stopFailed: boolean; onStop: () => void }) {
  return (
    <div className="ed-banner asroot-banner">
      <span role="status">Acting as root until {clockTime(endsAt)}</span>
      <button type="button" disabled={stopping} onClick={onStop}><ShieldOff aria-hidden="true" /> Stop</button>
      {stopFailed && <span className="asroot-err" role="alert">{STOP_FAILED}</span>}
    </div>
  );
}

/**
 * The act-as-root state of the signed-in account (AsRootState): always off when sign-in is off and for any account
 * that is not a system administrator. Also asks the hub again when the window comes back into view while it is on.
 * When it turns on or off, cached listings are fetched again, because what the account may see has changed.
 */
export function useAsRoot(account: Account | undefined) {
  const [state] = useState(() => new AsRootState(account, { me, stop: stopAsRoot }));
  useEffect(() => () => state.dispose(), [state]);
  const view = useSyncExternalStore(state.subscribe, state.get);
  const on = view.endsAt !== undefined;
  const { mutate } = useSWRConfig();
  const was = useRef(on);
  useEffect(() => {
    if (was.current === on) return;
    was.current = on;
    void mutate(() => true);
  }, [on, mutate]);
  useEffect(() => {
    if (!on) return;
    const check = () => {
      if (document.visibilityState === "visible") void state.refresh();
    };
    window.addEventListener("focus", check);
    document.addEventListener("visibilitychange", check);
    return () => {
      window.removeEventListener("focus", check);
      document.removeEventListener("visibilitychange", check);
    };
  }, [on, state]);
  return { view, start: state.start, stop: state.stop };
}
