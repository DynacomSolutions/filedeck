import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { SWRConfig } from "swr";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { swrConfig } from "./data";
import "./styles.css";
import "./accessibility.css";
import "./sidebar.css";
import "./phone.css";
import "./bars.css";
import "./pwa.css";
import { AccessibilityChrome } from "./AccessibilityChrome";
import { ErrorBoundary } from "./ErrorBoundary";
import { installViewportTracking } from "./viewport";
import { installSignedOutWatch, me, type Me } from "./auth";
import { installPwa, resyncPush } from "./pwa";
import { hubUnreachable } from "./pwaState";
import { HubUnreachable, UpdateBanner } from "./PwaScreens";

installViewportTracking();
installPwa();

const SignIn = lazy(() => import("./SignIn").then((m) => ({ default: m.SignIn })));

type View = "loading" | "sign-in" | "offline" | Me;

// Installed before the first request, so a session that ends while the app is open shows the sign-in screen.
// Only the gate's signed-out header counts; an archive's password 401 still reaches its prompt.
let show: (v: View) => void = () => {};
let signedOut = false;
installSignedOutWatch(() => {
  signedOut = true;
  show("sign-in");
});

/**
 * After a sign-in: the first one reloads the page (the URL keeps the layout). When the session ended while the app
 * was open and the same account signs in again, the app is shown again without a reload, so unsaved editor text
 * (editDrafts) comes back. Another account gets a fresh page.
 */
async function afterSignIn(shownAs: string | undefined, setView: (v: View) => void) {
  const m = shownAs ? await me().catch(() => null) : null;
  if (m && m !== "signed-out" && m.auth && `${m.kind}:${m.name}` === shownAs) {
    signedOut = false;
    setView(m);
  } else location.reload();
}

/** The app when sign-in is off or done, else the sign-in screen. */
function Root() {
  const [view, setView] = useState<View>("loading");
  /** the account the app was last shown for, as kind:name */
  const shownAs = useRef<string | undefined>(undefined);
  const ask = () =>
    me()
      .then((m) => setView((v) => (v === "sign-in" ? v : m === "signed-out" ? "sign-in" : m)))
      // No answer from the hub (offline, or a gateway saying it is down): say so and keep trying (PwaScreens). An older
      // hub or another failed request: show the app as before; its own requests report what is wrong.
      .catch((e: unknown) => setView((v) => (v === "sign-in" ? v : hubUnreachable(e) ? "offline" : { auth: false })));
  useEffect(() => {
    show = setView;
    if (signedOut) return setView("sign-in");
    void ask();
  }, []);
  useEffect(() => {
    if (typeof view === "object" && view.auth) shownAs.current = `${view.kind}:${view.name}`;
    // the app is shown (sign-in off, or signed in): the hub gets this browser's push subscription for this session
    if (typeof view === "object") void resyncPush();
  }, [view]);
  if (view === "loading") return null;
  if (view === "offline") return <><HubUnreachable retry={ask} /><UpdateBanner /></>;
  // the sign-in chunk loads on demand; a page of an older build may no longer find it, so a failure shows the error screen (with reload), never a blank page
  if (view === "sign-in") return <><ErrorBoundary what="Sign-in" scope="root"><Suspense fallback={null}><SignIn onSignedIn={() => void afterSignIn(shownAs.current, setView)} /></Suspense></ErrorBoundary><UpdateBanner /></>;
  return (
    <>
      <UpdateBanner />
      <AccessibilityChrome />
      <ErrorBoundary what="Filedeck" scope="root">
        <App account={view.auth ? view : undefined} />
      </ErrorBoundary>
    </>
  );
}

createRoot(document.getElementById("root") as HTMLElement).render(<SWRConfig value={swrConfig}>
  <Root />
</SWRConfig>);
