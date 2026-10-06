import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";
import "./accessibility.css";
import { AccessibilityChrome } from "./AccessibilityChrome";

createRoot(document.getElementById("root") as HTMLElement).render(<>
  <AccessibilityChrome />
  <App />
</>);
