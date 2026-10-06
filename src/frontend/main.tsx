import { AppRouter } from "./shell/app-router.js";
import { ThemeProvider } from "./components/app/theme.js";
import { Toaster } from "./components/ui/sonner.js";
import { createRoot } from "react-dom/client";
import { installClientLifecycle } from "./shell/client-lifecycle.js";
import { refreshWebPushSubscription } from "./features/profiles/lib/web-push-api.js";

import "./styles.css";

installClientLifecycle();
if (window.suplexApp) document.documentElement.classList.add("suplex-desktop");
// The phone app shows the host bar too, without the desktop title bar inset.
if (window.suplexMobile) document.documentElement.classList.add("suplex-mobile");
if (!window.suplexApp && "serviceWorker" in navigator) void navigator.serviceWorker.register("/sw.js").then(() => refreshWebPushSubscription()).catch(() => undefined);
// Only macOS draws window controls over the page. An older shell sends no platform and runs on a Mac.
if (window.suplexApp?.platform && window.suplexApp.platform !== "macos") document.documentElement.classList.add("suplex-native-titlebar");
createRoot(document.getElementById("suplex-app")!).render(<ThemeProvider><AppRouter /><Toaster /></ThemeProvider>);
