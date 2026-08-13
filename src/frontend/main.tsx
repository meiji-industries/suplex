import { AppRouter } from "./components/app/app-router.js";
import { createRoot } from "react-dom/client";

import "./styles.css";

createRoot(document.getElementById("forge-app")!).render(<AppRouter />);
