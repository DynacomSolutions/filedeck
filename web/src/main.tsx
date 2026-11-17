import { lazy, Suspense, useEffect, useState } from "react";
import { SWRConfig } from "swr";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { swrConfig } from "./data";
import "./styles.css";
import "./accessibility.css";
import "./sidebar.css";
import "./phone.css";
import { AccessibilityChrome } from "./AccessibilityChrome";
import { ErrorBoundary } from "./ErrorBoundary";
import { installViewportTracking } from "./viewport";
import { installSignedOutWatch, me, type Me } from "./auth";

installViewportTracking();

const SignIn = lazy(() => import("./SignIn").then((m) => ({ default: m.SignIn })));

type View = "loading" | "sign-in" | Me;

// Installed before the first request, so a session that ends while the app is open shows the sign-in screen.
// Only the gate's signed-out header counts; an archive's password 401 still reaches its prompt.
let show: (v: View) => void = () => {};
let signedOut = false;
installSignedOutWatch(() => {
  signedOut = true;
  show("sign-in");
});

/** The app when sign-in is off or done, else the sign-in screen. */
function Root() {
  const [view, setView] = useState<View>("loading");
  useEffect(() => {
    show = setView;
    if (signedOut) return setView("sign-in");
    me()
      .then((m) => setView((v) => (v === "sign-in" ? v : m === "signed-out" ? "sign-in" : m)))
      // An older hub or a failed request: show the app as before; its own requests report what is wrong.
      .catch(() => setView((v) => (v === "sign-in" ? v : { auth: false })));
  }, []);
  if (view === "loading") return null;
  if (view === "sign-in") return <Suspense fallback={null}><SignIn onSignedIn={() => location.reload()} /></Suspense>;
  return (
    <>
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
