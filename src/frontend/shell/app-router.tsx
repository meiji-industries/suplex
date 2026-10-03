import { startTransition, useEffect, useState, type ReactElement } from "react";

import { CompanyProvider } from "./company-context.js";
import { SystemHealthProvider } from "../components/app/system-health.js";
import { UpdateProvider } from "../components/app/update-provider.js";
import { isApplicationPath, navigate, shouldNavigate } from "./navigation-state.js";
import { AuthView } from "../features/auth/auth.js";
import { AccountLoginView } from "../features/account/account-login.js";
import { OAuthConsentView } from "../features/auth/oauth-consent.js";
import { TasksView } from "../features/tasks/tasks.js";
import { ApplicationShell } from "./application-frame.js";
import { ServerStateProvider } from "./server-state.js";
import { TaskDataProvider } from "../features/tasks/task-data.js";
import { DesktopHostBar } from "./desktop-host-bar.js";
import { useExperiments } from "./experiments-api.js";
import { BrowserAnalytics } from "./browser-analytics-provider.js";

import { AdminView } from "../features/admin/admin.js";
import { CompanySettingsView } from "../features/settings/company-settings.js";
import { ProfileView } from "../features/profiles/profile.js";
import { Dashboard } from "../features/tasks/dashboard.js";
import { ProjectsView } from "../features/projects/projects.js";
import { ProjectDetails } from "../features/projects/project-details.js";
import { TimelineView } from "../features/timeline/timeline.js";
import { AnalyticsView } from "../features/analytics/analytics.js";
import { TaskTemplateSettings } from "../features/settings/task-template-settings.js";
import { ApiMcpSettingsView } from "../features/settings/api-mcp-settings.js";
import { ProviderSettingsView } from "../features/settings/provider-settings.js";
import { TerminalSettingsView } from "../features/settings/terminal-settings.js";
import { BackupSettingsView } from "../features/settings/backup-settings.js";
import { EnvironmentSettingsView } from "../features/settings/environment-settings.js";
import { WorkflowSettingsView } from "../features/settings/workflow-settings.js";
import { TriggerSettingsView } from "../features/settings/trigger-settings.js";
import { BillingSettingsView } from "../features/settings/billing-settings.js";
import { OnboardingSettingsView } from "../features/settings/onboarding-settings.js";
import { AccessView } from "../features/access/access.js";
import { OnboardingView } from "../features/onboarding/onboarding-wizard.js";
import { SetupView } from "../features/settings/setup.js";
import { MovesView } from "../features/moves/moves.js";
import { TodayView } from "../features/today/today.js";

export function activityShellKey(pathname: string): "activity" | undefined {
  if (pathname === "/today" || pathname === "/tasks" || pathname.startsWith("/tasks/") || pathname === "/board" || pathname.startsWith("/board/") || pathname === "/moves" || pathname.startsWith("/moves/") || pathname === "/timeline" || pathname === "/analytics") return "activity";
  return undefined;
}

/** Today is an experiment; when it is off, its links open the task list. */
function TodayRoute(): ReactElement | null {
  const experiments = useExperiments();
  useEffect(() => {
    if (!experiments || experiments.todayPage) return;
    window.history.replaceState({}, "", `/tasks${window.location.search}`);
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
  if (pathname === "/billing") return <BillingSettingsView />;
  if (/^\/projects\/[^/]+\/templates$/.test(pathname)) return <TaskTemplateSettings key={pathname} projectId={pathname.split("/")[2]!} />;
  if (/^\/projects\/[^/]+$/.test(pathname)) return <ProjectDetails projectId={pathname.split("/")[2]!} />;
  if (pathname === "/templates") return <TaskTemplateSettings />;
  if (pathname === "/today") return <TodayRoute />;
  if (pathname === "/tasks" || pathname.startsWith("/tasks/")) return <TasksView />;
  if (pathname === "/board" || pathname.startsWith("/board/")) return <TasksView mode="board" />;
  if (pathname === "/moves" || pathname.startsWith("/moves/")) return <MovesView />;
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
  if (import.meta.env.DEV && new URLSearchParams(window.location.search).get("preview") === "account-login") return <AccountLoginView preview />;
  if (window.__SUPLEX_VIEW__ === "auth") return <SystemHealthProvider initialSnapshot={window.__SUPLEX_HEALTH__}><AuthView /><DesktopHostBar /></SystemHealthProvider>;
  if (window.__SUPLEX_VIEW__ === "account-login") return <SystemHealthProvider initialSnapshot={window.__SUPLEX_HEALTH__}><AccountLoginView /><DesktopHostBar /></SystemHealthProvider>;
  if (window.__SUPLEX_VIEW__ === "oauth-consent") return <SystemHealthProvider initialSnapshot={window.__SUPLEX_HEALTH__}><OAuthConsentView /><DesktopHostBar /></SystemHealthProvider>;
  const shellKey = activityShellKey(window.location.pathname);
  const view = <AppView key={route} />;
  return <CompanyProvider><BrowserAnalytics /><ServerStateProvider><TaskDataProvider><UpdateProvider><SystemHealthProvider initialSnapshot={window.__SUPLEX_HEALTH__}>{shellKey ? <ApplicationShell key={shellKey}>{view}</ApplicationShell> : view}<DesktopHostBar /></SystemHealthProvider></UpdateProvider></TaskDataProvider></ServerStateProvider></CompanyProvider>;
}

export { isApplicationPath };
