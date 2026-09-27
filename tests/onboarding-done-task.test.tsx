// @vitest-environment happy-dom
import { act, StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import type { ReactNode } from "react";
import { afterEach, expect, test, vi } from "vitest";

const company = { id: "company-1", name: "Acme", issueCode: "ACME", status: "active" };
const fixture = vi.hoisted(() => ({ currentCompany: undefined as typeof company | undefined, loading: false }));
vi.mock("../src/frontend/shell/company-context.js", () => ({ useCompanyContext: () => ({ currentCompany: fixture.currentCompany, user: { role: "admin" }, reloadCompanies: vi.fn(), renameCompany: vi.fn(), setCompanyIssueCode: vi.fn() }), useOptionalCompanyContext: () => fixture.currentCompany ? { currentCompany: fixture.currentCompany } : undefined }));
vi.mock("../src/frontend/features/onboarding/onboarding.js", async importOriginal => ({ ...(await importOriginal()), useOnboardingData: () => ({ state: { company: fixture.currentCompany, checks: [], providers: [], profiles: [], projects: [{ id: "project-1" }] }, loading: fixture.loading, error: "", reload: vi.fn() }) }));
vi.mock("../src/frontend/components/app/system-health.js", () => ({ useSystemHealth: () => ({ refresh: vi.fn(), freshness: "fresh", refreshing: false }), CheckStatusIndicator: () => null, SystemHealthAlert: () => null, healthCheckPurpose: () => "" }));
vi.mock("../src/frontend/shell/company-switcher.js", () => ({ CompanySwitcher: () => null }));
vi.mock("../src/frontend/components/ui/sidebar.js", () => ({ Sidebar: ({ children }: { children: ReactNode }) => <>{children}</>, SidebarContent: ({ children }: { children: ReactNode }) => <>{children}</>, SidebarFooter: ({ children }: { children: ReactNode }) => <>{children}</>, SidebarHeader: ({ children }: { children: ReactNode }) => <>{children}</>, SidebarInset: ({ children }: { children: ReactNode }) => <>{children}</>, SidebarMenu: ({ children }: { children: ReactNode }) => <>{children}</>, SidebarMenuButton: ({ children }: { children: ReactNode }) => <>{children}</>, SidebarMenuItem: ({ children }: { children: ReactNode }) => <>{children}</>, SidebarProvider: ({ children }: { children: ReactNode }) => <>{children}</>, SidebarTrigger: () => null, useSidebar: () => ({ setOpenMobile: vi.fn() }) }));
vi.mock("../src/frontend/features/settings/provider-login.js", () => ({ ProviderLoginTerminal: () => null, useProviderLogin: () => ({ login: null, loginPending: null, startLogin: vi.fn(), closeLogin: vi.fn() }) }));
vi.mock("../src/frontend/features/projects/project-cards.js", () => ({ ProjectCards: () => null }));
vi.mock("../src/frontend/features/projects/recent-repositories.js", () => ({ RecentRepositories: () => null }));
vi.mock("../src/frontend/features/projects/create-project-dialog.js", () => ({ CreateProjectDialog: () => null }));
vi.mock("../src/frontend/components/app/update-notice.js", () => ({ UpdateNotice: () => null }));
vi.mock("../src/frontend/components/app/theme.js", () => ({ ThemeToggle: () => null }));
vi.mock("../src/frontend/features/tasks/new-task-dialog.js", () => ({ NewTaskDialog: ({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) => open ? <div role="dialog">New task opened<button onClick={() => onOpenChange(false)}>Close</button></div> : null }));

import { OnboardingView } from "../src/frontend/features/onboarding/onboarding-wizard.js";

function RoutedOnboarding(): ReactNode {
  const [route, setRoute] = useState(() => `${window.location.pathname}${window.location.search}${window.location.hash}`);
  useEffect(() => {
    const updateRoute = (): void => setRoute(`${window.location.pathname}${window.location.search}${window.location.hash}`);
    window.addEventListener("suplex:navigate", updateRoute);
    return () => window.removeEventListener("suplex:navigate", updateRoute);
  }, []);
  return <OnboardingView key={route} />;
}

function MountedOnboarding({ revision }: { revision: number }): ReactNode {
  return <div data-revision={revision}><OnboardingView /></div>;
}

function button(container: HTMLElement, label: string): HTMLButtonElement {
  const match = Array.from(container.querySelectorAll("button")).find(candidate => candidate.textContent === label);
  expect(match, `${label} button`).toBeDefined();
  return match!;
}

afterEach(() => {
  fixture.currentCompany = undefined;
  fixture.loading = false;
  document.body.replaceChildren();
  window.history.replaceState({}, "", "/");
});

test("final Continue remounts the nested frame and opens one New task dialog", async () => {
  fixture.currentCompany = company;
  window.history.replaceState({}, "", "/onboarding?step=projects");
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(<StrictMode><RoutedOnboarding /></StrictMode>));
  expect(container.querySelectorAll('[role="dialog"]')).toHaveLength(0);
  await act(async () => button(container, "Continue").click());
  expect(window.location.search).toContain("step=done");
  expect(container.querySelectorAll('[role="dialog"]')).toHaveLength(1);
  await act(async () => root.unmount());
});

test("direct Done waits for the company, stays dismissed across refreshes, and the CTA reopens it", async () => {
  window.history.replaceState({}, "", "/onboarding?step=done");
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(<StrictMode><MountedOnboarding revision={0} /></StrictMode>));
  expect(container.querySelectorAll('[role="dialog"]')).toHaveLength(0);

  fixture.currentCompany = company;
  await act(async () => root.render(<StrictMode><MountedOnboarding revision={1} /></StrictMode>));
  expect(container.querySelectorAll('[role="dialog"]')).toHaveLength(1);

  await act(async () => button(container, "Close").click());
  fixture.loading = true;
  await act(async () => root.render(<StrictMode><MountedOnboarding revision={2} /></StrictMode>));
  expect(container.querySelectorAll('[role="dialog"]')).toHaveLength(0);

  await act(async () => button(container, "Create your first task").click());
  expect(container.querySelectorAll('[role="dialog"]')).toHaveLength(1);
  await act(async () => root.unmount());
});
