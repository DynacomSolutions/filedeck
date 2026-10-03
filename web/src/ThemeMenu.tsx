import { useState } from "react";
import { Monitor, Moon, Sun, type LucideIcon } from "lucide-react";
import { brand } from "./brand";
import { Tip } from "./Tooltip";

type Pref = "light" | "dark" | "auto";

const KEY = brand.themeKey;
const OPTIONS: { value: Pref; label: string; Icon: LucideIcon }[] = [
  { value: "light", label: "Light", Icon: Sun },
  { value: "dark", label: "Dark", Icon: Moon },
  { value: "auto", label: "Auto", Icon: Monitor },
];

const stored = (): Pref => {
  try {
    const p = localStorage.getItem(KEY);
    return p === "light" || p === "dark" ? p : "auto";
  } catch {
    return "auto";
  }
};

/** Light / Dark / Auto segmented control pinned to the sidebar bottom; the storage key comes from the deployment branding so sibling pages can share the choice. */
export function ThemeMenu() {
  const [pref, setPref] = useState<Pref>(stored);

  const pick = (p: Pref) => {
    setPref(p);
    if (p === "auto") delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = p;
    try {
      localStorage.setItem(KEY, p === "auto" ? "system" : p);
    } catch {
      /* storage unavailable */
    }
  };
  const move = (e: React.KeyboardEvent, i: number) => {
    const d = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
    if (!d) return;
    e.preventDefault();
    const n = OPTIONS[(i + d + OPTIONS.length) % OPTIONS.length]!;
    pick(n.value);
    (e.currentTarget.closest("[role=radiogroup]")?.querySelector(`[data-v="${n.value}"]`) as HTMLElement | null)?.focus();
  };

  return (
    <div className="theme-seg" role="radiogroup" aria-label="Theme">
      {OPTIONS.map(({ value, label, Icon }, i) => (
        <Tip key={value} label={label}>
          <button type="button" data-v={value} role="radio" aria-label={label} aria-checked={pref === value} tabIndex={pref === value ? 0 : -1} onClick={() => pick(value)} onKeyDown={(e) => move(e, i)}>
            <Icon aria-hidden="true" />
          </button>
        </Tip>
      ))}
    </div>
  );
}
