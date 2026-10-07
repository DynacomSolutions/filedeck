import { SWRConfig } from "swr";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { swrConfig } from "./data";
import "./styles.css";
import "./accessibility.css";
import "./sidebar.css";
import { AccessibilityChrome } from "./AccessibilityChrome";

createRoot(document.getElementById("root") as HTMLElement).render(<SWRConfig value={swrConfig}>
  <AccessibilityChrome />
  <App />
</SWRConfig>);
