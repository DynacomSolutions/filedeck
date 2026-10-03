import { useEffect, useRef } from "react";
import * as Ic from "lucide-react";

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
      ["Shift+F10 / Menu key", "Context menu"],
      ["?", "This help"],
    ],
  },
];

export function ShortcutHelp({ onClose }: { onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => ref.current?.focus(), []);
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
        onKeyDown={(e) => {
          if (e.key === "Escape" || e.key === "?" || e.key === "Enter") {
            e.preventDefault();
            e.stopPropagation();
            onClose();
          }
        }}
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
        <div className="modal-actions">
          <button type="submit" onClick={onClose}><Ic.X /> Close</button>
        </div>
      </div>
    </div>
  );
}
