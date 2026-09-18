/**
 * @vitest-environment happy-dom
 * @vitest-environment-options { "url": "https://forge.test/tasks?company=company-1" }
 */
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";

vi.mock("../src/frontend/components/ui/sidebar.js", () => {
  const box = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return { SidebarGroup: box, SidebarGroupContent: box, SidebarGroupLabel: box, SidebarMenu: box, SidebarMenuItem: box, SidebarMenuButton: ({ render, tooltip }: { render: ReactNode; tooltip: string }) => <div data-tooltip={tooltip}>{render}</div> };
});
vi.mock("../src/frontend/features/tasks/lib/task-list.js", () => ({
  readTaskList: async () => [{ id: "task-3", title: "Ship the release", status: "backlog", statusChangedAt: "2026-09-09T00:00:00.000Z", pullRequest: null, archivedAt: null, blockedBy: [{ id: "task-1", title: "Repair the poller", status: "active" }, { id: "task-2", title: "Plan the migration", status: "delivered" }] }],
}));
vi.mock("../src/frontend/features/analytics/lib/analytics.js", () => ({ useTaskCosts: () => new Map() }));
vi.mock("../src/frontend/features/tasks/recent-task-agents.js", () => ({ RecentTaskAgents: () => null }));
vi.mock("../src/frontend/features/tasks/recent-pull-request.js", () => ({ RecentPullRequest: () => null }));
vi.mock("../src/frontend/shell/company-context.js", () => ({ useOptionalCompanyContext: () => ({ currentCompany: { id: "company-1", status: "active" } }) }));

import { RecentTasks } from "../src/frontend/features/tasks/recent-tasks.js";

afterEach(async () => { await act(async () => { document.body.replaceChildren(); }); });

test("Activity labels every Blocked by task of a recent task", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => { root.render(<RecentTasks />); });
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
  const label = "Blocked by Repair the poller · Active, Plan the migration · Delivered";
  expect(container.querySelector("[data-recent-task-blocked-by]")?.textContent).toBe(` · ${label}`);
  expect(container.querySelector("a")?.getAttribute("aria-label")).toBe(`Ship the release, Backlog, ${label}`);
  expect(container.querySelector("[data-tooltip]")?.getAttribute("data-tooltip")).toBe(`Ship the release · ${label}`);
  await act(async () => { root.unmount(); });
});
