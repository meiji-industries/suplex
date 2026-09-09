import { useEffect, useState, type ReactElement } from "react";

import { CompanyProvider } from "./company-context.js";
import { SystemHealthProvider } from "../components/app/system-health.js";
import { UpdateProvider } from "../components/app/update-provider.js";
import { isApplicationPath, navigate, shouldNavigate } from "./navigation-state.js";
import { AuthView } from "../features/auth/auth.js";
import { AdminView } from "../features/admin/admin.js";
import { CompanySettingsView } from "../features/settings/company-settings.js";
import { ProfileView } from "../features/profiles/profile.js";
import { Dashboard } from "../features/tasks/dashboard.js";
import { ProjectsView } from "../features/projects/projects.js";
import { TasksView } from "../features/tasks/tasks.js";
import { TimelineView } from "../features/timeline/timeline.js";
import { AnalyticsView } from "../features/analytics/analytics.js";
import { TaskTemplateSettings } from "../features/settings/task-template-settings.js";
import { ProviderSettingsView } from "../features/settings/provider-settings.js";
import { EnvironmentSettingsView } from "../features/settings/environment-settings.js";
import { WorkflowSettingsView } from "../features/settings/workflow-settings.js";
import { TriggerSettingsView } from "../features/settings/trigger-settings.js";

function AppView(): ReactElement {
  const pathname = window.location.pathname;
  if (pathname === "/admin/profiles") {
    window.history.replaceState({}, "", "/admin/agents");
    return <AdminView />;
  }
  if (pathname === "/admin/providers") return <ProviderSettingsView />;
  if (pathname === "/admin/environment") return <EnvironmentSettingsView />;
  if (pathname === "/admin/workflows") return <WorkflowSettingsView />;
  if (pathname === "/admin/triggers") return <TriggerSettingsView />;
  if (pathname === "/admin" || pathname === "/admin/agents" || pathname === "/admin/models" || pathname === "/admin/companies" || pathname === "/admin/invitations" || pathname === "/admin/passkeys") return <AdminView />;
  if (/^\/companies\/[^/]+\/settings$/.test(pathname)) return <CompanySettingsView />;
  if (pathname === "/profile") return <ProfileView />;
  if (pathname === "/projects") return <ProjectsView />;
  if (/^\/projects\/[^/]+\/templates$/.test(pathname)) return <TaskTemplateSettings key={pathname} projectId={pathname.split("/")[2]!} />;
  if (pathname === "/templates") return <TaskTemplateSettings />;
  if (pathname === "/tasks" || pathname.startsWith("/tasks/")) return <TasksView />;
  if (pathname === "/board" || pathname.startsWith("/board/")) return <TasksView mode="board" />;
  if (pathname === "/timeline") return <TimelineView />;
  if (pathname === "/analytics") return <AnalyticsView />;
  return <Dashboard />;
}

function locationKey(): string {
  return `${window.location.pathname}${window.location.search}${window.location.hash}`;
}

export function AppRouter(): ReactElement {
  const [route, setRoute] = useState(locationKey);
  useEffect(() => {
    const updateRoute = (): void => setRoute(locationKey());
    const intercept = (event: MouseEvent): void => {
      const anchor = (event.target as Element | null)?.closest("a");
      if (!anchor || !shouldNavigate(event, anchor)) return;
      event.preventDefault();
      navigate(anchor.href);
    };
    window.addEventListener("popstate", updateRoute);
    window.addEventListener("forge:navigate", updateRoute);
    document.addEventListener("click", intercept);
    return () => {
      window.removeEventListener("popstate", updateRoute);
      window.removeEventListener("forge:navigate", updateRoute);
      document.removeEventListener("click", intercept);
    };
  }, []);
  if (window.__FORGE_VIEW__ === "auth") return <AuthView />;
  return <CompanyProvider><UpdateProvider><SystemHealthProvider initialSnapshot={window.__FORGE_HEALTH__}><AppView key={route} /></SystemHealthProvider></UpdateProvider></CompanyProvider>;
}

export { isApplicationPath };
