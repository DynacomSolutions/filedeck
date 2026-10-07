import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown, type LucideIcon } from "lucide-react";

export interface DropdownOption {
  value: string;
  label: string;
  Icon?: LucideIcon;
  disabled?: boolean;
}

interface Props {
  value: string;
  options: DropdownOption[];
  onChange: (value: string) => void;
  /** accessible name of the control (the current option is appended to the trigger's name) */
  label: string;
  /** trigger shows only the selected option's icon (needs an Icon on every option) */
  iconOnly?: boolean;
  disabled?: boolean;
  autoFocus?: boolean;
  id?: string;
  className?: string;
  /** keeps the trigger focused after a choice (the default); exposed so callers can re-focus after a remount */
  triggerRef?: React.Ref<HTMLButtonElement>;
}

/** Whether a pointerdown at `target` should close an open menu: never when it lands on the trigger, which toggles itself. */
export const shouldCloseOnOutside = (target: Node | null, menu: Node | null, trigger: Node | null): boolean =>
  !!target && !(menu && menu.contains(target)) && !(trigger && trigger.contains(target));

/** Custom replacement for the native select: a trigger button plus a themed `menu` of `menuitemradio` rows (arrows, Home/End, Enter/Space, Esc, type-ahead off). */
export function Dropdown({ value, options, onChange, label, iconOnly, disabled, autoFocus, id, className, triggerRef }: Props) {
  const [open, setOpen] = useState(false);
  const [cur, setCur] = useState(0);
  const [pos, setPos] = useState<{ left: number; top: number; minWidth: number; maxH: number } | null>(null);
  const btn = useRef<HTMLButtonElement | null>(null);
  const menu = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const selected = options.find((o) => o.value === value) ?? options[0];
  const enabled = options.map((o, i) => [o, i] as const).filter(([o]) => !o.disabled).map(([, i]) => i);

  const setBtn = useCallback((el: HTMLButtonElement | null) => {
    btn.current = el;
    if (typeof triggerRef === "function") triggerRef(el);
    else if (triggerRef) (triggerRef as React.MutableRefObject<HTMLButtonElement | null>).current = el;
  }, [triggerRef]);

  const close = useCallback((restore: boolean) => {
    setOpen(false);
    if (restore) btn.current?.focus({ preventScroll: true });
  }, []);
  const show = () => {
    setCur(Math.max(0, options.findIndex((o) => o.value === value)));
    setOpen(true);
  };

  useLayoutEffect(() => {
    if (!open || !btn.current) return;
    const r = btn.current.getBoundingClientRect();
    const vw = document.documentElement.clientWidth;
    const vh = document.documentElement.clientHeight;
    const h = menu.current?.offsetHeight ?? 0;
    const w = menu.current?.offsetWidth ?? 0;
    const below = vh - r.bottom - 8;
    const up = h > below && r.top > below;
    const maxH = Math.max(120, up ? r.top - 8 : below);
    setPos({ left: Math.max(4, Math.min(r.left, vw - Math.max(w, r.width) - 4)), top: up ? Math.max(4, r.top - 4 - Math.min(h, maxH)) : r.bottom + 4, minWidth: r.width, maxH });
  }, [open, options.length]);

  useEffect(() => {
    if (!open) return;
    const down = (e: Event) => shouldCloseOnOutside(e.target as Node, menu.current, btn.current) && setOpen(false);
    const away = () => setOpen(false);
    window.addEventListener("pointerdown", down, true);
    window.addEventListener("resize", away);
    window.addEventListener("blur", away);
    return () => {
      window.removeEventListener("pointerdown", down, true);
      window.removeEventListener("resize", away);
      window.removeEventListener("blur", away);
    };
  }, [open]);

  useEffect(() => {
    if (open) menu.current?.querySelector<HTMLElement>(`[data-i="${cur}"]`)?.focus({ preventScroll: true });
    menu.current?.querySelector<HTMLElement>(`[data-i="${cur}"]`)?.scrollIntoView({ block: "nearest" });
  }, [open, cur, pos]);

  const choose = (o: DropdownOption) => {
    if (o.disabled) return;
    close(true);
    if (o.value !== value) onChange(o.value);
  };
  const onMenuKey = (e: React.KeyboardEvent) => {
    const at = enabled.indexOf(cur);
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (enabled.length) setCur(enabled[(Math.max(at, 0) + (e.key === "ArrowDown" ? 1 : -1) + enabled.length) % enabled.length]!);
    } else if (e.key === "Home" || e.key === "End") {
      e.preventDefault();
      if (enabled.length) setCur(enabled[e.key === "Home" ? 0 : enabled.length - 1]!);
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      const o = options[cur];
      if (o) choose(o);
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close(true);
    } else if (e.key === "Tab") {
      e.preventDefault();
      close(true);
    }
  };
  const onTriggerKey = (e: React.KeyboardEvent) => {
    if (open || disabled) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      show();
    }
  };

  // the visible text of a text trigger must be part of its accessible name (WCAG 2.5.3), so the current option is always appended
  const name = `${label}: ${selected?.label ?? ""}`;
  const Sel = selected?.Icon;
  return (
    <>
      <button
        ref={setBtn}
        id={id}
        type="button"
        className={"dd-btn" + (iconOnly ? " dd-icon" : "") + (open ? " open" : "") + (className ? " " + className : "")}
        aria-label={name}
        title={iconOnly ? name : undefined}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        disabled={disabled}
        autoFocus={autoFocus}
        onClick={() => (open ? close(false) : show())}
        onKeyDown={onTriggerKey}
      >
        {Sel && <Sel aria-hidden="true" />}
        {!iconOnly && <span className="dd-text">{selected?.label}</span>}
        {!iconOnly && <ChevronDown className="dd-caret" aria-hidden="true" />}
      </button>
      {open &&
        createPortal(
          <div
            ref={menu}
            id={menuId}
            role="menu"
            aria-label={label}
            className="dd-menu"
            style={pos ? { left: pos.left, top: pos.top, minWidth: pos.minWidth, maxHeight: pos.maxH } : { left: -9999, top: 0 }}
            onKeyDown={onMenuKey}
          >
            {options.map((o, i) => (
              <button
                key={o.value}
                type="button"
                role="menuitemradio"
                aria-checked={o.value === value}
                data-i={i}
                tabIndex={i === cur ? 0 : -1}
                disabled={o.disabled}
                className={"dd-item" + (i === cur ? " cur" : "")}
                onMouseMove={() => !o.disabled && cur !== i && setCur(i)}
                onClick={() => choose(o)}
              >
                {o.Icon && <o.Icon aria-hidden="true" />}
                <span className="dd-text">{o.label}</span>
                {o.value === value && <Check className="dd-check" aria-hidden="true" />}
              </button>
            ))}
          </div>,
          document.body,
        )}
    </>
  );
}
