// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { Task } from "../src/tasks/contracts.js";

const api = vi.hoisted(() => ({ readJson: vi.fn(), withCompany: (path: string) => path }));
vi.mock("../src/frontend/lib/api.js", () => api);

vi.mock("../src/frontend/components/ui/dialog.js", () => ({
  Dialog: ({ open, children }: { open: boolean; children: React.ReactNode }) => open ? <>{children}</> : null,
  DialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
}));
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
vi.mock("../src/frontend/features/tasks/task-source-picker.js", () => ({ TaskSourcePicker: () => null, prefillForTaskSource: () => ({ title: "", description: "" }) }));
vi.mock("../src/frontend/features/tasks/task-role-selectors.js", () => ({ TaskRoleSelector: ({ role, label }: { role: string; label?: string }) => <span data-role-selector={role}>{label ?? role}</span> }));

import { NewTaskDialog } from "../src/frontend/features/tasks/new-task-dialog.js";

const project = { id: "project-1", name: "Project One", rootProfileId: "root", workerProfileId: "worker", verificationCommand: "" };
const profile = { id: "root", role: "root", provider: "opencode", model: "root", reasoningLevel: "medium", serviceTier: "default" };
const worker = { ...profile, id: "worker", role: "worker", model: "worker" };
const workflow = { id: "workflow_native_standard", name: "Standard", engine: "standard", rootProfileId: "root", workerProfileId: "worker", advisorProfileIds: {}, deliveryTarget: "pull_request_draft", runProjectTests: true, visualEvidence: "off", archivedAt: null };
const active = { id: "task-active", projectId: project.id, title: "Active prerequisite", status: "active", archivedAt: null };
const otherProject = { id: "task-other-project", projectId: "project-2", title: "Other project", status: "active", archivedAt: null };
const backlog = { id: "task-backlog", projectId: project.id, title: "Backlog task", status: "backlog", archivedAt: null };
const archived = { id: "task-archived", projectId: project.id, title: "Archived task", status: "active", archivedAt: "2026-01-01T00:00:00.000Z" };
const delivered = { id: "task-delivered", projectId: project.id, title: "Delivered task", status: "delivered", archivedAt: null };
const cancelled = { id: "task-cancelled", projectId: project.id, title: "Cancelled task", status: "cancelled", archivedAt: null };

function setText(field: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(field, value);
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
  act(() => { root.render(<NewTaskDialog open companyId="company-1" onOpenChange={() => undefined} onCreated={() => undefined} {...(editing ? { editTask: { id: "task-edit" } as Task } : {})} />); });
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

test("New task Blocked by picker filters, selects, clears, and posts its reference", async () => {
  const view = mount();
  await flush();
  expect(view.container.querySelector('[data-role-selector="worker"]')?.nextElementSibling?.getAttribute("aria-label")).toBe("More options");
  await act(async () => { button(view.container, "More options").click(); });
  expect(view.container.querySelectorAll('[role="menuitem"]')).toHaveLength(1);
  await act(async () => { button(view.container, "Blocked by...").click(); });
  await flush();
  expect(view.container.textContent).toContain("Active prerequisite");
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
  expect(view.container.querySelector('[aria-label="Clear blocked by reference"]')).not.toBeNull();

  const title = view.container.querySelector<HTMLInputElement>('[aria-label="Task title"]')!;
  await act(async () => { button(view.container, "Clear blocked by reference").click(); });
  expect(view.container.querySelector('[aria-label="Clear blocked by reference"]')).toBeNull();
  await act(async () => { setText(title, "Create without reference"); title.form?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); await Promise.resolve(); });
  const posts = api.readJson.mock.calls.filter(([url, init]) => url === "/api/companies/company-1/tasks" && init?.method === "POST");
  expect(JSON.parse(posts[0]![1].body)).not.toHaveProperty("blockedByTaskId");

  await act(async () => { button(view.container, "More options").click(); button(view.container, "Blocked by...").click(); });
  await flush();
  await act(async () => { button(view.container, "Backlog task").click(); setText(title, "Create dependent"); title.form?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); await Promise.resolve(); });
  const postsWithReference = api.readJson.mock.calls.filter(([url, init]) => url === "/api/companies/company-1/tasks" && init?.method === "POST");
  expect(JSON.parse(postsWithReference[1]![1].body).blockedByTaskId).toBe("task-backlog");
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
  expect(view.container.textContent).toContain("No matching active or backlog tasks.");
});
