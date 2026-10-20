import { useEffect, useRef } from "react";
import { SavedPasswords } from "./SavedPasswords";
import { PresentationSettings } from "./PresentationSettings";
import { Tip } from "./Tooltip";
import { TREE_FOLDS, UP_ROWS, setSettings, useSettings, type TreeFold, type UpRow } from "./settings";
import * as Ic from "lucide-react";
import { useDialogFocus } from "./dialogFocus";

const ICON: Record<UpRow, Ic.LucideIcon> = { dots: Ic.CornerLeftUp, up: Ic.ArrowUp, hidden: Ic.EyeOff };
const FOLD_ICON: Record<TreeFold, Ic.LucideIcon> = { 0: Ic.ListTree, 2: Ic.Ellipsis, 3: Ic.Ellipsis, 4: Ic.Ellipsis, 5: Ic.Ellipsis };

/** Settings view (overlay like the trash browser). Choices are kept in this browser. */
export function SettingsView({ onClose }: { onClose: () => void }) {
  const s = useSettings();
  const root = useRef<HTMLDivElement>(null);
  useDialogFocus(root);
  useEffect(() => root.current?.focus(), []);
  return (
    <div
      ref={root}
      className="ed settings over"
      role="dialog"
      aria-modal="true"
      aria-label="Settings"
      tabIndex={-1}
      onKeyDown={(e) => {
        if (e.key === "Escape") onClose();
      }}
    >
      <div className="ed-head" role="group" aria-label="Toolbar">
        <b>Settings</b>
        <span className="ed-spacer" />
        <Tip label="Close" shortcut="Esc"><button onClick={onClose}><Ic.X /> Close</button></Tip>
      </div>
      <div className="ed-body set-body">
        <section className="set-sec" aria-labelledby="set-up">
          <h2 id="set-up">Parent folder row</h2>
          <p className="muted">The row at the top of a folder listing that goes up one level. It stays visible while a folder loads, in the grid and in compare mode.</p>
          <div className="set-opts" role="radiogroup" aria-labelledby="set-up">
            {UP_ROWS.map((o) => {
              const Icon = ICON[o.value];
              return (
                <label key={o.value} className={"set-opt" + (s.upRow === o.value ? " on" : "")}>
                  <input type="radio" name="upRow" value={o.value} checked={s.upRow === o.value} onChange={() => setSettings({ upRow: o.value })} />
                  <Icon aria-hidden="true" />
                  <span><b>{o.label}</b><span className="muted">{o.help}</span></span>
                </label>
              );
            })}
          </div>
        </section>
        <section className="set-sec" aria-labelledby="set-fold">
          <h2 id="set-fold">Sidebar folder paths</h2>
          <p className="muted">Long paths in the sidebar collapse their middle folders into a "..." row.</p>
          <div className="set-opts" role="radiogroup" aria-labelledby="set-fold">
            {TREE_FOLDS.map((o) => {
              const Icon = FOLD_ICON[o.value];
              return (
                <label key={o.value} className={"set-opt" + (s.treeFold === o.value ? " on" : "")}>
                  <input type="radio" name="treeFold" value={o.value} checked={s.treeFold === o.value} onChange={() => setSettings({ treeFold: o.value })} />
                  <Icon aria-hidden="true" />
                  <span><b>{o.label}</b><span className="muted">{o.help}</span></span>
                </label>
              );
            })}
          </div>
        </section>
        <PresentationSettings />
        <SavedPasswords />
      </div>
    </div>
  );
}
