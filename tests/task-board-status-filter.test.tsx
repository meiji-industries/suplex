/**
 * @vitest-environment happy-dom
 * @vitest-environment-options { "url": "https://forge.test/board?company=company-1" }
 */
import { act, createContext, useContext, useRef, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";

import type { Task } from "../src/tasks/contracts.js";

const api = vi.hoisted(() => ({ readJson: vi.fn(), withCompany: (path: string) => path }));
vi.mock("../src/frontend/lib/api.js", () => api);
vi.mock("../src/frontend/shell/company-context.js", () => ({ useCompanyContext: () => ({ currentCompany: { id: "company-1", status: "active" } }) }));
vi.mock("../src/frontend/shell/application-frame.js", () => ({ ApplicationFrame: ({ children }: { children: ReactNode }) => children }));
vi.mock("../src/frontend/shell/global-new-task-dialog.js", () => ({ requestNewTask: vi.fn() }));
vi.mock("../src/frontend/features/analytics/lib/analytics.js", async importOriginal => ({ ...(await importOriginal<Record<string, unknown>>()), useTaskCosts: () => new Map() }));
vi.mock("../src/frontend/features/tasks/task-details.js", () => ({ TaskDetailsPage: () => null }));
vi.mock("../src/frontend/features/tasks/task-options.js", () => ({ TaskOptions: () => null }));
vi.mock("../src/frontend/components/ui/select.js", () => {
  const context = createContext<{ value?: string | undefined; onValueChange?: ((value: string) => void) | undefined; label: { current: string } }>({ label: { current: "" } });
  return {
    Select: ({ value, onValueChange, children }: { value?: string | undefined; onValueChange?: (value: string) => void; children: ReactNode }) => {
      const label = useRef("");
      return <context.Provider value={{ value, onValueChange, label }}>{children}</context.Provider>;
    },
    SelectTrigger: ({ children, ...props }: { children: ReactNode; "aria-label"?: string }) => {
      const { label } = useContext(context);
      label.current = props["aria-label"] ?? "";
      return <div {...props}>{children}</div>;
    },
    SelectValue: ({ children }: { children?: ReactNode | ((value: string) => ReactNode) }) => {
      const { value } = useContext(context);
      return typeof children === "function" ? children(value ?? "") : children;
    },
    SelectContent: ({ children }: { children: ReactNode }) => children,
    SelectItem: ({ value, children }: { value: string; children: ReactNode }) => {
      const { onValueChange, label } = useContext(context);
      return <button type="button" data-select={label.current} data-value={value} onClick={() => onValueChange?.(value)}>{children}</button>;
    },
  };
});

import { TasksView } from "../src/frontend/features/tasks/tasks.js";

const profile = { profileId: "profile", provider: "opencode", model: "model", reasoningLevel: "medium", serviceTier: "default" } as const;
function task(id: string, title: string, status: Task["status"]): Task {
  return {
    id, companyId: "company-1", projectId: "project-1", issueKey: null, title, description: "", status, deliveryTarget: "pull_request_draft",
    rootProfile: profile, workerProfile: profile, workflow: "standard", advisorProfiles: {}, workflowState: { version: 1, reviews: [], acceptedDelivery: null, deliveryWait: null, completion: null },
    configuration: { repository: "meiji-industries/forge", repositoryPath: "/repo", worktreeRoot: "/worktrees", branch: id, baseBranch: "main", baselineSha: "a".repeat(40), startingSha: "a".repeat(40), setupCommand: "", verificationCommand: "", runProjectTests: true, visualEvidence: "off", source: null, capturedAt: "2026-09-08T00:00:00.000Z" },
    worktree: null, pullRequest: null, humanQuestion: null, blockedBy: [], limits: { budgetUsd: 15, maxTurns: 40, admittedTurns: 0 }, wakeAt: null, images: [],
    dependsOn: [], createdAt: "2026-09-08T00:00:00.000Z", updatedAt: "2026-09-08T00:00:00.000Z", statusChangedAt: "2026-09-08T00:00:00.000Z", archivedAt: null,
  };
}

afterEach(async () => {
  vi.useRealTimers();
  await act(async () => { document.body.replaceChildren(); });
});

test("the board status filter narrows the visible columns and tasks", async () => {
  const tasks = [task("task-1", "Repair the poller", "active"), task("task-2", "Plan the migration", "backlog")];
  api.readJson.mockImplementation(async (path: string) => path.includes("/projects") ? { projects: [] } : { tasks });
  const container = document.createElement("div");
  document.body.append(container);
  await act(async () => { createRoot(container).render(<TasksView mode="board" />); });

  const trigger = () => container.querySelector<HTMLElement>('[aria-label="Filter by status"]');
  const iconThenLabel = () => [trigger()?.firstElementChild?.tagName.toLowerCase(), trigger()?.textContent];
  const columns = () => Array.from(container.querySelectorAll("section")).map(section => section.getAttribute("aria-label"));
  expect(iconThenLabel()).toEqual(["svg", "All statuses"]);
  expect(columns()).toEqual(["Backlog", "Active"]);
  expect(container.textContent).toContain("Plan the migration");

  const option = container.querySelector<HTMLButtonElement>('[data-select="Filter by status"][data-value="active"]');
  expect(option).not.toBeNull();
  await act(async () => { option?.click(); });

  expect(columns()).toEqual(["Active"]);
  expect(iconThenLabel()).toEqual(["svg", "Active"]);
  expect(container.textContent).toContain("Repair the poller");
  expect(container.textContent).not.toContain("Plan the migration");

  await act(async () => { container.querySelector<HTMLButtonElement>('[data-select="Filter by status"][data-value="all"]')?.click(); });
  expect(columns()).toEqual(["Backlog", "Active"]);
});

test("board cards and list rows label every Blocked by task from the same prerequisite list", async () => {
  const blocked = { ...task("task-3", "Ship the release", "backlog"), dependsOn: ["task-1", "task-2"], blockedBy: [{ id: "task-1", title: "Repair the poller", status: "active" as const }, { id: "task-2", title: "Plan the migration", status: "delivered" as const }] };
  const tasks = [task("task-1", "Repair the poller", "active"), blocked];
  api.readJson.mockImplementation(async (path: string) => path.includes("/projects") ? { projects: [] } : { tasks });
  for (const mode of ["board", "list"] as const) {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => { root.render(<TasksView mode={mode} />); });
    expect(Array.from(container.querySelectorAll("[data-task-blocked-by]")).map(label => label.textContent)).toEqual(["Blocked by Repair the poller · Active, Plan the migration · Delivered"]);
    await act(async () => { root.unmount(); container.remove(); });
  }
});
