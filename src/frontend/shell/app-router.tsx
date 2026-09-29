import { lazy, startTransition, Suspense, useEffect, useState, type ReactElement } from "react";

import { CompanyProvider } from "./company-context.js";
import { SystemHealthProvider } from "../components/app/system-health.js";
import { UpdateProvider } from "../components/app/update-provider.js";
import { isApplicationPath, navigate, shouldNavigate } from "./navigation-state.js";
import { AuthView } from "../features/auth/auth.js";
import { OAuthConsentView } from "../features/auth/oauth-consent.js";
import { TasksView } from "../features/tasks/tasks.js";
import { ApplicationShell } from "./application-frame.js";
import { ServerStateProvider } from "./server-state.js";
import { TaskDataProvider } from "../features/tasks/task-data.js";
import { LoadingState } from "../components/app/loading-state.js";
import { DesktopHostBar } from "./desktop-host-bar.js";
import { useExperiments } from "./experiments-api.js";

const AdminView = lazy(() => import("../features/admin/admin.js").then(module => ({ default: module.AdminView })));
const CompanySettingsView = lazy(() => import("../features/settings/company-settings.js").then(module => ({ default: module.CompanySettingsView })));
const ProfileView = lazy(() => import("../features/profiles/profile.js").then(module => ({ default: module.ProfileView })));
const Dashboard = lazy(() => import("../features/tasks/dashboard.js").then(module => ({ default: module.Dashboard })));
const ProjectsView = lazy(() => import("../features/projects/projects.js").then(module => ({ default: module.ProjectsView })));
const ProjectDetails = lazy(() => import("../features/projects/project-details.js").then(module => ({ default: module.ProjectDetails })));
const TimelineView = lazy(() => import("../features/timeline/timeline.js").then(module => ({ default: module.TimelineView })));
const AnalyticsView = lazy(() => import("../features/analytics/analytics.js").then(module => ({ default: module.AnalyticsView })));
const TaskTemplateSettings = lazy(() => import("../features/settings/task-template-settings.js").then(module => ({ default: module.TaskTemplateSettings })));
const ApiMcpSettingsView = lazy(() => import("../features/settings/api-mcp-settings.js").then(module => ({ default: module.ApiMcpSettingsView })));
const ProviderSettingsView = lazy(() => import("../features/settings/provider-settings.js").then(module => ({ default: module.ProviderSettingsView })));
const TerminalSettingsView = lazy(() => import("../features/settings/terminal-settings.js").then(module => ({ default: module.TerminalSettingsView })));
const BackupSettingsView = lazy(() => import("../features/settings/backup-settings.js").then(module => ({ default: module.BackupSettingsView })));
const EnvironmentSettingsView = lazy(() => import("../features/settings/environment-settings.js").then(module => ({ default: module.EnvironmentSettingsView })));
const WorkflowSettingsView = lazy(() => import("../features/settings/workflow-settings.js").then(module => ({ default: module.WorkflowSettingsView })));
const TriggerSettingsView = lazy(() => import("../features/settings/trigger-settings.js").then(module => ({ default: module.TriggerSettingsView })));
const OnboardingSettingsView = lazy(() => import("../features/settings/onboarding-settings.js").then(module => ({ default: module.OnboardingSettingsView })));
const AccessView = lazy(() => import("../features/access/access.js").then(module => ({ default: module.AccessView })));
const OnboardingView = lazy(() => import("../features/onboarding/onboarding-wizard.js").then(module => ({ default: module.OnboardingView })));
const SetupView = lazy(() => import("../features/settings/setup.js").then(module => ({ default: module.SetupView })));
const TodayView = lazy(() => import("../features/today/today.js").then(module => ({ default: module.TodayView })));

export function activityShellKey(pathname: string): "activity" | undefined {
  if (pathname === "/today" || pathname === "/tasks" || pathname.startsWith("/tasks/") || pathname === "/board" || pathname.startsWith("/board/") || pathname === "/timeline" || pathname === "/analytics") return "activity";
  return undefined;
}

/** Today is an experiment; when it is off, its links open the task list. */
function TodayRoute(): ReactElement | null {
  const experiments = useExperiments();
  useEffect(() => {
    if (!experiments || experiments.todayPage) return;
    window.history.replaceState({}, "", "/tasks");
    window.dispatchEvent(new Event("suplex:navigate"));
  }, [experiments]);
  return experiments?.todayPage ? <TodayView /> : null;
}

function AppView(): ReactElement {
  const pathname = window.location.pathname;
  if (pathname === "/setup") return <SetupView />;
  if (pathname === "/onboarding") return <OnboardingView />;
  if (pathname === "/admin/profiles") {
    window.history.replaceState({}, "", "/admin/agents");
    return <AdminView />;
  }
  if (pathname === "/admin/onboarding") return <OnboardingSettingsView />;
  if (pathname === "/admin/api-mcp") return <ApiMcpSettingsView />;
  if (pathname === "/admin/providers") return <ProviderSettingsView />;
  if (pathname === "/admin/terminal") return <TerminalSettingsView />;
  if (pathname === "/admin/environment") return <EnvironmentSettingsView />;
  if (pathname === "/admin/backups") return <BackupSettingsView />;
  if (pathname === "/admin/workflows") return <WorkflowSettingsView />;
  if (pathname === "/admin/triggers") return <TriggerSettingsView />;
  if (pathname === "/admin/passkeys") window.history.replaceState({}, "", `/admin/access${window.location.search}`);
  if (pathname === "/admin/access" || pathname === "/admin/passkeys") return <AccessView />;
  if (pathname === "/admin" || pathname === "/admin/agents" || pathname === "/admin/companies" || pathname === "/admin/invitations") return <AdminView />;
  if (/^\/companies\/[^/]+\/settings$/.test(pathname)) return <CompanySettingsView />;
  if (pathname === "/profile") return <ProfileView />;
  if (pathname === "/projects") return <ProjectsView />;
  if (/^\/projects\/[^/]+\/templates$/.test(pathname)) return <TaskTemplateSettings key={pathname} projectId={pathname.split("/")[2]!} />;
  if (/^\/projects\/[^/]+$/.test(pathname)) return <ProjectDetails projectId={pathname.split("/")[2]!} />;
  if (pathname === "/templates") return <TaskTemplateSettings />;
  if (pathname === "/today") return <TodayRoute />;
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
    const updateRoute = (): void => startTransition(() => setRoute(locationKey()));
    const intercept = (event: MouseEvent): void => {
      const anchor = (event.target as Element | null)?.closest("a");
      if (!anchor || !shouldNavigate(event, anchor)) return;
      event.preventDefault();
      navigate(anchor.href);
    };
    window.addEventListener("popstate", updateRoute);
    window.addEventListener("suplex:navigate", updateRoute);
    document.addEventListener("click", intercept);
    return () => {
      window.removeEventListener("popstate", updateRoute);
      window.removeEventListener("suplex:navigate", updateRoute);
      document.removeEventListener("click", intercept);
    };
  }, []);
  if (window.__SUPLEX_VIEW__ === "auth") return <SystemHealthProvider initialSnapshot={window.__SUPLEX_HEALTH__}><AuthView /><DesktopHostBar /></SystemHealthProvider>;
  if (window.__SUPLEX_VIEW__ === "oauth-consent") return <SystemHealthProvider initialSnapshot={window.__SUPLEX_HEALTH__}><OAuthConsentView /><DesktopHostBar /></SystemHealthProvider>;
  const shellKey = activityShellKey(window.location.pathname);
  const view = <Suspense fallback={<LoadingState />}><AppView key={route} /></Suspense>;
  return <CompanyProvider><ServerStateProvider><TaskDataProvider><UpdateProvider><SystemHealthProvider initialSnapshot={window.__SUPLEX_HEALTH__}>{shellKey ? <ApplicationShell key={shellKey}>{view}</ApplicationShell> : view}<DesktopHostBar /></SystemHealthProvider></UpdateProvider></TaskDataProvider></ServerStateProvider></CompanyProvider>;
}

export { isApplicationPath };
