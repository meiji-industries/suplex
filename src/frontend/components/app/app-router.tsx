import { useEffect, useState, type ReactElement } from "react";

import { CompanyProvider } from "./company-context.js";
import { SystemHealthProvider } from "./system-health.js";
import { isApplicationPath, navigate, shouldNavigate } from "../../lib/navigation.js";
import { AuthView } from "../../views/auth.js";
import { AdminView } from "../../views/admin.js";
import { AttentionView } from "../../views/attention.js";
import { CompanySettingsView } from "../../views/company-settings.js";
import { ProfileView } from "../../views/profile.js";
import { Dashboard } from "../../views/dashboard.js";
import { ProjectsView } from "../../views/projects.js";
import { TasksView } from "../../views/tasks.js";
import { TimelineView } from "../../views/timeline.js";
import { TaskTemplateSettings } from "../../views/task-template-settings.js";
import { ProviderSettingsView } from "../../views/provider-settings.js";
import { EnvironmentSettingsView } from "../../views/environment-settings.js";

function AppView(): ReactElement {
  const pathname = window.location.pathname;
  if (pathname === "/admin/profiles") {
    window.history.replaceState({}, "", "/admin/agents");
    return <AdminView />;
  }
  if (pathname === "/admin/providers") return <ProviderSettingsView />;
  if (pathname === "/admin/environment") return <EnvironmentSettingsView />;
  if (pathname === "/admin" || pathname === "/admin/agents" || pathname === "/admin/models" || pathname === "/admin/companies" || pathname === "/admin/invitations" || pathname === "/admin/passkeys") return <AdminView />;
  if (/^\/companies\/[^/]+\/settings$/.test(pathname)) return <CompanySettingsView />;
  if (pathname === "/profile") return <ProfileView />;
  if (pathname === "/projects") return <ProjectsView />;
  if (/^\/projects\/[^/]+\/templates$/.test(pathname)) return <TaskTemplateSettings key={pathname} projectId={pathname.split("/")[2]!} />;
  if (pathname === "/templates") return <TaskTemplateSettings />;
  if (pathname === "/tasks" || pathname.startsWith("/tasks/")) return <TasksView />;
  if (pathname === "/board" || pathname.startsWith("/board/")) return <TasksView mode="board" />;
  if (pathname === "/attention") return <AttentionView />;
  if (pathname === "/timeline") return <TimelineView />;
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
  return <CompanyProvider><SystemHealthProvider initialSnapshot={window.__FORGE_HEALTH__}><AppView key={route} /></SystemHealthProvider></CompanyProvider>;
}

export { isApplicationPath };
