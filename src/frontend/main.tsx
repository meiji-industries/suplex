import { AppRouter } from "./shell/app-router.js";
import { ThemeProvider } from "./components/app/theme.js";
import { createRoot } from "react-dom/client";

import "./styles.css";

createRoot(document.getElementById("forge-app")!).render(<ThemeProvider><AppRouter /></ThemeProvider>);
