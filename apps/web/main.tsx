import { AppRouter } from "./shell/app-router.js";
import { ThemeProvider } from "./components/app/theme.js";
import { Toaster } from "./components/ui/sonner.js";
import { ArchiveReviewDialog } from "./features/tasks/archive-task-dialog.js";
import { createRoot } from "react-dom/client";
import { captureReactError } from "./shell/browser-analytics.js";
import { installClientLifecycle } from "./shell/client-lifecycle.js";
import { installDesktopZoom } from "./shell/desktop-zoom.js";
import { refreshWebPushSubscription } from "./features/profiles/lib/web-push-api.js";

import "./styles.css";

installClientLifecycle();
if (window.suplexApp) document.documentElement.classList.add("suplex-desktop");
installDesktopZoom();
// The phone app shows the host bar too, without the desktop title bar inset.
if (window.suplexMobile) document.documentElement.classList.add("suplex-mobile");
if (!window.suplexApp && "serviceWorker" in navigator) void navigator.serviceWorker.register("/sw.js").then(() => refreshWebPushSubscription()).catch(() => undefined);
// Only macOS draws window controls over the page. An older shell sends no platform and runs on a Mac.
if (window.suplexApp?.platform && window.suplexApp.platform !== "macos") document.documentElement.classList.add("suplex-native-titlebar");
// The handlers report the error, then do what React does without them. `reportError` raises `window.onerror`, which skips an error already reported.
createRoot(document.getElementById("suplex-app")!, {
  onUncaughtError: (error) => { captureReactError("uncaught", error); reportError(error); },
  onCaughtError: (error) => { captureReactError("caught", error); console.error(error); },
  onRecoverableError: (error) => { captureReactError("recoverable", error); reportError(error); },
}).render(<ThemeProvider><AppRouter /><ArchiveReviewDialog /><Toaster /></ThemeProvider>);
