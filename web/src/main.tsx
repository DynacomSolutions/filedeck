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

installViewportTracking();

createRoot(document.getElementById("root") as HTMLElement).render(<SWRConfig value={swrConfig}>
  <AccessibilityChrome />
  <ErrorBoundary what="Filedeck" scope="root">
    <App />
  </ErrorBoundary>
</SWRConfig>);
