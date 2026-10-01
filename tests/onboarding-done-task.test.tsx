// @vitest-environment happy-dom
import { act, StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import type { ReactNode } from "react";
import { afterEach, expect, test, vi } from "vitest";
import type * as NavigationState from "../src/frontend/shell/navigation-state.js";

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
vi.mock("../src/frontend/components/app/entity-avatar.js", () => ({ AvatarEditor: ({ name, seed }: { name: string; seed?: string }) => <output data-avatar-name={name} data-avatar-seed={seed} /> }));
vi.mock("../src/frontend/components/app/update-notice.js", () => ({ UpdateNotice: () => null }));
vi.mock("../src/frontend/components/app/theme.js", () => ({ ThemeToggle: () => null }));
vi.mock("../src/frontend/shell/navigation-state.js", async importOriginal => {
  const original = await importOriginal<typeof NavigationState>();
  return { ...original, navigate: vi.fn(original.navigate) };
});
vi.mock("../src/frontend/features/tasks/new-task-dialog.js", () => ({ NewTaskDialog: ({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) => open ? <div role="dialog">New task opened<button onClick={() => onOpenChange(false)}>Close</button></div> : null }));

import { OnboardingView } from "../src/frontend/features/onboarding/onboarding-wizard.js";
import { navigate } from "../src/frontend/shell/navigation-state.js";

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

function setInput(input: HTMLInputElement, value: string): void {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

afterEach(() => {
  fixture.currentCompany = undefined;
  fixture.loading = false;
  document.body.replaceChildren();
  window.history.replaceState({}, "", "/");
  vi.mocked(navigate).mockClear();
});

test("final Continue shows Done without a New task dialog", async () => {
  fixture.currentCompany = company;
  window.history.replaceState({}, "", "/onboarding?step=projects");
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(<StrictMode><RoutedOnboarding /></StrictMode>));
  await act(async () => button(container, "Continue").click());
  expect(window.location.search).toContain("step=done");
  expect(container.textContent).toContain("You are all set!");
  expect(container.querySelectorAll('[role="dialog"]')).toHaveLength(0);
  await act(async () => root.unmount());
});

test("direct Done does not open the dialog, and the CTA requests it on Today", async () => {
  window.history.replaceState({}, "", "/onboarding?step=done");
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(<StrictMode><MountedOnboarding revision={0} /></StrictMode>));
  fixture.currentCompany = company;
  await act(async () => root.render(<StrictMode><MountedOnboarding revision={1} /></StrictMode>));
  expect(container.querySelectorAll('[role="dialog"]')).toHaveLength(0);

  await act(async () => button(container, "Create your first task").click());
  expect(navigate).toHaveBeenLastCalledWith("/today?new-task=1");
  expect(`${window.location.pathname}${window.location.search}`).toBe("/today?new-task=1");
  expect(container.querySelectorAll('[role="dialog"]')).toHaveLength(0);
  await act(async () => root.unmount());
});

test("company avatar uses the trimmed name draft and falls back to the saved name", async () => {
  fixture.currentCompany = { ...company, name: "My Company" };
  window.history.replaceState({}, "", "/onboarding?step=company");
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(<OnboardingView />));
  const avatar = container.querySelector<HTMLOutputElement>("output[data-avatar-seed]")!;
  const input = container.querySelector<HTMLInputElement>("#onboarding-name")!;

  expect(avatar.dataset.avatarSeed).toBe("My Company");
  await act(async () => setInput(input, "  ACME Agency  "));
  expect(avatar.dataset.avatarName).toBe("ACME Agency");
  expect(avatar.dataset.avatarSeed).toBe("ACME Agency");
  await act(async () => setInput(input, "   "));
  expect(avatar.dataset.avatarSeed).toBe("My Company");
  await act(async () => root.unmount());
});
