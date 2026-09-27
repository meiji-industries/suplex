// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { ReactNode } from "react";
import { afterEach, expect, test, vi } from "vitest";

const company = { id: "company-1", name: "Acme", issueCode: "ACME", status: "active" };
vi.mock("../src/frontend/shell/company-context.js", () => ({ useCompanyContext: () => ({ currentCompany: company, user: { role: "admin" }, reloadCompanies: vi.fn(), renameCompany: vi.fn(), setCompanyIssueCode: vi.fn() }), useOptionalCompanyContext: () => ({ currentCompany: company }) }));
vi.mock("../src/frontend/features/onboarding/onboarding.js", async importOriginal => ({ ...(await importOriginal()), useOnboardingData: () => ({ state: { company, checks: [], providers: [], profiles: [], projects: [] }, loading: false, error: "", reload: vi.fn() }) }));
vi.mock("../src/frontend/components/app/system-health.js", () => ({ useSystemHealth: () => ({ refresh: vi.fn(), freshness: "fresh", refreshing: false }), CheckStatusIndicator: () => null, healthCheckPurpose: () => "" }));
vi.mock("../src/frontend/shell/application-frame.js", () => ({ ApplicationFrame: ({ children }: { children: ReactNode }) => <>{children}</> }));
vi.mock("../src/frontend/shell/company-switcher.js", () => ({ CompanySwitcher: () => null }));
vi.mock("../src/frontend/components/ui/sidebar.js", () => ({ Sidebar: ({ children }: { children: ReactNode }) => <>{children}</>, SidebarContent: ({ children }: { children: ReactNode }) => <>{children}</>, SidebarFooter: ({ children }: { children: ReactNode }) => <>{children}</>, SidebarHeader: ({ children }: { children: ReactNode }) => <>{children}</>, SidebarMenu: ({ children }: { children: ReactNode }) => <>{children}</>, SidebarMenuButton: ({ children }: { children: ReactNode }) => <>{children}</>, SidebarMenuItem: ({ children }: { children: ReactNode }) => <>{children}</>, SidebarTrigger: () => null, useSidebar: () => ({ setOpenMobile: vi.fn() }) }));
vi.mock("../src/frontend/features/settings/provider-login.js", () => ({ ProviderLoginTerminal: () => null, useProviderLogin: () => ({ login: null, loginPending: null, startLogin: vi.fn(), closeLogin: vi.fn() }) }));
vi.mock("../src/frontend/features/tasks/new-task-dialog.js", () => ({ NewTaskDialog: ({ open }: { open: boolean }) => open ? <div role="dialog">New task opened</div> : null }));

import { OnboardingView } from "../src/frontend/features/onboarding/onboarding-wizard.js";
import { GlobalNewTaskDialog } from "../src/frontend/shell/global-new-task-dialog.js";

afterEach(() => { document.body.replaceChildren(); window.history.replaceState({}, "", "/"); });

test("the completion CTA opens the global New task dialog", async () => {
  window.history.replaceState({}, "", "/onboarding?step=done");
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(<><OnboardingView /><GlobalNewTaskDialog /></>));
  const create = Array.from(container.querySelectorAll("button")).find(button => button.textContent === "Create your first task")!;
  expect(create).toBeDefined();
  await act(async () => create.click());
  expect(container.querySelector('[role="dialog"]')?.textContent).toBe("New task opened");
  await act(async () => root.unmount());
});
