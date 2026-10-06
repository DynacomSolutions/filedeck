import { useEffect } from "react";

const APP_TITLE = "Filedeck";

function isVisibleDialog(dialog: HTMLElement): boolean {
  if (dialog.closest("[hidden], [aria-hidden='true']")) return false;
  const style = getComputedStyle(dialog);
  return style.display !== "none" && style.visibility !== "hidden" && dialog.getClientRects().length > 0;
}

function dialogName(dialog: HTMLElement): string {
  const label = dialog.getAttribute("aria-label")?.trim();
  if (label) return label;
  const labelledBy = dialog.getAttribute("aria-labelledby");
  if (labelledBy) {
    const text = labelledBy.split(/\s+/).map((id) => document.getElementById(id)?.textContent?.trim()).filter(Boolean).join(" ");
    if (text) return text;
  }
  return dialog.querySelector("h1, h2, h3, [role='heading']")?.textContent?.trim() ?? "Dialog";
}

function pageTitle() {
  const dialogs = [...document.querySelectorAll<HTMLElement>('[role="dialog"]')].filter(isVisibleDialog);
  const focused = document.activeElement instanceof HTMLElement ? document.activeElement.closest<HTMLElement>('[role="dialog"]') : null;
  const topmost = dialogs.reduce<HTMLElement | null>((chosen, candidate) => {
    if (!chosen) return candidate;
    const zIndex = Number.parseInt(getComputedStyle(candidate).zIndex, 10) || 0;
    const chosenZ = Number.parseInt(getComputedStyle(chosen).zIndex, 10) || 0;
    return zIndex >= chosenZ ? candidate : chosen;
  }, null);
  const dialog = focused && dialogs.includes(focused) ? focused : topmost;
  if (dialog) return `${dialogName(dialog)} · ${APP_TITLE}`;

  const focusedList = document.activeElement?.closest<HTMLElement>(".fp-scroll[aria-label]");
  const activeList = document.querySelector<HTMLElement>(".fp.active .fp-scroll[aria-label]");
  const label = (focusedList ?? activeList)?.getAttribute("aria-label");
  const locationText = label?.startsWith("Files in ") && label.endsWith(". Arrow keys select, Enter opens.")
    ? label.slice("Files in ".length, -". Arrow keys select, Enter opens.".length)
    : "";
  const separator = locationText.lastIndexOf(" on ");
  const location: [string, string] | null = separator < 0 ? null : [locationText.slice(0, separator), locationText.slice(separator + 4)];
  if (location) return `${location[0]} · ${location[1]} · ${APP_TITLE}`;

  return `Files · ${APP_TITLE}`;
}

/** Adds a skip target and keeps the browser title useful as panels and dialogs change. */
export function AccessibilityChrome() {
  useEffect(() => {
    const main = document.querySelector<HTMLElement>("main");
    if (main) {
      main.id = "filedeck-main";
      main.tabIndex = -1;
    }

    const updateTitle = () => {
      document.title = pageTitle();
    };
    const observer = new MutationObserver(updateTitle);
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["aria-label", "aria-labelledby", "aria-modal", "aria-hidden", "class", "hidden", "style"] });
    document.addEventListener("focusin", updateTitle);
    updateTitle();

    return () => {
      observer.disconnect();
      document.removeEventListener("focusin", updateTitle);
    };
  }, []);

  return <a className="skip-navigation" data-nav href="#filedeck-main">Skip to file panels</a>;
}
