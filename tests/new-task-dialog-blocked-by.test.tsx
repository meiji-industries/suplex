// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { Task } from "../src/tasks/contracts.js";

const api = vi.hoisted(() => ({ readJson: vi.fn(), withCompany: (path: string) => path }));
vi.mock("../src/frontend/lib/api.js", () => api);

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
  };
});
vi.mock("../src/frontend/components/ui/button.js", () => ({ Button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => <button {...props}>{children}</button> }));
vi.mock("../src/frontend/components/ui/new-button.js", () => ({ NewButton: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => <button {...props}>{children}</button> }));
vi.mock("../src/frontend/components/ui/input.js", () => ({ Input: (props: React.InputHTMLAttributes<HTMLInputElement>) => <input {...props} /> }));
vi.mock("../src/frontend/components/ui/textarea.js", () => ({ Textarea: (props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) => <textarea {...props} /> }));
vi.mock("../src/frontend/components/ui/checkbox.js", () => ({ Checkbox: () => <input type="checkbox" /> }));
vi.mock("../src/frontend/components/ui/select.js", () => ({ Select: ({ children }: { children: React.ReactNode }) => <>{children}</>, SelectContent: ({ children }: { children: React.ReactNode }) => <>{children}</>, SelectItem: ({ children }: { children: React.ReactNode }) => <>{children}</>, SelectTrigger: ({ children }: { children: React.ReactNode }) => <button type="button">{children}</button>, SelectValue: () => null }));
vi.mock("../src/frontend/components/ui/inline-attachment-picker.js", () => ({ InlineAttachmentPicker: () => null }));
vi.mock("../src/frontend/components/ui/alert.js", () => ({ Alert: ({ children }: { children: React.ReactNode }) => <div>{children}</div>, AlertDescription: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock("../src/frontend/components/app/entity-avatar.js", () => ({ EntityAvatar: () => null }));
vi.mock("../src/frontend/components/ui/breadcrumb.js", () => ({ Breadcrumb: ({ children }: { children: React.ReactNode }) => <>{children}</>, BreadcrumbItem: ({ children }: { children: React.ReactNode }) => <>{children}</>, BreadcrumbList: ({ children }: { children: React.ReactNode }) => <>{children}</>, BreadcrumbSeparator: () => null }));
vi.mock("../src/frontend/components/ui/radio-group.js", () => ({ RadioGroup: ({ children }: { children: React.ReactNode }) => <>{children}</>, RadioGroupItem: () => <input type="radio" /> }));
vi.mock("../src/frontend/features/tasks/task-source-picker.js", () => ({
  TaskSourcePicker: ({ onSelect }: { onSelect: (source: unknown) => void }) => <button type="button" onClick={() => onSelect({ kind: "issue", issue: { kind: "jira", site: "https://client.atlassian.net", id: "42", key: "APP-42", title: "Fix the picker", url: "https://client.atlassian.net/browse/APP-42" } })}>Select Jira issue</button>,
  issueTaskSource: (issue: unknown) => ({ kind: "issue", issue }),
  prefillForTaskSource: (source: { kind: string; issue?: { title: string; key: string; url: string } }) => source.kind === "issue" ? { title: source.issue!.title, description: `Work on ${source.issue!.key}: ${source.issue!.url}` } : { title: "", description: "" },
}));
vi.mock("../src/frontend/features/tasks/task-role-selectors.js", () => ({ TaskRoleSelector: ({ role, label }: { role: string; label?: string }) => <span data-role-selector={role}>{label ?? role}</span> }));

import { NewTaskDialog } from "../src/frontend/features/tasks/new-task-dialog.js";

const project = { id: "project-1", name: "Project One", rootProfileId: "root", workerProfileId: "worker", verificationCommand: "" };
const profile = { id: "root", role: "root", provider: "opencode", model: "root", reasoningLevel: "medium", serviceTier: "default" };
const worker = { ...profile, id: "worker", role: "worker", model: "worker" };
const workflow = { id: "workflow_native_standard", name: "Standard", engine: "standard", rootProfileId: "root", workerProfileId: "worker", advisorProfileIds: {}, deliveryTarget: "pull_request_draft", runProjectTests: true, visualEvidence: "off", archivedAt: null };
const active = { id: "task-active", projectId: project.id, title: "Active prerequisite", status: "active", archivedAt: null, queue: { state: "running" } };
const otherProject = { id: "task-other-project", projectId: "project-2", title: "Other project", status: "active", archivedAt: null, queue: { state: "running" } };
const backlog = { id: "task-backlog", projectId: project.id, title: "Backlog task", status: "backlog", archivedAt: null, queue: { state: "backlog" } };
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

function mount(editing = false) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => { root.render(<NewTaskDialog open companyId="company-1" onOpenChange={() => undefined} onCreated={() => undefined} {...(editing ? { editTask: { id: "task-edit", configuration: {} } as Task } : {})} />); });
  return { container, root };
}

async function flush() {
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
}

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  api.readJson.mockReset();
  api.readJson.mockImplementation(async (url: string, init?: RequestInit) => {
    if (url === "/api/companies/company-1/tasks" && init?.method === "POST") return { id: "created" };
    if (url === "/api/companies/company-1/projects") return { projects: [project] };
    if (url === "/api/profiles") return { profiles: [profile, worker] };
    if (url === "/api/workflows?includeArchived=true") return { workflows: [workflow] };
    if (url === "/api/projects/project-1/task-templates") return { templates: [] };
    if (url === "/api/companies/company-1/tasks") return { tasks: [active, otherProject, backlog, archived, delivered, cancelled] };
    throw new Error(`Unexpected request: ${url}`);
  });
});
afterEach(async () => { await act(async () => { document.body.replaceChildren(); }); });

test("New task Blocked by picker filters, selects several, removes one, and posts the rest as dependsOn", async () => {
  const view = mount();
  await flush();
  expect(view.container.querySelector('[aria-label="More options"]')).not.toBeNull();
  await act(async () => { button(view.container, "More options").click(); });
  expect(view.container.querySelectorAll('[role="menuitem"]')).toHaveLength(1);
  await act(async () => { button(view.container, "Blocked by...").click(); });
  await flush();
  expect(view.container.textContent).toContain("Active prerequisite");
  expect(view.container.textContent).not.toContain("task-active");
  expect(view.container.textContent).toContain("Backlog task");
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
  const posts = () => api.readJson.mock.calls.filter(([url, init]) => url === "/api/companies/company-1/tasks" && init?.method === "POST").map(([, init]) => JSON.parse(init.body));
  expect(posts()[0]).not.toHaveProperty("dependsOn");
  expect(posts()[0]).not.toHaveProperty("blockedByTaskId");

  for (const name of ["Active prerequisite", "Backlog task"]) {
    await act(async () => { button(view.container, "More options").click(); button(view.container, "Blocked by...").click(); });
    await flush();
    await act(async () => { button(view.container, name).click(); });
  }
  expect(view.container.querySelectorAll("[data-blocked-by-selection]")).toHaveLength(2);
  // A selected task is not offered again.
  await act(async () => { button(view.container, "More options").click(); button(view.container, "Blocked by...").click(); });
  await flush();
  expect(view.container.querySelector('[aria-label="Search tasks"]')!.parentElement!.textContent).not.toContain("Backlog task");
  await act(async () => { button(view.container, "Close").click(); });
  await act(async () => { button(view.container, "Remove Active prerequisite from Blocked by").click(); });
  await act(async () => { button(view.container, "More options").click(); button(view.container, "Blocked by...").click(); });
  await flush();
  await act(async () => { button(view.container, "Active prerequisite").click(); setText(title, "Create dependent"); title.form?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); await Promise.resolve(); });
  expect(posts()[1].dependsOn).toEqual(["task-backlog", "task-active"]);
  expect(posts()[1]).not.toHaveProperty("blockedByTaskId");
});

test("New from stores the selected Jira issue on the create request", async () => {
  const view = mount();
  await flush();
  expect(view.container.textContent).not.toContain("IssueNone");
  await act(async () => { button(view.container, "Select Jira issue").click(); });
  const title = view.container.querySelector<HTMLInputElement>('[aria-label="Task title"]')!;
  expect(title.value).toBe("Fix the picker");
  await act(async () => { title.form?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); await Promise.resolve(); });
  const post = api.readJson.mock.calls.filter(([url, init]) => url === "/api/companies/company-1/tasks" && init?.method === "POST").at(-1);
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
  await act(async () => { button(view.container, "More options").click(); });
  await act(async () => { button(view.container, "Blocked by...").click(); });
  await flush();
  await act(async () => { button(view.container, "Active prerequisite").click(); });
  await act(async () => { button(view.container, "More options").click(); });
  await act(async () => { button(view.container, "Blocked by...").click(); });
  await flush();
  expect(view.container.querySelector('[aria-label="Search tasks"]')).not.toBeNull();
  await act(async () => { button(view.container, "Close").click(); });
  expect(view.container.querySelector('[aria-label="Search tasks"]')).toBeNull();
  expect(title.value).toBe("Dependent task");
  expect(description.value).toBe("Wait for the prerequisite");
  expect(view.container.textContent).toContain("Blocked by Active prerequisite");
});

test("More options is absent when editing a task", async () => {
  const view = mount(true);
  await flush();
  expect(view.container.querySelector('[aria-label="More options"]')).toBeNull();
});

test("the picker reports an empty task result", async () => {
  const view = mount();
  await flush();
  await act(async () => { button(view.container, "More options").click(); });
  await act(async () => { button(view.container, "Blocked by...").click(); });
  await flush();
  const search = view.container.querySelector<HTMLInputElement>('[aria-label="Search tasks"]')!;
  await act(async () => { setText(search, "nothing"); });
  expect(view.container.textContent).toContain("No matching backlog, queued, or active tasks.");
});
