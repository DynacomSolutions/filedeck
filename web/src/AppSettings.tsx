import { useEffect, useState } from "react";
import * as Ic from "lucide-react";
import { brand } from "./brand";
import { disablePush, enablePush, notifySupport, promptInstall, requestNotify, useCanInstall, type NotifySupport } from "./pwa";
import { setSettings, useSettings } from "./settings";

const NOTE: Record<NotifySupport, string> = {
  granted: "",
  default: "",
  denied: "Notifications are blocked for this site in the browser. Allow them in the browser's site settings, then turn this on.",
  unsupported: "This browser cannot show notifications.",
};

/**
 * Settings, "App": job notifications and Install app. Permission is asked only when the switch is turned on, never on
 * load; the switch shows on only while the browser still grants it.
 */
export function AppSettings() {
  const s = useSettings();
  const [perm, setPerm] = useState<NotifySupport>(notifySupport);
  const canInstall = useCanInstall();
  // permission changed in the browser's site settings while Settings is open
  useEffect(() => {
    let status: PermissionStatus | undefined;
    let gone = false;
    const sync = () => setPerm(notifySupport());
    void navigator.permissions?.query({ name: "notifications" }).then((s) => {
      if (gone) return;
      status = s;
      s.addEventListener("change", sync);
    }, () => undefined);
    return () => {
      gone = true;
      status?.removeEventListener("change", sync);
    };
  }, []);
  const on = s.notifyJobs && perm === "granted";
  /** "on": the hub notifies, also while the app is closed; "local": only while a tab is open (no push here); "" not asked yet */
  const [push, setPush] = useState<"" | "on" | "local">("");
  const toggle = async (want: boolean) => {
    if (!want) {
      setSettings({ notifyJobs: false });
      setPush("");
      return void disablePush();
    }
    const p = perm === "granted" ? perm : await requestNotify();
    setPerm(p);
    setSettings({ notifyJobs: p === "granted" });
    if (p === "granted") setPush((await enablePush()) === "on" ? "on" : "local");
  };
  const Bell = on ? Ic.Bell : Ic.BellOff;
  return (
    <section className="set-sec" aria-labelledby="set-app">
      <h2 id="set-app">App</h2>
      <div className="set-opts">
        <label className={"set-opt set-switch" + (on ? " on" : "")}>
          <input type="checkbox" role="switch" checked={on} disabled={perm === "unsupported"} aria-describedby="set-notify-help" onChange={(e) => void toggle(e.target.checked)} />
          <Bell aria-hidden="true" />
          <span>
            <b>Notify me when a job ends</b>
            <span className="muted" id="set-notify-help">
              Copy, move, compress, extract, sync and compare jobs that finish or fail, also while {brand.name} is closed; uploads while it is open. Kept in this browser.
            </span>
          </span>
        </label>
      </div>
      {NOTE[perm] && <p className="muted" role="status">{NOTE[perm]}</p>}
      {on && push === "local" && (
        <p className="muted" role="status">This browser or hub cannot send notifications while {brand.name} is closed; you get them while a {brand.name} tab is open.</p>
      )}
      {canInstall && (
        <div className="set-app-row">
          <button type="button" onClick={() => void promptInstall()}><Ic.Download aria-hidden="true" /> Install app</button>
          <span className="muted">Adds {brand.name} to the home screen or app list, in its own window.</span>
        </div>
      )}
    </section>
  );
}
