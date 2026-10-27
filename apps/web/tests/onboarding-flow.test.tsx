// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

const fixture = vi.hoisted(() => ({
  company: { id: "company-1", name: "Acme", issueCode: "ACME" as string | undefined, status: "active" },
  projects: [] as unknown[],
  checks: [] as unknown[],
}));
vi.mock("../shell/company-context.js", () => ({ useCompanyContext: () => ({ currentCompany: fixture.company, user: { id: "user-1", role: "admin", displayName: "Ada", username: "ada", avatarSeed: "ada", title: "" }, updateProfile: vi.fn(), renameCompany: vi.fn(), setCompanyIssueCode: vi.fn(), reloadCompanies: vi.fn() }), useOptionalCompanyContext: () => undefined }));
vi.mock("../features/onboarding/onboarding.js", async importOriginal => ({ ...(await importOriginal()), useOnboardingData: () => ({ state: { company: fixture.company, checks: fixture.checks, providers: [], profiles: [], projects: fixture.projects }, loading: false, error: "", reload: vi.fn(async () => undefined) }) }));
vi.mock("../features/settings/lib/billing-api.js", () => ({ getBillingSummary: vi.fn(), startTrial: vi.fn(async () => ({})) }));
vi.mock("../features/account/lib/account-api.js", async importOriginal => ({ ...(await importOriginal()), getAccount: vi.fn(async () => ({ account: { email: "ada@example.com" } })), getEmailUpdates: vi.fn(async () => ({ available: true, subscribed: false })), setEmailUpdates: vi.fn(async (subscribed: boolean) => ({ available: true, subscribed })) }));
vi.mock("../features/settings/provider-login.js", () => ({ ProviderLoginTerminal: () => null, useProviderLogin: () => ({ login: null, loginPending: null, startLogin: vi.fn(), closeLogin: vi.fn() }) }));
vi.mock("../components/app/system-health.js", () => ({ useSystemHealth: () => ({ snapshot: { checks: fixture.checks }, refresh: vi.fn(), refreshing: false }), HerdrInstallButton: () => null }));
vi.mock("../features/projects/lib/project-api.js", () => ({ createProject: vi.fn(), listRecentRepositories: vi.fn(async () => ({ repositories: [], nextPage: null })) }));
vi.mock("../features/projects/create-project-dialog.js", () => ({ CreateProjectDialog: () => null }));
vi.mock("../features/tasks/lib/task-api.js", () => ({ createTask: vi.fn(async () => ({ id: "task-1", companyId: "company-1" })) }));
vi.mock("../features/tasks/task-data.js", () => ({ useTaskCache: () => vi.fn() }));
vi.mock("../components/app/entity-avatar.js", () => ({ AvatarEditor: () => null }));

import { OnboardingView } from "../features/onboarding/onboarding-wizard.js";
import { getBillingSummary, startTrial } from "../features/settings/lib/billing-api.js";
import { setEmailUpdates } from "../features/account/lib/account-api.js";
import { createTask } from "../features/tasks/lib/task-api.js";
import { createProject, listRecentRepositories } from "../features/projects/lib/project-api.js";
import { ApiError } from "../lib/api.js";

let root: Root;
let container: HTMLDivElement;
const render = async (path: string): Promise<void> => {
  window.history.replaceState({}, "", path);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(<OnboardingView />));
};
const button = (label: string): HTMLButtonElement => {
  const match = Array.from(container.querySelectorAll("button")).find(candidate => candidate.textContent?.trim().startsWith(label));
  expect(match, `${label} button`).toBeDefined();
  return match!;
};
const setValue = (element: HTMLInputElement | HTMLTextAreaElement, value: string): void => {
  Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), "value")?.set?.call(element, value);
  element.dispatchEvent(new Event("input", { bubbles: true }));
};

beforeEach(() => { vi.mocked(getBillingSummary).mockResolvedValue({ plan: "free", trialAvailable: true, canManageBilling: true } as Awaited<ReturnType<typeof getBillingSummary>>); });
afterEach(async () => {
  await act(async () => root.unmount());
  document.body.replaceChildren();
  fixture.company.issueCode = "ACME";
  fixture.projects = [];
  fixture.checks = [];
  vi.clearAllMocks();
});

test("a new company opens the intro, and Skip intro goes to setup", async () => {
  fixture.company.issueCode = undefined;
  await render("/onboarding");
  expect(container.querySelector("h1")?.textContent).toBe("Your agents do the work.Suplex runs the workflow.");
  expect(container.querySelector<HTMLAnchorElement>("a.skip")?.getAttribute("href")).toContain("step=you");
  await act(async () => button("See how it works").click());
  expect(window.location.search).toContain("step=input");
});

test("a named company resumes at the first unfinished setup step", async () => {
  await render("/onboarding");
  expect(container.querySelector("h1")?.textContent).toBe("Your stack.");
  expect(button("Continue").disabled).toBe(true);
});

test.each([[true, 1], [false, 0]])("You Continue saves and starts a trial only when the account has one (%s)", async (trialAvailable, calls) => {
  vi.mocked(getBillingSummary).mockResolvedValue({ plan: "free", trialAvailable, canManageBilling: true } as Awaited<ReturnType<typeof getBillingSummary>>);
  await render("/onboarding?step=you");
  setValue(container.querySelector<HTMLInputElement>("#onb-name")!, "Ada Lovelace");
  await act(async () => button("Continue").click());
  expect(window.location.search).toContain("step=stack");
  expect(startTrial).toHaveBeenCalledTimes(calls);
});

test.each([[true, 1], [false, 0]])("You Continue saves the email updates choice only when the box is checked (%s)", async (check, calls) => {
  await render("/onboarding?step=you");
  setValue(container.querySelector<HTMLInputElement>("#onb-name")!, "Ada Lovelace");
  const box = container.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
  expect(box.checked).toBe(false);
  if (check) await act(async () => box.click());
  await act(async () => button("Continue").click());
  expect(window.location.search).toContain("step=stack");
  expect(setEmailUpdates).toHaveBeenCalledTimes(calls);
  if (check) expect(setEmailUpdates).toHaveBeenCalledWith(true, "onboarding");
});

test("You Continue still moves on when the trial cannot start", async () => {
  vi.mocked(startTrial).mockRejectedValueOnce(new Error("suplex.sh did not answer"));
  await render("/onboarding?step=you");
  setValue(container.querySelector<HTMLInputElement>("#onb-name")!, "Ada Lovelace");
  await act(async () => button("Continue").click());
  expect(window.location.search).toContain("step=stack");
});

test("adding a repo at the Free project limit starts the trial and adds it again", async () => {
  vi.mocked(listRecentRepositories).mockResolvedValue({ repositories: [{ repository: "acme/api", defaultBranch: "main", pushedAt: new Date().toISOString(), ownerAvatarUrl: null }], nextPage: null });
  vi.mocked(createProject).mockRejectedValueOnce(new ApiError("Free includes 2 projects. Select Pro in Settings > Billing.", 402, undefined, undefined, "project_limit_reached")).mockResolvedValueOnce({} as Awaited<ReturnType<typeof createProject>>);
  await render("/onboarding?step=project");
  await act(async () => button("+ Add").click());
  expect(startTrial).toHaveBeenCalledTimes(1);
  expect(createProject).toHaveBeenCalledTimes(2);
  expect(container.querySelector('[role="alert"]')).toBeNull();
});

test("Create task starts the task with a ready pull request and opens it", async () => {
  fixture.projects = [{ id: "project-1", companyId: "company-1", name: "web", repository: "acme/web", baseBranch: "main", repositoryPath: "/repos/acme/web", integration: { repository: { kind: "github" }, tracker: null } }];
  await render("/onboarding?step=first-task");
  setValue(container.querySelector<HTMLInputElement>('[aria-label="Task title"]')!, "Fix the login page");
  await act(async () => button("+Create task").click());
  expect(createTask).toHaveBeenCalledWith("company-1", expect.objectContaining({ projectId: "project-1", title: "Fix the login page", startImmediately: true, deliveryTarget: "pull_request_ready", workflow: "standard" }));
  expect(window.location.pathname).toBe("/tasks/task-1");
});

test("Skip for now leaves onboarding without a task", async () => {
  await render("/onboarding?step=first-task");
  await act(async () => button("Skip for now").click());
  expect(window.location.pathname).toBe("/today");
  expect(createTask).not.toHaveBeenCalled();
});
