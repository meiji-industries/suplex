// @vitest-environment happy-dom
import { act, StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import type { ReactNode } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { HealthCheck } from "../contracts/health.js";
import type * as NavigationState from "../shell/navigation-state.js";

const company = { id: "company-1", name: "Acme", issueCode: "ACME", status: "active" };
const fixture = vi.hoisted(() => ({ currentCompany: undefined as (Omit<typeof company, "issueCode"> & { issueCode: string | undefined }) | undefined, checks: [] as HealthCheck[], loading: false, projects: [{ id: "project-1" }], reload: vi.fn(), updateProfile: vi.fn(), renameCompany: vi.fn(), setCompanyIssueCode: vi.fn() }));
vi.mock("../shell/company-context.js", () => ({ useCompanyContext: () => ({ currentCompany: fixture.currentCompany, user: { id: "user_development", role: "admin", displayName: "Operator", username: "operator@suplex.local", avatarSeed: "operator@suplex.local", title: "" }, updateProfile: fixture.updateProfile, reloadCompanies: vi.fn(), renameCompany: fixture.renameCompany, setCompanyIssueCode: fixture.setCompanyIssueCode }), useOptionalCompanyContext: () => fixture.currentCompany ? { currentCompany: fixture.currentCompany } : undefined }));
vi.mock("../features/account/lib/account-api.js", () => ({ getAccount: vi.fn(async () => ({ configured: true, canManage: true, account: { email: "adam@example.com" } })) }));
vi.mock("../features/settings/lib/billing-api.js", () => ({ getBillingSummary: vi.fn(), startCheckout: vi.fn(), startTrial: vi.fn() }));
vi.mock("../features/onboarding/onboarding.js", async importOriginal => ({ ...(await importOriginal()), useOnboardingData: () => ({ state: { company: fixture.currentCompany, checks: fixture.checks, providers: [], profiles: [], projects: fixture.projects }, loading: fixture.loading, error: "", reload: fixture.reload }) }));
vi.mock("../components/app/system-health.js", () => ({ useSystemHealth: () => ({ snapshot: { checks: fixture.checks }, refresh: vi.fn(), freshness: "fresh", refreshing: false }), CheckStatusIndicator: ({ healthyLabel }: { healthyLabel: string }) => <span>{healthyLabel}</span>, HerdrInstallButton: () => <button>Install and start Herdr</button>, SystemHealthAlert: () => null, healthCheckPurpose: () => "" }));
vi.mock("../shell/company-switcher.js", () => ({ CompanySwitcher: () => null }));
vi.mock("../shell/experiments-api.js", () => ({ useExperiments: vi.fn() }));
vi.mock("../components/ui/sidebar.js", () => ({ Sidebar: ({ children }: { children: ReactNode }) => <>{children}</>, SidebarContent: ({ children }: { children: ReactNode }) => <>{children}</>, SidebarFooter: ({ children }: { children: ReactNode }) => <>{children}</>, SidebarHeader: ({ children }: { children: ReactNode }) => <>{children}</>, SidebarInset: ({ children }: { children: ReactNode }) => <>{children}</>, SidebarMenu: ({ children }: { children: ReactNode }) => <>{children}</>, SidebarMenuButton: ({ children }: { children: ReactNode }) => <>{children}</>, SidebarMenuItem: ({ children }: { children: ReactNode }) => <>{children}</>, SidebarProvider: ({ children }: { children: ReactNode }) => <>{children}</>, SidebarTrigger: () => null, useSidebar: () => ({ setOpenMobile: vi.fn() }) }));
vi.mock("../features/settings/provider-login.js", () => ({ ProviderLoginTerminal: () => null, useProviderLogin: () => ({ login: null, loginPending: null, startLogin: vi.fn(), closeLogin: vi.fn() }) }));
vi.mock("../features/projects/project-cards.js", () => ({ ProjectCards: ({ onAdd }: { onAdd?: () => void }) => onAdd ? <button onClick={onAdd}>Add Project</button> : null }));
vi.mock("../features/projects/lib/project-api.js", async importOriginal => ({ ...(await importOriginal()), listProjects: vi.fn(async () => fixture.projects) }));
vi.mock("../features/projects/recent-repositories.js", () => ({ RecentRepositories: () => null }));
vi.mock("../features/projects/create-project-dialog.js", () => ({ CreateProjectDialog: ({ open, onCreated }: { open: boolean; onCreated: () => Promise<void> }) => open ? <div role="dialog"><button onClick={() => void onCreated()}>Save project</button></div> : null }));
vi.mock("../components/app/entity-avatar.js", () => ({ AvatarEditor: ({ name, seed }: { name: string; seed?: string }) => <output data-avatar-name={name} data-avatar-seed={seed} /> }));
vi.mock("../components/app/update-notice.js", () => ({ UpdateNotice: () => null }));
vi.mock("../components/app/theme.js", () => ({ ThemeToggle: () => null }));
vi.mock("../shell/navigation-state.js", async importOriginal => {
  const original = await importOriginal<typeof NavigationState>();
  return { ...original, navigate: vi.fn(original.navigate) };
});
vi.mock("../features/tasks/new-task-dialog.js", () => ({ NewTaskDialog: ({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) => open ? <div role="dialog">New task opened<button onClick={() => onOpenChange(false)}>Close</button></div> : null }));

import { OnboardingView } from "../features/onboarding/onboarding-wizard.js";
import { navigate } from "../shell/navigation-state.js";
import { useExperiments } from "../shell/experiments-api.js";
import { getBillingSummary, startCheckout, startTrial } from "../features/settings/lib/billing-api.js";

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

beforeEach(() => { vi.mocked(getBillingSummary).mockResolvedValue(freeSummary); });
afterEach(() => {
  fixture.currentCompany = undefined;
  fixture.loading = false;
  fixture.checks = [];
  fixture.projects = [{ id: "project-1" }];
  fixture.reload.mockReset();
  fixture.updateProfile.mockReset();
  fixture.renameCompany.mockReset();
  fixture.setCompanyIssueCode.mockReset();
  document.body.replaceChildren();
  window.history.replaceState({}, "", "/");
  vi.mocked(navigate).mockClear();
  vi.mocked(useExperiments).mockReset();
  vi.mocked(getBillingSummary).mockReset();
  vi.mocked(startCheckout).mockReset();
  vi.mocked(startTrial).mockReset();
  vi.restoreAllMocks();
});

test("Projects continues to Plan, then Free continues to Done without checkout", async () => {
  fixture.currentCompany = company;
  window.history.replaceState({}, "", "/onboarding?step=projects");
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(<StrictMode><RoutedOnboarding /></StrictMode>));
  await act(async () => button(container, "Continue").click());
  expect(window.location.search).toContain("step=plan");
  expect(container.querySelector('[role="radio"][aria-label="Free"]')?.getAttribute("aria-checked")).toBe("true");
  await act(async () => button(container, "Continue").click());
  expect(window.location.search).toContain("step=done");
  expect(startCheckout).not.toHaveBeenCalled();
  expect(container.querySelector("h2")?.textContent).toBe("Your agents do the work. Suplex runs the workflow.");
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

test.each([0, 1, 2, 3, 4])("Plan selects the eligible default with %i projects", async count => {
  fixture.currentCompany = company;
  fixture.projects = Array.from({ length: count }, (_, index) => ({ id: `project-${index}` }));
  window.history.replaceState({}, "", "/onboarding?step=plan");
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(<OnboardingView />));
  const radio = (label: string): HTMLElement => container.querySelector(`[role="radio"][aria-label="${label}"]`)!;
  expect(radio("Free").getAttribute("aria-checked")).toBe(String(count < 3));
  expect(radio("Pro").getAttribute("aria-checked")).toBe(String(count >= 3));
  expect(radio("Free").hasAttribute("data-disabled")).toBe(count >= 3);
  expect(radio("Enterprise").hasAttribute("data-disabled")).toBe(true);
  await act(async () => radio("Enterprise").click());
  expect(radio("Enterprise").getAttribute("aria-checked")).toBe("false");
  await act(async () => radio("Pro").closest("label")!.click());
  expect(radio("Pro").getAttribute("aria-checked")).toBe("true");
  await act(async () => radio("Free").closest("label")!.click());
  expect(radio("Free").getAttribute("aria-checked")).toBe(String(count < 3));
  expect(container.textContent).not.toContain("Startup");
  expect(container.querySelector("footer")?.textContent).toBe("Continue");
  await act(async () => root.unmount());
});

test("Plan updates its default when projects load and when the company changes", async () => {
  fixture.currentCompany = company;
  fixture.loading = true;
  fixture.projects = [];
  window.history.replaceState({}, "", "/onboarding?step=plan");
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(<OnboardingView />));
  expect(button(container, "Continue").disabled).toBe(true);
  fixture.projects = [{ id: "one" }, { id: "two" }, { id: "three" }];
  fixture.loading = false;
  await act(async () => root.render(<OnboardingView />));
  expect(container.querySelector('[aria-label="Pro"]')?.getAttribute("aria-checked")).toBe("true");
  fixture.currentCompany = { ...company, id: "company-2" };
  fixture.projects = [{ id: "other" }];
  await act(async () => root.render(<OnboardingView />));
  expect(container.querySelector('[aria-label="Free"]')?.getAttribute("aria-checked")).toBe("true");
  await act(async () => root.unmount());
});

const freeSummary = { plan: "free", limits: { companies: 1, projects: 2, runningTasks: 3, monthlyTasks: 50 }, usage: { companies: 1, projects: 3, runningTasks: 0, monthlyTasks: 0 }, checked: true, accountLinked: true, canManageBilling: true, purchaseConfigured: true, trialAvailable: false, subscriptionStatus: "none", renewalAt: null, accessUntil: null, cancelAtPeriodEnd: false, paymentActionRequired: false, paymentActionUrl: null } as const;

test("Pro opens checkout and reuses the intent after a failed request", async () => {
  fixture.currentCompany = company;
  fixture.projects = [{ id: "one" }, { id: "two" }, { id: "three" }];
  const tab = { opener: null, location: { href: "" }, close: vi.fn() };
  vi.spyOn(window, "open").mockReturnValue(tab as unknown as Window);
  vi.mocked(getBillingSummary).mockResolvedValue(freeSummary);
  vi.mocked(startCheckout).mockRejectedValueOnce(new Error("Connection lost")).mockResolvedValueOnce({ status: "redirect", url: "https://checkout.example/session" });
  window.history.replaceState({}, "", "/onboarding?step=plan");
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(<OnboardingView />));
  await act(async () => button(container, "Continue").click());
  expect(window.location.search).toContain("step=plan");
  expect(container.textContent).toContain("Connection lost");
  const key = vi.mocked(startCheckout).mock.calls[0]![0];
  await act(async () => button(container, "Continue").click());
  expect(startCheckout).toHaveBeenNthCalledWith(2, key);
  expect(startTrial).not.toHaveBeenCalled();
  expect(tab.location.href).toBe("https://checkout.example/session");
  expect(window.location.search).toContain("step=done");
  await act(async () => root.unmount());
});

test("Pro starts the trial without a checkout tab when the account has one", async () => {
  fixture.currentCompany = company;
  fixture.projects = [{ id: "one" }, { id: "two" }, { id: "three" }];
  const open = vi.spyOn(window, "open");
  vi.mocked(getBillingSummary).mockResolvedValue({ ...freeSummary, trialAvailable: true });
  vi.mocked(startTrial).mockResolvedValue({ ...freeSummary, plan: "pro", subscriptionStatus: "trialing" });
  window.history.replaceState({}, "", "/onboarding?step=plan");
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(<OnboardingView />));
  expect(container.textContent).toContain("No credit card is necessary.");
  await act(async () => button(container, "Continue").click());
  expect(startTrial).toHaveBeenCalledOnce();
  expect(startCheckout).not.toHaveBeenCalled();
  expect(open).not.toHaveBeenCalled();
  expect(window.location.search).toContain("step=done");
  await act(async () => root.unmount());
});

test("an existing Pro subscription continues without another checkout", async () => {
  fixture.currentCompany = company;
  fixture.projects = [{ id: "one" }, { id: "two" }, { id: "three" }];
  const open = vi.spyOn(window, "open");
  vi.mocked(getBillingSummary).mockResolvedValue({ ...freeSummary, plan: "pro", subscriptionStatus: "active" });
  window.history.replaceState({}, "", "/onboarding?step=plan");
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(<OnboardingView />));
  await act(async () => button(container, "Continue").click());
  expect(startCheckout).not.toHaveBeenCalled();
  expect(open).not.toHaveBeenCalled();
  expect(window.location.search).toContain("step=done");
  await act(async () => root.unmount());
});

test("Done shows Today only while the experiment is enabled", async () => {
  fixture.currentCompany = company;
  window.history.replaceState({}, "", "/onboarding?step=done");
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);

  for (const todayPage of [undefined, false, true, false]) {
    vi.mocked(useExperiments).mockReturnValue(todayPage === undefined ? undefined : { todayPage, hostTerminal: false });
    await act(async () => root.render(<OnboardingView />));
    const today = Array.from(container.querySelectorAll("a")).find(link => link.textContent === "Today");
    expect(Boolean(today)).toBe(todayPage === true);
    if (today) expect(today.getAttribute("href")).toBe("/today");
    expect(button(container, "Create your first task").disabled).toBe(false);
  }

  await act(async () => root.unmount());
});

test("company avatar uses the trimmed name draft and falls back to the saved name", async () => {
  fixture.currentCompany = { ...company, name: "My Company", issueCode: undefined };
  window.history.replaceState({}, "", "/onboarding?step=company");
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(<OnboardingView />));
  const avatar = container.querySelector<HTMLOutputElement>('output[data-avatar-name="My Company"]')!;
  const input = container.querySelector<HTMLInputElement>("#onboarding-name")!;

  expect(input.value).toBe("");
  expect(avatar.dataset.avatarSeed).toBe("My Company");
  await act(async () => setInput(input, "  ACME Agency  "));
  expect(avatar.dataset.avatarName).toBe("ACME Agency");
  expect(avatar.dataset.avatarSeed).toBe("ACME Agency");
  await act(async () => setInput(input, "   "));
  expect(avatar.dataset.avatarSeed).toBe("My Company");
  await act(async () => root.unmount());
});

test("Projects shares the empty state and refreshes onboarding after creation", async () => {
  fixture.currentCompany = company;
  fixture.projects = [];
  window.history.replaceState({}, "", "/onboarding?step=projects");
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const render = (): void => root.render(<OnboardingView />);
  fixture.reload.mockImplementation(async () => {
    fixture.projects = [{ id: "project-1" }];
    render();
  });
  await act(async () => render());
  expect(container.querySelector("h2")?.textContent).toBe("Projects");
  expect(container.textContent).toContain("Add Project");
  expect(button(container, "Continue").disabled).toBe(true);
  expect(container.querySelector('[aria-label="Check again"]')).toBeNull();
  await act(async () => button(container, "Add Project").click());
  await act(async () => button(container, "Save project").click());
  expect(fixture.reload).toHaveBeenCalledOnce();
  expect(window.location.search).toContain("step=projects");
  expect(container.textContent).not.toContain("No projects");
  expect(button(container, "Continue").disabled).toBe(false);
  await act(async () => root.unmount());
});

 test("first step saves the profile before the company and stays on errors", async () => {
  fixture.currentCompany = company;
  window.history.replaceState({}, "", "/onboarding?step=company");
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(<OnboardingView />));
  expect(container.querySelector<HTMLInputElement>("#display-name")?.value).toBe("");
  expect(container.querySelector<HTMLInputElement>("#username")?.value).toBe("adam");
  await act(async () => {
    setInput(container.querySelector<HTMLInputElement>("#display-name")!, "Adam Meghji");
    setInput(container.querySelector<HTMLInputElement>("#profile-title")!, "CTO");
    setInput(container.querySelector<HTMLInputElement>("#onboarding-name")!, "New Company");
  });
  fixture.updateProfile.mockRejectedValueOnce(new Error("Profile could not be saved"));
  await act(async () => button(container, "Continue").click());
  expect(container.textContent).toContain("Profile could not be saved");
  expect(fixture.renameCompany).not.toHaveBeenCalled();
  expect(navigate).not.toHaveBeenCalled();
  await act(async () => button(container, "Continue").click());
  expect(fixture.updateProfile).toHaveBeenLastCalledWith({ displayName: "Adam Meghji", username: "adam", title: "CTO", avatarSeed: "adam" });
  expect(fixture.renameCompany).toHaveBeenCalledWith("company-1", "New Company");
  expect(navigate).toHaveBeenCalledWith("/onboarding?step=tools&company=company-1");
  await act(async () => root.unmount());
});

test("empty necessary onboarding fields use the input invalid state", async () => {
  fixture.currentCompany = company;
  window.history.replaceState({}, "", "/onboarding?step=company");
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(<OnboardingView />));
  for (const id of ["display-name", "username", "onboarding-name", "onboarding-code"]) {
    const input = container.querySelector<HTMLInputElement>(`#${id}`)!;
    expect(input.required).toBe(true);
    await act(async () => setInput(input, "Filled"));
    expect(input.getAttribute("aria-invalid")).toBe("false");
    await act(async () => setInput(input, "   "));
    expect(input.getAttribute("aria-invalid")).toBe("true");
    await act(async () => setInput(input, "Filled"));
    expect(input.getAttribute("aria-invalid")).toBe("false");
  }
  const title = container.querySelector<HTMLInputElement>("#profile-title")!;
  expect(title.required).toBe(false);
  expect(title.getAttribute("aria-invalid")).not.toBe("true");
  await act(async () => root.unmount());
});

test("GitHub CLI badge shows the signed-in account and falls back without it", async () => {
  fixture.currentCompany = company;
  fixture.checks = [{ id: "gh-cli", label: "GitHub CLI", status: "healthy", summary: "Signed in", details: { logins: "adammeghji" } }];
  window.history.replaceState({}, "", "/onboarding?step=tools");
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(<OnboardingView />));
  expect(container.textContent).toContain("@adammeghji");
  fixture.checks[0]!.details = {};
  await act(async () => root.render(<OnboardingView />));
  expect(container.textContent).not.toContain("@adammeghji");
  expect(container.textContent).toContain("Done");
  await act(async () => root.unmount());
});

test("Herdr installation uses the tool row action slot", async () => {
  fixture.currentCompany = company;
  fixture.checks = [{ id: "herdr-readiness", label: "Herdr", status: "unhealthy", summary: "Offline", details: {}, remedy: "install herdr" }];
  window.history.replaceState({}, "", "/onboarding?step=tools");
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(<OnboardingView />));
  const install = Array.from(container.querySelectorAll("button")).find(button => button.textContent === "Install and start Herdr")!;
  expect(install.parentElement?.textContent).toContain("Herdr runs your agents in the background");
  expect(install.parentElement?.lastElementChild).toBe(install);
  expect(container.textContent).not.toContain("install herdr");
  await act(async () => root.unmount());
});
