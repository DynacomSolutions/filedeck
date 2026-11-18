import { lazy, Suspense, useEffect, useRef, useState } from "react";
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
import { installSignedOutWatch, me, retryDelayMs, TailnetUnavailableError, type Me } from "./auth";

installViewportTracking();

const SignIn = lazy(() => import("./SignIn").then((m) => ({ default: m.SignIn })));
const TailnetWaiting = lazy(() => import("./SignIn").then((m) => ({ default: m.TailnetWaiting })));

/** "waiting": `me` answered 503 (a Tailscale session while tailscaled does not answer); asked again with a growing wait. */
type View = "loading" | "sign-in" | "waiting" | Me;

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
  /** asks `me` again at once (the waiting screen's "Try now") */
  const askNow = useRef<() => void>(() => {});
  useEffect(() => {
    show = setView;
    if (signedOut) return setView("sign-in");
    let gone = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let tries = 0;
    const ask = () => {
      clearTimeout(timer);
      me()
        .then((m) => !gone && setView((v) => (v === "sign-in" ? v : m === "signed-out" ? "sign-in" : m)))
        .catch((e: unknown) => {
          if (gone) return;
          // a Tailscale session whose tailscaled does not answer: the hub keeps the session, so wait and ask again
          if (e instanceof TailnetUnavailableError) {
            setView((v) => (v === "sign-in" ? v : "waiting"));
            timer = setTimeout(ask, retryDelayMs(tries++));
            return;
          }
          // An older hub or a failed request: show the app as before; its own requests report what is wrong.
          setView((v) => (v === "sign-in" ? v : { auth: false }));
        });
    };
    askNow.current = ask;
    ask();
    return () => {
      gone = true;
      clearTimeout(timer);
    };
  }, []);
  useEffect(() => {
    if (typeof view === "object" && view.auth) shownAs.current = `${view.kind}:${view.name}`;
  }, [view]);
  if (view === "loading") return null;
  if (view === "waiting") return <Suspense fallback={null}><TailnetWaiting onRetry={() => askNow.current()} /></Suspense>;
  if (view === "sign-in") return <Suspense fallback={null}><SignIn onSignedIn={() => void afterSignIn(shownAs.current, setView)} /></Suspense>;
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
