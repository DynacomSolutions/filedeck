import { useEffect, useRef, useState } from "react";

type Pref = "light" | "dark" | "auto";
import { brand } from "./brand";

const KEY = brand.themeKey;
const svg = (children: React.ReactNode, fill = false) => (
  <svg viewBox="0 0 24 24" fill={fill ? "currentColor" : "none"} stroke={fill ? "none" : "currentColor"} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {children}
  </svg>
);
const ICONS: Record<Pref, React.ReactNode> = {
  light: svg(<><circle cx="12" cy="12" r="4" /><path d="M12 2v2m0 16v2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4M2 12h2m16 0h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></>),
  dark: svg(<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />),
  auto: svg(<><circle cx="12" cy="12" r="9" /><path d="M12 3a9 9 0 0 1 0 18z" fill="currentColor" stroke="none" /></>),
};
const OPTIONS: { value: Pref; label: string }[] = [
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
  { value: "auto", label: "Auto" },
];

const stored = (): Pref => {
  try {
    const p = localStorage.getItem(KEY);
    return p === "light" || p === "dark" ? p : "auto";
  } catch {
    return "auto";
  }
};

/** Light / Dark / Auto picker; the storage key comes from the deployment branding so sibling pages can share the choice. */
export function ThemeMenu() {
  const [pref, setPref] = useState<Pref>(stored);
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  const pick = (p: Pref) => {
    setPref(p);
    setOpen(false);
    if (p === "auto") delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = p;
    try {
      localStorage.setItem(KEY, p === "auto" ? "system" : p);
    } catch {
      /* storage unavailable */
    }
  };

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => !root.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("click", away);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("click", away);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);

  const cur = OPTIONS.find((o) => o.value === pref) ?? OPTIONS[2]!;
  return (
    <div className="theme-menu" ref={root}>
      <button className="user-menu__trigger" type="button" aria-controls="theme-menu-panel" aria-expanded={open} aria-label="Theme" onClick={() => setOpen((o) => !o)}>
        <span data-theme-icon>{ICONS[cur.value]}</span>
        <span>{cur.label}</span>
        <span className="user-menu__chevron" aria-hidden="true">{svg(<path d="m6 9 6 6 6-6" />)}</span>
      </button>
      <div className="dropdown" id="theme-menu-panel" hidden={!open}>
        <p className="dropdown__label">Theme</p>
        <div className="theme-options" role="radiogroup" aria-label="Theme">
          {OPTIONS.map((o) => (
            <button key={o.value} type="button" className="theme-option" role="radio" aria-checked={pref === o.value} onClick={() => pick(o.value)}>
              {ICONS[o.value]}
              <span>{o.label}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
