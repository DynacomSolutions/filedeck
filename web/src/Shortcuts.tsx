import { useEffect, useRef, useState } from "react";
import * as Ic from "lucide-react";
import { TechnicalGlossary } from "./TechnicalGlossary";

const GROUPS: { title: string; rows: [string, string][] }[] = [
  {
    title: "Navigate",
    rows: [
      ["Up / Down", "Move the cursor (Shift extends the selection)"],
      ["Home / End", "First / last entry"],
      ["Page Up / Page Down", "Move by ten entries"],
      ["Enter", "Open folder or file"],
      ["Backspace / Alt+Up", "Go to the parent folder"],
      ["Tab / Shift+Tab", "Next / previous panel from the file list (after the last panel Tab moves on to the rest of the page)"],
      ["Ctrl+F", "Filter this folder by name"],
      ["Alt+T / Alt+W", "New tab with this folder / close the tab"],
      ["Alt+[ / Alt+]", "Previous / next tab"],
      ["Tab menu: Move left / Move right", "Reorder tabs in this panel (or drag a tab)"],
      ["Alt+Shift+Arrows", "Dock this panel beside the previous / next panel (or drag the panel header: edge splits, centre merges as a tab)"],
      ["Ctrl+Shift+F", "Search under this folder (name, glob, regex, file content)"],
      ["Esc", "Clear filter, then selection"],
    ],
  },
  {
    title: "Select",
    rows: [
      ["Ctrl+A", "Select all (visible) entries"],
      ["Ctrl+click / Shift+click", "Toggle / range select"],
    ],
  },
  {
    title: "Act",
    rows: [
      ["F2", "Rename"],
      ["Alt+Enter", "Properties in the side panel"],
      ["F4", "Edit in the built-in editor"],
      ["F5", "Copy selection to the next panel"],
      ["F6", "Move selection to the next panel"],
      ["F7", "New folder"],
      ["Alt+N / Alt+U", "New file / upload files into this folder"],
      ["Alt+R / Alt+C", "Refresh the folder / copy its path"],
      ["Del", "Move to trash"],
      ["Shift+Del", "Delete permanently (asks first)"],
      ["Ctrl+C / Ctrl+X / Ctrl+V", "Copy / cut / paste (across panels and nodes)"],
      ["Context menu: Copy to folder / Move to folder", "Choose any online node and destination folder"],
      ["Shift+F10 / Menu key", "Context menu"],
      ["?", "This help"],
    ],
  },
];

export function ShortcutHelp({ onClose }: { onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const opener = useRef<HTMLElement | null>(document.activeElement as HTMLElement | null);
  const [helpKeyEnabled, setHelpKeyEnabled] = useState(() => {
    try { return localStorage.getItem("filedeck.help-key-disabled") !== "true"; }
    catch { return true; }
  });
  useEffect(() => {
    const frame = requestAnimationFrame(() => ref.current?.focus());
    return () => {
      cancelAnimationFrame(frame);
      opener.current?.focus({ preventScroll: true });
    };
  }, []);
  const trap = (e: React.KeyboardEvent) => {
    if (e.key === "Escape" || (e.key === "?" && e.target === ref.current)) {
      e.preventDefault();
      e.stopPropagation();
      return onClose();
    }
    if (e.key !== "Tab" || !ref.current) return;
    const f = Array.from(ref.current.querySelectorAll<HTMLElement>("button:not([disabled]),input:not([disabled]),summary,a[href],[tabindex]:not([tabindex='-1'])")).filter((el) => el.offsetParent !== null);
    if (!f.length) return;
    const first = f[0]!;
    const last = f[f.length - 1]!;
    if (e.shiftKey && document.activeElement === first) (e.preventDefault(), last.focus());
    else if (!e.shiftKey && document.activeElement === last) (e.preventDefault(), first.focus());
  };
  return (
    <div className="modal-back" onMouseDown={onClose}>
      <div
        ref={ref}
        className="modal wide kbd-help"
        role="dialog"
        aria-modal="true"
        aria-label="Keyboard shortcuts"
        tabIndex={-1}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={trap}
      >
        <h2>Keyboard shortcuts</h2>
        {GROUPS.map((g) => (
          <section key={g.title}>
            <h4>{g.title}</h4>
            <dl>
              {g.rows.map(([k, d]) => (
                <div key={k}>
                  <dt>{k.split(" / ").map((x, i) => (i ? [" / ", <kbd key={x}>{x}</kbd>] : <kbd key={x}>{x}</kbd>))}</dt>
                  <dd>{d}</dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
        <label className="shortcut-pref">
          <input
            className="shortcut-pref-input"
            type="checkbox"
            checked={helpKeyEnabled}
            onChange={(e) => {
              const enabled = e.currentTarget.checked;
              setHelpKeyEnabled(enabled);
              try { localStorage.setItem("filedeck.help-key-disabled", String(!enabled)); } catch { /* page-session choice still applies to this dialog */ }
            }}
          />
          Enable the single-character ? shortcut (you can always open this help with the keyboard button)
        </label>
        <TechnicalGlossary />
        <div className="modal-actions">
          <button type="button" onClick={onClose}><Ic.X /> Close</button>
        </div>
      </div>
    </div>
  );
}
