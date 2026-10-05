import { AppRouter } from "./shell/app-router.js";
import { ThemeProvider } from "./components/app/theme.js";
import { Toaster } from "./components/ui/sonner.js";
import { createRoot } from "react-dom/client";
import { installClientLifecycle } from "./shell/client-lifecycle.js";

import "./styles.css";

installClientLifecycle();
if (window.suplexApp) document.documentElement.classList.add("suplex-desktop");
createRoot(document.getElementById("suplex-app")!).render(<ThemeProvider><AppRouter /><Toaster /></ThemeProvider>);
