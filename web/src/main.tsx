import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { SWRConfig } from "swr";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { StatusPage } from "./StatusPage";
import { statusRoute } from "./statusRoute";
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
import { installSignedOutWatch, logout, me, TailnetUnavailableError, type Me } from "./auth";
import { TailnetRetry, type RetryView } from "./tailnetRetry";
import { TailnetBanner, TailnetWaiting } from "./TailnetWait";
import { installPwa, resyncPush } from "./pwa";
import { hubUnreachable } from "./pwaState";
import { HubUnreachable, UpdateBanner } from "./PwaScreens";

installViewportTracking();
installPwa();

const SignIn = lazy(() => import("./SignIn").then((m) => ({ default: m.SignIn })));

/**
 * "waiting": the first `me` answered the hub's tailnet 503 (a Tailscale session while tailscaled does not answer).
 * "offline": no answer from the hub at all (PwaScreens).
 */
type View = "loading" | "sign-in" | "waiting" | "offline" | Me;

// Installed before the first request, so a session that ends while the app is open shows the sign-in screen.
// Only the gate's signed-out header counts; an archive's password 401 still reaches its prompt. The gate's tailnet
// 503 (its own header) starts the "trying again" banner while the app is open.
let show: (v: View) => void = () => {};
let tailnetDown: () => void = () => {};
let signedOut = false;
installSignedOutWatch(
  () => {
    signedOut = true;
    show("sign-in");
  },
  () => tailnetDown(),
);

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

/**
 * The app when sign-in is off or done, else the sign-in screen. While a Tailscale session's tailscaled does not answer
 * (the hub's tailnet 503, which keeps the session), `me` is asked again with a growing wait (tailnetRetry.ts): before the
 * app was shown on a waiting screen, after it in a banner over the app, which stays mounted. Both offer Sign out.
 */
function Root() {
  const [view, setView] = useState<View>("loading");
  /** the retry loop's state while it runs, else null */
  const [retry, setRetry] = useState<RetryView | null>(null);
  /** the account the app was last shown for, as kind:name */
  const shownAs = useRef<string | undefined>(undefined);
  const current = useRef<View>(view);
  current.current = view;
  const [loop] = useState(
    () =>
      new TailnetRetry({
        onView: setRetry,
        onResult: (m) => {
          setRetry(null);
          setView((v) => (v === "sign-in" ? v : m === "signed-out" ? "sign-in" : m));
        },
      }),
  );
  /** Asks the hub who is signed in; `gone` says the caller no longer wants the answer. */
  const ask = (gone: () => boolean = () => false) =>
    me()
      .then((m) => !gone() && setView((v) => (v === "sign-in" ? v : m === "signed-out" ? "sign-in" : m)))
      .catch((e: unknown) => {
        if (gone()) return;
        if (e instanceof TailnetUnavailableError) {
          setView((v) => (v === "sign-in" ? v : "waiting"));
          loop.start();
          return;
        }
        // No answer from the hub (offline, or a gateway saying it is down): say so and keep trying (PwaScreens). An older
        // hub or another failed request: show the app as before; its own requests report what is wrong.
        setView((v) => (v === "sign-in" ? v : hubUnreachable(e) ? "offline" : { auth: false }));
      });
  useEffect(() => {
    show = (v) => {
      if (v === "sign-in") {
        loop.stop();
        setRetry(null);
      }
      setView(v);
    };
    // only while the app is open: the sign-in screen's own Tailscale calls report a 503 themselves
    tailnetDown = () => {
      const v = current.current;
      if (typeof v === "object" && v.auth) loop.start();
    };
    if (signedOut) return setView("sign-in");
    let gone = false;
    void ask(() => gone);
    return () => {
      gone = true;
      loop.stop();
    };
  }, [loop]);
  useEffect(() => {
    if (typeof view === "object" && view.auth) shownAs.current = `${view.kind}:${view.name}`;
    // the app is shown (sign-in off, or signed in): the hub gets this browser's push subscription for this session
    if (typeof view === "object") void resyncPush();
  }, [view]);
  /** The way to the password form while tailscaled stays down: ends the session on the hub, then the sign-in screen. */
  const signOut = async () => {
    loop.stop();
    await logout().catch(() => {});
    setRetry(null);
    signedOut = true;
    setView("sign-in");
  };
  const waitProps = { view: retry ?? { trying: false, failures: 0 }, onRetry: () => loop.tryNow(), onSignOut: () => void signOut() };
  if (view === "loading") return null;
  if (view === "waiting") return <><TailnetWaiting {...waitProps} /><UpdateBanner /></>;
  if (view === "offline") return <><HubUnreachable retry={() => ask().then(() => {})} /><UpdateBanner /></>;
  // the sign-in chunk loads on demand; a page of an older build may no longer find it, so a failure shows the error screen (with reload), never a blank page
  if (view === "sign-in") return <><ErrorBoundary what="Sign-in" scope="root"><Suspense fallback={null}><SignIn onSignedIn={() => void afterSignIn(shownAs.current, setView)} /></Suspense></ErrorBoundary><UpdateBanner /></>;
  const status = statusRoute(location.pathname, location.search);
  return (
    <>
      <UpdateBanner />
      <AccessibilityChrome statusPage={!!status} />
      <ErrorBoundary what="Filedeck" scope="root">
        {status ? <StatusPage initial={status} account={view.auth ? view : undefined} /> : <App account={view.auth ? view : undefined} />}
      </ErrorBoundary>
      {retry && <TailnetBanner {...waitProps} />}
    </>
  );
}

createRoot(document.getElementById("root") as HTMLElement).render(<SWRConfig value={swrConfig}>
  <Root />
</SWRConfig>);
