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
import { PromptSettings } from "../../views/prompt-settings.js";

function AppView(): ReactElement {
  const pathname = window.location.pathname;
  if (pathname === "/admin" || pathname === "/admin/profiles" || pathname === "/admin/agents" || pathname === "/admin/models" || pathname === "/admin/companies" || pathname === "/admin/invitations" || pathname === "/admin/passkeys" || pathname === "/admin/prompts") return <AdminView />;
  if (/^\/companies\/[^/]+\/settings$/.test(pathname)) return <CompanySettingsView />;
  if (pathname === "/profile") return <ProfileView />;
  if (pathname === "/projects") return <ProjectsView />;
  if (/^\/projects\/[^/]+\/prompts$/.test(pathname)) return <PromptSettings scope="project" projectId={pathname.split("/")[2]!} />;
  if (pathname === "/tasks" || pathname.startsWith("/tasks/")) return <TasksView />;
  if (pathname === "/board" || pathname.startsWith("/board/")) return <TasksView mode="board" />;
  if (pathname === "/timeline") return <TimelineView />;
  if (pathname === "/attention") return <AttentionView />;
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
