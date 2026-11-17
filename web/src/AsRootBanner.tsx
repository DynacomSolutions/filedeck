import { useCallback, useEffect, useRef, useState } from "react";
import { useSWRConfig } from "swr";
import { ShieldOff } from "lucide-react";
import { me, stopAsRoot, type Account } from "./auth";

/** "HH:MM" in local time, 24-hour. */
export const clockTime = (t: number) => {
  const d = new Date(t);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

/** setTimeout cannot wait longer than this */
const MAX_DELAY = 2 ** 31 - 1;

/**
 * The header line while act as root is on: "Acting as root until HH:MM" and a Stop button. One timer calls `onEnd` at
 * `until`; Stop calls `onStop`. The parent drops `until` in both cases, which removes the banner.
 */
export function AsRootBanner({ until, onStop, onEnd }: { until: number; onStop: () => Promise<void>; onEnd: () => void }) {
  const [busy, setBusy] = useState(false);
  const end = useRef(onEnd);
  end.current = onEnd;
  useEffect(() => {
    const t = setTimeout(() => end.current(), Math.min(Math.max(0, until - Date.now()), MAX_DELAY));
    return () => clearTimeout(t);
  }, [until]);
  const stop = async () => {
    setBusy(true);
    try {
      await onStop();
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="ed-banner asroot-banner" role="status">
      <span>Acting as root until {clockTime(until)}</span>
      <button type="button" disabled={busy} onClick={() => void stop()}><ShieldOff aria-hidden="true" /> Stop</button>
    </div>
  );
}

/** The end time if it is still ahead, else nothing. */
const ahead = (t: number | undefined) => (t !== undefined && t > Date.now() ? t : undefined);

/**
 * The act-as-root state of the signed-in account. Always off (nothing shown) when sign-in is off and for any account
 * that is not a system administrator. `start` takes the end time the hub gave; `stop` turns it off on the hub; `end`
 * is the banner's timer. Each of these, and the window coming back into view while it is on, asks the hub again
 * (`me()`), so the app never keeps thinking it is root after the hub has ended it. When it turns on or off, cached
 * listings are fetched again, because what the account may see has changed.
 */
export function useAsRoot(account: Account | undefined) {
  const allowed = account?.kind === "sys" && account.admin;
  const [until, setUntil] = useState(() => (allowed ? ahead(account.asRootUntil) : undefined));
  const refresh = useCallback(async () => {
    try {
      const m = await me();
      setUntil(m !== "signed-out" && m.auth && m.kind === "sys" && m.admin ? ahead(m.asRootUntil) : undefined);
    } catch {
      // the hub cannot be reached: keep what is known; the timer still ends it at its time
    }
  }, []);
  const on = allowed && until !== undefined;
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
      if (document.visibilityState === "visible") void refresh();
    };
    window.addEventListener("focus", check);
    document.addEventListener("visibilitychange", check);
    return () => {
      window.removeEventListener("focus", check);
      document.removeEventListener("visibilitychange", check);
    };
  }, [on, refresh]);
  const start = useCallback((t: number) => setUntil(ahead(t)), []);
  const stop = useCallback(async () => {
    try {
      await stopAsRoot();
      setUntil(undefined);
    } catch {
      // not confirmed: the hub's answer below decides whether the banner stays
    }
    await refresh();
  }, [refresh]);
  const end = useCallback(() => {
    setUntil(undefined);
    void refresh();
  }, [refresh]);
  return { until: on ? until : undefined, start, stop, end };
}
