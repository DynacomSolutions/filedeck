import { useEffect } from "react";

const APP_TITLE = "Filedeck";

function pageTitle() {
  const dialog = document.querySelector<HTMLElement>('[role="dialog"][aria-label]:not([hidden])');
  const dialogLabel = dialog?.getAttribute("aria-label");
  if (dialogLabel) return `${dialogLabel} · ${APP_TITLE}`;

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
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["aria-label", "aria-modal", "class", "hidden"] });
    document.addEventListener("focusin", updateTitle);
    updateTitle();

    return () => {
      observer.disconnect();
      document.removeEventListener("focusin", updateTitle);
    };
  }, []);

  return <a className="skip-link" href="#filedeck-main">Skip to file panels</a>;
}
