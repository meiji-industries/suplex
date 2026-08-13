import { CompanyProvider } from "./components/app/company-context.js";
import { SystemHealthProvider } from "./components/app/system-health.js";
import { AuthView } from "./views/auth.js";
import { AdminView } from "./views/admin.js";
import { AttentionView } from "./views/attention.js";
import { CompanySettingsView } from "./views/company-settings.js";
import { Dashboard } from "./views/dashboard.js";
import { ProjectsView } from "./views/projects.js";
import { TasksView } from "./views/tasks.js";
import { TimelineView } from "./views/timeline.js";
import { createRoot } from "react-dom/client";

import "./styles.css";

const view = window.__FORGE_VIEW__;
const authenticatedView = view === "admin" ? <AdminView /> : view === "projects" ? <ProjectsView /> : view === "tasks" ? <TasksView /> : view === "board" ? <TasksView mode="board" /> : view === "timeline" ? <TimelineView /> : view === "attention" ? <AttentionView /> : view === "company-settings" ? <CompanySettingsView /> : <Dashboard />;
createRoot(document.getElementById("forge-app")!).render(view === "auth" ? <AuthView /> : <CompanyProvider><SystemHealthProvider initialSnapshot={window.__FORGE_HEALTH__}>{authenticatedView}</SystemHealthProvider></CompanyProvider>);
