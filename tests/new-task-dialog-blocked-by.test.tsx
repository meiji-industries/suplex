// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { Task } from "../src/frontend/contracts/tasks.js";

const storage = vi.hoisted(() => ({ getItem: vi.fn(), setItem: vi.fn() }));
const roots: ReturnType<typeof createRoot>[] = [];
const api = vi.hoisted(() => ({ readJsonUnchecked: vi.fn(), withCompany: (path: string) => path }));
vi.mock("../src/frontend/lib/api.js", () => api);
vi.mock("../src/frontend/features/tasks/task-data.js", () => ({ useTaskCache: () => vi.fn() }));

vi.mock("../src/frontend/components/ui/dialog.js", async () => {
  const React = await import("react");
  const Context = React.createContext({ onOpenChange: (_open: boolean): void => undefined });
  return {
    Dialog: ({ open, onOpenChange, children }: { open: boolean; onOpenChange: (open: boolean) => void; children: React.ReactNode }) => open ? <Context.Provider value={{ onOpenChange }}>{children}</Context.Provider> : null,
    DialogContent: ({ children, showCloseButton = true }: { children: React.ReactNode; showCloseButton?: boolean }) => {
      const { onOpenChange } = React.useContext(Context);
      return <div>{children}{showCloseButton ? <button type="button" aria-label="Close" onClick={() => onOpenChange(false)}>Close</button> : null}</div>;
    },
    DialogFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    DialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
  };
});
vi.mock("../src/frontend/components/ui/dropdown-menu.js", async () => {
  const React = await import("react");
  const Context = React.createContext({ open: false, setOpen: (_open: boolean): void => undefined });
  return {
    DropdownMenu: ({ children }: { children: React.ReactNode }) => { const [open, setOpen] = React.useState(false); return <Context.Provider value={{ open, setOpen }}>{children}</Context.Provider>; },
    DropdownMenuTrigger: ({ render, children }: { render: React.ReactElement; children: React.ReactNode }) => { const { setOpen } = React.useContext(Context); return React.cloneElement(render as React.ReactElement<React.ButtonHTMLAttributes<HTMLButtonElement>>, { onClick: () => setOpen(true) }, children); },
    DropdownMenuContent: ({ children }: { children: React.ReactNode }) => React.useContext(Context).open ? <div role="menu">{children}</div> : null,
    DropdownMenuItem: ({ children, onClick }: { children: React.ReactNode; onClick?: () => void }) => <button type="button" role="menuitem" onClick={onClick}>{children}</button>,
    DropdownMenuRadioGroup: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    DropdownMenuRadioItem: ({ children }: { children: React.ReactNode }) => <button type="button" role="menuitemradio">{children}</button>,
  };
});
vi.mock("../src/frontend/components/ui/tabs.js", async () => {
  const React = await import("react");
  const Context = React.createContext((_value: string): void => undefined);
  return {
    Tabs: ({ onValueChange, children }: { onValueChange: (value: string) => void; children: React.ReactNode }) => <Context.Provider value={onValueChange}>{children}</Context.Provider>,
    TabsList: ({ children }: { children: React.ReactNode }) => <div role="tablist">{children}</div>,
    TabsTrigger: ({ value, children }: { value: string; children: React.ReactNode }) => { const change = React.useContext(Context); return <button type="button" role="tab" onClick={() => change(value)}>{children}</button>; },
  };
});
vi.mock("../src/frontend/components/ui/button.js", () => ({ Button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => <button {...props}>{children}</button> }));
vi.mock("../src/frontend/components/ui/new-button.js", () => ({ NewButton: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => <button {...props}>{children}</button> }));
vi.mock("../src/frontend/components/ui/input.js", () => ({ Input: (props: React.InputHTMLAttributes<HTMLInputElement>) => <input {...props} /> }));
vi.mock("../src/frontend/components/ui/textarea.js", () => ({ Textarea: (props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) => <textarea {...props} /> }));
vi.mock("../src/frontend/components/ui/checkbox.js", () => ({ Checkbox: ({ checked, disabled, onCheckedChange }: { checked: boolean; disabled?: boolean; onCheckedChange: (value: boolean) => void }) => <input type="checkbox" checked={checked} disabled={disabled} onChange={event => onCheckedChange(event.target.checked)} /> }));
vi.mock("../src/frontend/features/tasks/task-option-filter.js", async () => {
  const React = await import("react");
  return { TaskOptionFilter: ({ label, value, valueLabel, options, disabled, onValueChange }: { label: string; value: string | string[]; valueLabel?: string; options: { value: string; label: string; disabled?: boolean }[]; disabled: boolean; onValueChange: (value: string | string[]) => void }) => {
    const [open, setOpen] = React.useState(false);
    return <><button type="button" aria-label={label} disabled={disabled} onClick={() => setOpen(!open)}>{valueLabel ?? options.find(option => option.value === value)?.label ?? value}</button>{open ? options.map(option => <button type="button" role="option" key={option.value} disabled={option.disabled} onClick={() => { onValueChange(Array.isArray(value) ? value.includes(option.value) ? value.filter(item => item !== option.value) : [...value, option.value] : option.value); setOpen(false); }}>{option.label}</button>) : null}</>;
  } };
});
vi.mock("../src/frontend/components/ui/inline-attachment-picker.js", () => ({ InlineAttachmentList: () => null, InlineAttachmentPicker: () => null }));
vi.mock("../src/frontend/components/ui/alert.js", () => ({ Alert: ({ children }: { children: React.ReactNode }) => <div>{children}</div>, AlertDescription: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock("../src/frontend/components/app/entity-avatar.js", () => ({ EntityAvatar: () => null }));
vi.mock("../src/frontend/components/ui/breadcrumb.js", () => ({ Breadcrumb: ({ children }: { children: React.ReactNode }) => <>{children}</>, BreadcrumbItem: ({ children }: { children: React.ReactNode }) => <>{children}</>, BreadcrumbList: ({ children }: { children: React.ReactNode }) => <>{children}</>, BreadcrumbSeparator: () => null }));
vi.mock("../src/frontend/features/tasks/task-source-picker.js", () => ({
  TaskSourcePicker: ({ onSelect, pullRequestsOnly, onClear, trigger }: { trigger?: React.ReactElement<React.ButtonHTMLAttributes<HTMLButtonElement>>; onSelect: (source: unknown, selector?: unknown) => void; pullRequestsOnly: boolean; onClear: () => void }) => <><button type="button" onClick={() => pullRequestsOnly ? onSelect({ kind: "pull_request", title: "Repair the picker", number: 42 }, { kind: "pull_request", number: 42 }) : onSelect({ kind: "issue", issue: { kind: "jira", site: "https://client.atlassian.net", id: "42", key: "APP-42", title: "Fix the picker", url: "https://client.atlassian.net/browse/APP-42" } })}>{trigger?.props.children ?? (pullRequestsOnly ? "Select a PR" : "Select Jira issue")}</button><button type="button" onClick={onClear}>Clear source</button></>,
  issueTaskSource: (issue: unknown) => ({ kind: "issue", issue }),
  prefillForTaskSource: (source: { kind: string; issue?: { title: string; key: string; url: string } }) => source.kind === "issue" ? { title: source.issue!.title, description: `Work on ${source.issue!.key}: ${source.issue!.url}` } : { title: "", description: "" },
}));
vi.mock("../src/frontend/features/tasks/task-role-selectors.js", () => ({ TaskRoleSelector: ({ role, label }: { role: string; label?: string }) => <span data-role-selector={role}>{label ?? role}</span> }));

import { NewTaskDialog } from "../src/frontend/features/tasks/new-task-dialog.js";

const project = { id: "project-1", name: "Project One", rootProfileId: "root", workerProfileId: "worker", verificationCommand: "" };
const profile = { id: "root", role: "root", provider: "opencode", model: "root", reasoningLevel: "medium", serviceTier: "default" };
const worker = { ...profile, id: "worker", role: "worker", model: "worker" };
const workflow = { id: "workflow_native_standard", name: "Plan and build", engine: "standard", rootProfileId: "root", workerProfileId: "worker", advisorProfileIds: {}, deliveryTarget: "pull_request_draft", runProjectTests: true, visualEvidence: "off", archivedAt: null };
const active = { id: "task-active", projectId: project.id, title: "Active prerequisite", status: "active", archivedAt: null, queue: { state: "running" } };
const otherProject = { id: "task-other-project", projectId: "project-2", title: "Other project", status: "active", archivedAt: null, queue: { state: "running" } };
const backlog = { id: "task-backlog", projectId: project.id, title: "Backlog task", status: "backlog", archivedAt: null, queue: { state: "backlog" } };
const waiting = { id: "task-waiting", projectId: project.id, title: "Waiting task", status: "waiting_human", archivedAt: null, queue: { state: "running" } };
const pullRequest = { kind: "pull_request", number: 12, title: "Ship the API", body: "", author: "octocat", headBranch: "feature/api", baseBranch: "main", isDraft: false, usedBy: null };
const archived = { id: "task-archived", projectId: project.id, title: "Archived task", status: "active", archivedAt: "2026-01-01T00:00:00.000Z", queue: { state: "running" } };
const delivered = { id: "task-delivered", projectId: project.id, title: "Delivered task", status: "delivered", archivedAt: null, queue: { state: "delivered" } };
const cancelled = { id: "task-cancelled", projectId: project.id, title: "Cancelled task", status: "cancelled", archivedAt: null, queue: { state: "cancelled" } };

function setText(field: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const prototype = field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(field, value);
  field.dispatchEvent(new Event("input", { bubbles: true }));
}

function button(container: HTMLElement, label: string) {
  const value = Array.from(container.querySelectorAll("button")).find(candidate => candidate.getAttribute("aria-label") === label || candidate.textContent?.includes(label));
  if (!value) throw new Error(`Button not found: ${label}`);
  return value;
}

function mount(editing = false, initialDraft?: React.ComponentProps<typeof NewTaskDialog>["initialDraft"]) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  act(() => { root.render(<NewTaskDialog initialDraft={initialDraft} open companyId="company-1" onOpenChange={() => undefined} onCreated={() => undefined} {...(editing ? { editTask: { id: "task-edit", configuration: {} } as Task } : {})} />); });
  return { container, root };
}

async function flush() {
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
}

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  storage.getItem.mockReturnValue(null);
  storage.setItem.mockClear();
  vi.stubGlobal("localStorage", storage);
  api.readJsonUnchecked.mockReset();
  api.readJsonUnchecked.mockImplementation(async (url: string, init?: RequestInit) => {
    if (url === "/api/companies/company-1/tasks" && init?.method === "POST") return { id: "created" };
    if (url === "/api/companies/company-1/projects") return { projects: [project] };
    if (url === "/api/profiles") return { profiles: [profile, worker] };
    if (url === "/api/workflows?includeArchived=true") return { workflows: [workflow] };
    if (url === "/api/projects/project-1/task-templates") return { templates: [] };
    if (url === "/api/companies/company-1/tasks") return { tasks: [active, otherProject, backlog, waiting, archived, delivered, cancelled] };
    if (url === "/api/projects/project-1/task-sources?kind=pull_request") return { available: true, sources: [pullRequest] };
    throw new Error(`Unexpected request: ${url}`);
  });
});
afterEach(async () => { await act(async () => { roots.splice(0).forEach(root => root.unmount()); document.body.replaceChildren(); }); vi.unstubAllGlobals(); });

test("New task Blocked by picker filters, selects several, removes one, and posts the rest as dependsOn", async () => {
  const view = mount();
  await flush();
  expect(view.container.querySelector('[aria-label="More options"]')).toBeNull();
  await act(async () => { button(view.container, "Blocked by...").click(); });
  await flush();
  expect(view.container.textContent).toContain("Active prerequisite");
  expect(view.container.textContent).not.toContain("task-active");
  expect(view.container.textContent).toContain("Backlog task");
  expect(view.container.textContent).toContain("Waiting task");
  expect(view.container.textContent).not.toContain("Other project");
  expect(view.container.textContent).not.toContain("Archived task");
  expect(view.container.textContent).not.toContain("Delivered task");
  expect(view.container.textContent).not.toContain("Cancelled task");
  const search = view.container.querySelector<HTMLInputElement>('[aria-label="Search tasks"]')!;
  await act(async () => { setText(search, "prerequisite"); });
  expect(view.container.textContent).toContain("Active prerequisite");
  await act(async () => { setText(search, "task-active"); });
  expect(view.container.textContent).toContain("Active prerequisite");
  await act(async () => { button(view.container, "Active prerequisite").click(); });
  expect(view.container.textContent).toContain("Blocked by Active prerequisite");

  const title = view.container.querySelector<HTMLInputElement>('[aria-label="Task title"]')!;
  await act(async () => { button(view.container, "Remove Active prerequisite from Blocked by").click(); });
  expect(view.container.querySelector('[data-blocked-by-selection]')).toBeNull();
  await act(async () => { setText(title, "Create without reference"); title.form?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); await Promise.resolve(); });
  const posts = () => api.readJsonUnchecked.mock.calls.filter(([url, init]) => url === "/api/companies/company-1/tasks" && init?.method === "POST").map(([, init]) => JSON.parse(init.body));
  expect(posts()[0]).not.toHaveProperty("dependsOn");
  expect(posts()[0]).not.toHaveProperty("blockedByTaskId");

  for (const name of ["Active prerequisite", "Backlog task", "Waiting task"]) {
    await act(async () => { button(view.container, "Blocked by...").click(); });
    await flush();
    await act(async () => { button(view.container, name).click(); });
  }
  expect(view.container.querySelectorAll("[data-blocked-by-selection]")).toHaveLength(3);
  // A selected task is not offered again.
  await act(async () => { button(view.container, "Blocked by...").click(); });
  await flush();
  expect(view.container.querySelector('[aria-label="Search tasks"]')!.parentElement!.textContent).not.toContain("Backlog task");
  await act(async () => { button(view.container, "Close").click(); });
  await act(async () => { button(view.container, "Remove Active prerequisite from Blocked by").click(); });
  await act(async () => { button(view.container, "Blocked by...").click(); });
  await flush();
  await act(async () => { button(view.container, "Active prerequisite").click(); setText(title, "Create dependent"); title.form?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); await Promise.resolve(); });
  expect(posts()[1].dependsOn).toEqual(["task-backlog", "task-waiting", "task-active"]);
  expect(posts()[1]).not.toHaveProperty("blockedByTaskId");
});

test("the Pull requests tab adds a removable pull request chip and posts it as blockedByPullRequests", async () => {
  const view = mount();
  await flush();
  await act(async () => { button(view.container, "Blocked by...").click(); });
  await flush();
  await act(async () => { button(view.container, "Pull requests").click(); });
  await flush();
  expect(view.container.querySelector('[aria-label="Search pull requests"]')).not.toBeNull();
  expect(view.container.textContent).toContain("#12 Ship the API");
  expect(view.container.textContent).not.toContain("Active prerequisite");
  await act(async () => { button(view.container, "#12 Ship the API").click(); });
  expect(view.container.querySelector('[aria-label="Search pull requests"]')).toBeNull();
  expect(view.container.textContent).toContain("Blocked by #12 Ship the API");
  // A selected pull request is not offered again.
  await act(async () => { button(view.container, "Blocked by...").click(); });
  await flush();
  await act(async () => { button(view.container, "Pull requests").click(); });
  await flush();
  expect(view.container.textContent).toContain("No pull requests found.");
  await act(async () => { button(view.container, "Close").click(); });
  await act(async () => { button(view.container, "Remove pull request #12 from Blocked by").click(); });
  expect(view.container.querySelector("[data-blocked-by-selection]")).toBeNull();
  await act(async () => { button(view.container, "Blocked by...").click(); });
  await flush();
  await act(async () => { button(view.container, "Pull requests").click(); });
  await flush();
  const title = view.container.querySelector<HTMLInputElement>('[aria-label="Task title"]')!;
  await act(async () => { button(view.container, "#12 Ship the API").click(); setText(title, "Wait for the API"); title.form?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); await Promise.resolve(); });
  const post = api.readJsonUnchecked.mock.calls.filter(([url, init]) => url === "/api/companies/company-1/tasks" && init?.method === "POST").at(-1)!;
  expect(JSON.parse(post[1].body)).toMatchObject({ blockedByPullRequests: [{ number: 12 }] });
  expect(JSON.parse(post[1].body)).not.toHaveProperty("dependsOn");
});

test("the Pull requests tab reports an unavailable repository", async () => {
  const fallback = api.readJsonUnchecked.getMockImplementation()!;
  api.readJsonUnchecked.mockImplementation(async (url: string, init?: RequestInit) => url === "/api/projects/project-1/task-sources?kind=pull_request" ? { available: false, sources: [] } : fallback(url, init));
  const view = mount();
  await flush();
  await act(async () => { button(view.container, "Blocked by...").click(); });
  await flush();
  await act(async () => { button(view.container, "Pull requests").click(); });
  await flush();
  expect(view.container.textContent).toContain("Pull requests are not available.");
});

test("New from stores the selected Jira issue on the create request", async () => {
  const view = mount();
  await flush();
  expect(view.container.textContent).not.toContain("IssueNone");
  await act(async () => { button(view.container, "Select Jira issue").click(); });
  const title = view.container.querySelector<HTMLInputElement>('[aria-label="Task title"]')!;
  expect(title.value).toBe("Fix the picker");
  await act(async () => { title.form?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); await Promise.resolve(); });
  const post = api.readJsonUnchecked.mock.calls.filter(([url, init]) => url === "/api/companies/company-1/tasks" && init?.method === "POST").at(-1);
  expect(post).toBeDefined();
  expect(JSON.parse(post![1].body)).toMatchObject({
    title: "Fix the picker",
    issue: { kind: "jira", site: "https://client.atlassian.net", id: "42", key: "APP-42", title: "Fix the picker", url: "https://client.atlassian.net/browse/APP-42" },
  });
});

test("closing the Blocked by picker preserves the new task dialog state", async () => {
  const view = mount();
  await flush();
  const title = view.container.querySelector<HTMLInputElement>('[aria-label="Task title"]')!;
  const description = view.container.querySelector<HTMLTextAreaElement>('[aria-label="Task description"]')!;
  await act(async () => { setText(title, "Dependent task"); setText(description, "Wait for the prerequisite"); });
  await act(async () => { button(view.container, "Blocked by...").click(); });
  await flush();
  await act(async () => { button(view.container, "Active prerequisite").click(); });
  await act(async () => { button(view.container, "Blocked by...").click(); });
  await flush();
  expect(view.container.querySelector('[aria-label="Search tasks"]')).not.toBeNull();
  await act(async () => { button(view.container, "Close").click(); });
  expect(view.container.querySelector('[aria-label="Search tasks"]')).toBeNull();
  expect(title.value).toBe("Dependent task");
  expect(description.value).toBe("Wait for the prerequisite");
  expect(view.container.textContent).toContain("Blocked by Active prerequisite");
});

test("Blocked by is absent when editing a task", async () => {
  const view = mount(true);
  await flush();
  expect(Array.from(view.container.querySelectorAll("button")).some(element => element.textContent === "Blocked by...")).toBe(false);
});

test("the picker reports an empty task result", async () => {
  const view = mount();
  await flush();
  await act(async () => { button(view.container, "Blocked by...").click(); });
  await flush();
  const search = view.container.querySelector<HTMLInputElement>('[aria-label="Search tasks"]')!;
  await act(async () => { setText(search, "nothing"); });
  expect(view.container.textContent).toContain("No matching backlog, queued, active, or Answer necessary tasks.");
});

test("Workflow stays selected by name, previews the selected engine, and posts it", async () => {
  const review = { ...workflow, id: "workflow_native_independent_review", name: "Double reviews", engine: "independent_review" };
  const fallback = api.readJsonUnchecked.getMockImplementation()!;
  api.readJsonUnchecked.mockImplementation(async (url: string, init?: RequestInit) => url === "/api/workflows?includeArchived=true" ? { workflows: [workflow, review] } : fallback(url, init));
  const view = mount();
  await flush();
  const trigger = () => view.container.querySelector<HTMLButtonElement>('button[aria-label="Workflow"]')!;
  const clear = () => view.container.querySelector<HTMLButtonElement>('[aria-label="Clear workflow"]');
  const title = view.container.querySelector<HTMLInputElement>('[aria-label="Task title"]')!;
  const submit = async () => { await act(async () => { setText(title, "Pick a workflow"); title.form?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); await Promise.resolve(); }); };
  const lastPost = () => JSON.parse(api.readJsonUnchecked.mock.calls.filter(([url, init]) => url === "/api/companies/company-1/tasks" && init?.method === "POST").at(-1)![1].body);
  expect(trigger().textContent).toBe("Plan and build");
  expect(clear()).toBeNull();

  await act(async () => { trigger().click(); });
  await act(async () => { button(view.container, "Double reviews").click(); });
  expect(trigger().textContent).toBe("Double reviews");
  expect(clear()).toBeNull();
  expect(view.container.querySelector('[data-workflow-illustration="independent_review"]')).not.toBeNull();
  expect(view.container.textContent).toContain("Reviewer");
  await submit();
  expect(lastPost().workflow).toBe("independent_review");

  await act(async () => { trigger().click(); });
  await act(async () => { button(view.container, "Plan and build").click(); });
  expect(trigger().textContent).toBe("Plan and build");
  expect(clear()).toBeNull();
  await submit();
  expect(lastPost().workflow).toBe("standard");
});

async function selectOption(container: HTMLElement, label: string, option: string) {
  await act(async () => { button(container, label).click(); });
  await act(async () => { button(container, option).click(); });
}

function latestRequest(method: string) {
  const call = api.readJsonUnchecked.mock.calls.filter(([, init]) => init?.method === method).at(-1);
  return call ? JSON.parse(call[1].body) : undefined;
}

async function submitTask(container: HTMLElement) {
  const title = container.querySelector<HTMLInputElement>('[aria-label="Task title"]')!;
  await act(async () => { setText(title, "Workflow task"); title.form?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); await Promise.resolve(); });
}

test.each([true, false])("form submission uses the selected start mode: %s", async startImmediately => {
  const { container } = mount(false, { startImmediately });
  await flush();
  expect(button(container, "Create task")).toBeDefined();
  await submitTask(container);
  expect(latestRequest("POST")).toMatchObject({ startImmediately });
});

test("shows disabled project tests when the project has no test command", async () => {
  const { container } = mount();
  await flush();
  await act(async () => { button(container, "Tests and proof").click(); });
  const projectTests = Array.from(container.querySelectorAll<HTMLButtonElement>('[role="option"]')).find(option => option.textContent === "Tests")!;
  expect(projectTests.disabled).toBe(true);
  expect(container.textContent).not.toContain("No project test command configured.");
});

test("the combined checks picker saves tests and proof independently", async () => {
  const fallback = api.readJsonUnchecked.getMockImplementation()!;
  api.readJsonUnchecked.mockImplementation(async (url: string, init?: RequestInit) => url === "/api/companies/company-1/projects" ? { projects: [{ ...project, verificationCommand: "pnpm test" }] } : fallback(url, init));
  const { container } = mount();
  await flush();
  expect(button(container, "Tests and proof").textContent).toBe("tests");
  await selectOption(container, "Tests and proof", "Tests");
  expect(button(container, "Tests and proof").textContent).toBe("no checks");
  await selectOption(container, "Tests and proof", "Proof");
  expect(button(container, "Tests and proof").textContent).toBe("proof");
  await selectOption(container, "Tests and proof", "Tests");
  expect(button(container, "Tests and proof").textContent).toBe("tests and proof");
  await selectOption(container, "Tests and proof", "Tests");
  await submitTask(container);
  expect(latestRequest("POST")).toMatchObject({ runProjectTests: false, visualEvidence: "capture" });
});

test("repair keeps its source requirement and restores the prior delivery", async () => {
  const repair = { ...workflow, id: "repair", name: "Review and repair", engine: "refine_pull_request" };
  const standard = { ...workflow, deliveryTarget: undefined, runProjectTests: undefined };
  const fallback = api.readJsonUnchecked.getMockImplementation()!;
  api.readJsonUnchecked.mockImplementation(async (url: string, init?: RequestInit) => url === "/api/workflows?includeArchived=true" ? { workflows: [standard, repair] } : fallback(url, init));
  const { container } = mount();
  await flush();
  await selectOption(container, "Delivery target", "push branch");
  await selectOption(container, "Workflow", "Review and repair");
  expect(button(container, "Delivery target").textContent).toBe("merge to base");
  expect(button(container, "Delivery target").disabled).toBe(true);
  expect(container.textContent).not.toContain("Needs a PR");
  expect(button(container, "a PR")).toBeDefined();
  await submitTask(container);
  expect(latestRequest("POST")).toBeUndefined();
  await act(async () => { button(container, "a PR").click(); });
  expect(button(container, "PR #42")).toBeDefined();
  await submitTask(container);
  expect(latestRequest("POST")).toMatchObject({ workflow: "refine_pull_request", deliveryTarget: "merged", runProjectTests: true, source: { kind: "pull_request", number: 42 } });
  await selectOption(container, "Workflow", "Plan and build");
  expect(button(container, "Delivery target").textContent).toBe("push branch");
  expect(button(container, "Delivery target").disabled).toBe(false);
  await submitTask(container);
  expect(latestRequest("POST")).toMatchObject({ workflow: "standard", deliveryTarget: "remote_branch" });
  const diagram = container.querySelector('[data-workflow-illustration="standard"] svg')!;
  expect(diagram.querySelectorAll('[data-role-selector="root"]')).toHaveLength(2);
  expect(diagram.querySelectorAll('[data-role-selector="worker"]')).toHaveLength(1);
});

test("repair takes its record's project tests, keeps them editable, and still merges", async () => {
  const repair = { ...workflow, id: "repair", name: "Review and repair", engine: "refine_pull_request", deliveryTarget: undefined, runProjectTests: false };
  const fallback = api.readJsonUnchecked.getMockImplementation()!;
  api.readJsonUnchecked.mockImplementation(async (url: string, init?: RequestInit) => {
    if (url === "/api/companies/company-1/projects") return { projects: [{ ...project, verificationCommand: "pnpm test" }] };
    if (url === "/api/workflows?includeArchived=true") return { workflows: [workflow, repair] };
    if (url === "/api/tasks/task-edit" && init?.method === "PATCH") return { id: "task-edit" };
    return fallback(url, init);
  });
  const { container } = mount();
  await flush();
  await selectOption(container, "Workflow", "Review and repair");
  expect(button(container, "Tests and proof").textContent).toBe("no checks");
  expect(button(container, "Delivery target").disabled).toBe(true);
  await act(async () => { button(container, "a PR").click(); });
  await submitTask(container);
  expect(latestRequest("POST")).toMatchObject({ workflow: "refine_pull_request", deliveryTarget: "merged", runProjectTests: false });
  await selectOption(container, "Tests and proof", "Tests");
  await act(async () => { button(container, "a PR").click(); });
  await submitTask(container);
  expect(latestRequest("POST")).toMatchObject({ workflow: "refine_pull_request", deliveryTarget: "merged", runProjectTests: true });
  await act(async () => { roots.splice(0).forEach(root => root.unmount()); document.body.replaceChildren(); });
  const edit = mount(true, { workflowId: repair.id, runProjectTests: true, source: { kind: "pull_request", number: 42 } });
  await flush();
  expect(button(edit.container, "Tests and proof").textContent).toBe("tests");
  await selectOption(edit.container, "Tests and proof", "Tests");
  await submitTask(edit.container);
  expect(latestRequest("PATCH")).toMatchObject({ workflow: "refine_pull_request", deliveryTarget: "merged", runProjectTests: false });
});

test("saved variants and explicit edit drafts keep their settings with the engine illustration", async () => {
  const saved = { ...workflow, id: "custom", name: "Team review", description: "Check the complete change.", engine: "independent_review", deliveryTarget: "pull_request_ready", advisorProfileIds: { reviewer: "root" } };
  const fallback = api.readJsonUnchecked.getMockImplementation()!;
  api.readJsonUnchecked.mockImplementation(async (url: string, init?: RequestInit) => {
    if (url === "/api/workflows?includeArchived=true") return { workflows: [workflow, saved] };
    if (url === "/api/tasks/task-edit" && init?.method === "PATCH") return { id: "task-edit" };
    return fallback(url, init);
  });
  const { container } = mount(true, { workflowId: saved.id, deliveryTarget: "local_worktree", source: { kind: "pull_request", number: 42 } });
  await flush();
  expect(button(container, "Workflow").textContent).toBe("Team review");
  expect(container.querySelector('[data-workflow-illustration="independent_review"]')).not.toBeNull();
  expect(container.textContent).not.toContain("Check the complete change.");
  expect(button(container, "Delivery target").textContent).toBe("keep in worktree");
  await submitTask(container);
  expect(latestRequest("PATCH")).toMatchObject({ workflow: "independent_review", deliveryTarget: "local_worktree", advisorProfileIds: { reviewer: "root" } });
  expect(latestRequest("PATCH")).not.toHaveProperty("source");
  expect(storage.setItem).not.toHaveBeenCalled();
});

test("Plan and build remains visible and usable when the workflow catalog is empty", async () => {
  const fallback = api.readJsonUnchecked.getMockImplementation()!;
  api.readJsonUnchecked.mockImplementation(async (url: string, init?: RequestInit) => url === "/api/workflows?includeArchived=true" ? { workflows: [] } : fallback(url, init));
  const { container } = mount();
  await flush();
  expect(button(container, "Workflow").textContent).toBe("Plan and build");
  expect(container.querySelector('[data-workflow-illustration="standard"]')).not.toBeNull();
  await submitTask(container);
  expect(latestRequest("POST")).toMatchObject({ workflow: "standard" });
});

test("templates replace the selected workflow, illustration, and admitted Advisors", async () => {
  const combined = { ...workflow, id: "combined", name: "Double plans", engine: "competing_plans", advisorProfileIds: { planner_a: "root", planner_b: "root" } };
  const template = { id: "template", name: "Plan the feature", description: "Compare approaches.", workflow: "competing_plans", advisorProfileIds: combined.advisorProfileIds, deliveryTarget: "remote_branch", runProjectTests: false, visualEvidence: "capture" };
  const fallback = api.readJsonUnchecked.getMockImplementation()!;
  api.readJsonUnchecked.mockImplementation(async (url: string, init?: RequestInit) => {
    if (url === "/api/workflows?includeArchived=true") return { workflows: [workflow, combined] };
    if (url === "/api/projects/project-1/task-templates") return { templates: [template] };
    return fallback(url, init);
  });
  const { container } = mount();
  await flush();
  await selectOption(container, "Template", "Plan the feature");
  expect(button(container, "Workflow").textContent).toBe("Double plans");
  expect(container.querySelector('[data-workflow-illustration="competing_plans"]')).not.toBeNull();
  await submitTask(container);
  expect(latestRequest("POST")).toMatchObject({ workflow: "competing_plans", description: "Compare approaches.", advisorProfileIds: { planner_a: "root", planner_b: "root" }, deliveryTarget: "remote_branch", visualEvidence: "capture" });
  await selectOption(container, "Workflow", "Plan and build");
  await submitTask(container);
  expect(latestRequest("POST").advisorProfileIds).toEqual({});
});
