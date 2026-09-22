import { AppRouter } from "./shell/app-router.js";
import { ThemeProvider } from "./components/app/theme.js";
import { createRoot } from "react-dom/client";
import { installClientLifecycle } from "./shell/client-lifecycle.js";

import "./styles.css";

installClientLifecycle();
createRoot(document.getElementById("forge-app")!).render(<ThemeProvider><AppRouter /></ThemeProvider>);
