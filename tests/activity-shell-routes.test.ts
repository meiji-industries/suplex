/**
 * @vitest-environment jsdom
 * @vitest-environment-options { "url": "https://suplex.test/tasks?company=company-a" }
 */
import { act, createElement, useEffect, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { notifyManager } from "@tanstack/react-query";
import type * as taskListModule from "../src/frontend/features/tasks/lib/task-list.js";

type TaskRow = { id: string; title: string; status: "backlog"; queue: { waitingOn: [] }; statusChangedAt: string; pullRequest: null; archivedAt: null; blockedBy: [] };

const state = vi.hoisted(() => ({
  companyId: "company-a",
  sidebarMounts: 0,
  sidebarUnmounts: 0,
  viewMounts: [] as string[],
  readTaskList: vi.fn<(companyId: string) => Promise<TaskRow[]>>(),
}));

vi.mock("../src/frontend/components/ui/sidebar.js", async () => {
  const React = await import("react");
  const box = ({ children }: { children?: ReactNode }) => React.createElement("div", null, children);
  return {
    SidebarProvider: box,
    SidebarInset: box,
    SidebarGroup: box,
    SidebarGroupContent: box,
    SidebarGroupLabel: box,
    SidebarMenu: box,
    SidebarMenuItem: box,
    SidebarMenuButton: ({ render, children }: { render?: ReactNode; children?: ReactNode }) => React.createElement("div", null, render ?? children),
    SidebarTrigger: () => React.createElement("button"),
  };
});
vi.mock("../src/frontend/features/tasks/lib/task-list.js", async importOriginal => ({ ...await importOriginal<typeof taskListModule>(), readTaskList: state.readTaskList }));
vi.mock("../src/frontend/features/analytics/lib/analytics.js", () => ({ useTaskCosts: () => new Map() }));
vi.mock("../src/frontend/features/tasks/recent-task-agents.js", () => ({ RecentTaskAgents: () => null }));
vi.mock("../src/frontend/features/tasks/recent-pull-request.js", () => ({ RecentPullRequest: () => null }));
vi.mock("../src/frontend/features/tasks/task-status.js", () => ({ TaskStatusIcon: () => null, taskStatusLabels: { backlog: "Backlog" }, taskStatusLabel: () => "Backlog" }));
vi.mock("../src/frontend/components/app/cost-value.js", () => ({ CostValue: () => null }));
vi.mock("../src/frontend/components/app/system-health.js", async () => {
  const React = await import("react");
  return { SystemHealthProvider: ({ children }: { children: ReactNode }) => React.createElement(React.Fragment, null, children), SystemHealthAlert: () => null };
});
vi.mock("../src/frontend/components/app/update-provider.js", async () => {
  const React = await import("react");
  return { UpdateProvider: ({ children }: { children: ReactNode }) => React.createElement(React.Fragment, null, children) };
});
vi.mock("../src/frontend/components/app/update-notice.js", () => ({ UpdateNotice: () => null }));
vi.mock("../src/frontend/components/app/theme.js", () => ({ ThemeToggle: () => null }));
vi.mock("../src/frontend/shell/global-new-task-dialog.js", () => ({ GlobalNewTaskDialog: () => null }));
vi.mock("../src/frontend/shell/company-context.js", async () => {
  const React = await import("react");
  return {
    CompanyProvider: ({ children }: { children: ReactNode }) => React.createElement(React.Fragment, null, children),
    useCompanyContext: () => ({ user: { id: "user-a" }, currentCompany: { id: state.companyId, status: "active" } }),
    useOptionalCompanyContext: () => ({ currentCompany: { id: state.companyId, status: "active" } }),
  };
});
vi.mock("../src/frontend/shell/navigation.js", async () => {
  const React = await import("react");
  const { RecentTasks } = await import("../src/frontend/features/tasks/recent-tasks.js");
  return {
    AppSidebar: () => {
      useEffect(() => {
        state.sidebarMounts += 1;
        return () => { state.sidebarUnmounts += 1; };
      }, []);
      return React.createElement(RecentTasks);
    },
  };
});

function view(name: string) {
  return () => {
    useEffect(() => { state.viewMounts.push(`${name}:${window.location.pathname}`); }, []);
    return createElement(ApplicationFrame, { title: name, children: createElement("main", { "data-view": name }, window.location.pathname) });
  };
}

function settingsView(name: string) {
  return () => createElement(ApplicationFrame, {
    title: name,
    sidebar: createElement("aside", { "data-settings-sidebar": name }, "Settings sidebar"),
    children: createElement("main", { "data-view": name }, window.location.pathname),
  });
}

vi.mock("../src/frontend/features/auth/auth.js", () => ({ AuthView: view("auth") }));
vi.mock("../src/frontend/features/admin/admin.js", () => ({ AdminView: view("admin") }));
vi.mock("../src/frontend/features/settings/company-settings.js", () => ({ CompanySettingsView: view("company-settings") }));
vi.mock("../src/frontend/features/profiles/profile.js", () => ({ ProfileView: settingsView("profile") }));
vi.mock("../src/frontend/features/tasks/dashboard.js", () => ({ Dashboard: view("dashboard") }));
vi.mock("../src/frontend/features/projects/projects.js", () => ({ ProjectsView: view("projects") }));
vi.mock("../src/frontend/features/tasks/tasks.js", () => ({ TasksView: view("tasks") }));
vi.mock("../src/frontend/features/timeline/timeline.js", () => ({ TimelineView: view("timeline") }));
vi.mock("../src/frontend/features/analytics/analytics.js", () => ({ AnalyticsView: view("analytics") }));
vi.mock("../src/frontend/features/settings/task-template-settings.js", () => ({ TaskTemplateSettings: view("templates") }));
vi.mock("../src/frontend/features/settings/provider-settings.js", () => ({ ProviderSettingsView: view("providers") }));
vi.mock("../src/frontend/features/settings/environment-settings.js", () => ({ EnvironmentSettingsView: view("environment") }));
vi.mock("../src/frontend/features/settings/workflow-settings.js", () => ({ WorkflowSettingsView: view("workflows") }));
vi.mock("../src/frontend/features/settings/trigger-settings.js", () => ({ TriggerSettingsView: view("triggers") }));

import { AppRouter } from "../src/frontend/shell/app-router.js";
import { ApplicationFrame } from "../src/frontend/shell/application-frame.js";

function task(id: string, title: string): TaskRow {
  return { id, title, status: "backlog", queue: { waitingOn: [] }, statusChangedAt: "2026-09-09T00:00:00.000Z", pullRequest: null, archivedAt: null, blockedBy: [] };
}

function navigate(path: string, event = "suplex:navigate"): void {
  window.history.pushState({}, "", path);
  window.dispatchEvent(new Event(event));
}

describe("Activity shell lifecycle", () => {
  let container: HTMLDivElement;
  let root: Root;
  let mounted: boolean;

  beforeEach(async () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    notifyManager.setScheduler(queueMicrotask);
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ tasks: [] })));
    vi.useFakeTimers();
    state.companyId = "company-a";
    state.sidebarMounts = 0;
    state.sidebarUnmounts = 0;
    state.viewMounts = [];
    state.readTaskList.mockReset();
    window.history.replaceState({}, "", "/tasks?company=company-a");
    Object.assign(window, { __SUPLEX_VIEW__: undefined, __SUPLEX_HEALTH__: undefined });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    mounted = true;
  });

  afterEach(async () => {
    if (mounted) await act(async () => root.unmount());
    container.remove();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    notifyManager.setScheduler(callback => setTimeout(callback, 0));
  });

  it("retains Activity through list, detail, cross-view, and history navigation while replacing the main view", async () => {
    state.readTaskList.mockResolvedValue([task("task-a", "First task")]);

    await act(async () => root.render(createElement(AppRouter)));
    expect(container.textContent).toContain("First task");
    expect(container.querySelector("main")?.textContent).toBe("/tasks");
    expect(state.sidebarMounts).toBe(1);

    await act(async () => navigate("/tasks/task-a?company=company-a"));
    await act(async () => navigate("/tasks/task-b?company=company-a"));
    await act(async () => navigate("/timeline?company=company-a"));
    await act(async () => navigate("/tasks/task-a?company=company-a", "popstate"));

    expect(container.textContent).toContain("First task");
    expect(container.querySelector("main")?.textContent).toBe("/tasks/task-a");
    expect(state.sidebarMounts).toBe(1);
    expect(state.viewMounts).toEqual(["tasks:/tasks", "tasks:/tasks/task-a", "tasks:/tasks/task-b", "timeline:/timeline", "tasks:/tasks/task-a"]);
  });

  it("uses the settings sidebar outside the Activity shell", async () => {
    state.readTaskList.mockResolvedValue([task("task-a", "First task")]);

    await act(async () => root.render(createElement(AppRouter)));
    expect(container.textContent).toContain("First task");
    expect(state.sidebarMounts).toBe(1);

    await act(async () => navigate("/profile?company=company-a"));
    expect(container.querySelector("[data-settings-sidebar=profile]")?.textContent).toBe("Settings sidebar");
    expect(container.textContent).not.toContain("First task");
    expect(state.sidebarUnmounts).toBe(1);
  });

  it("polls once after navigation, updates Activity, and discards an obsolete company response", async () => {
    let resolveCompanyA: ((tasks: TaskRow[]) => void) | undefined;
    let resolveCompanyB: ((tasks: TaskRow[]) => void) | undefined;
    state.readTaskList.mockImplementation((companyId) => new Promise((resolve) => {
      if (companyId === "company-a") resolveCompanyA = resolve;
      else resolveCompanyB = resolve;
    }));

    await act(async () => root.render(createElement(AppRouter)));
    expect(state.readTaskList).toHaveBeenCalledTimes(1);
    await act(async () => resolveCompanyA?.([task("task-a", "First task")]));
    expect(container.textContent).toContain("First task");

    await act(async () => navigate("/tasks/task-a?company=company-a"));
    await act(async () => vi.advanceTimersByTimeAsync(3_000));
    expect(state.readTaskList).toHaveBeenCalledTimes(2);
    await act(async () => resolveCompanyA?.([task("task-a", "Updated task")]));
    expect(container.textContent).toContain("Updated task");

    await act(async () => vi.advanceTimersByTimeAsync(3_000));
    expect(state.readTaskList).toHaveBeenCalledTimes(3);
    state.companyId = "company-b";
    await act(async () => root.render(createElement(AppRouter)));
    expect(state.readTaskList).toHaveBeenCalledTimes(4);
    expect(container.textContent).not.toContain("Updated task");
    await act(async () => resolveCompanyA?.([task("task-a", "Obsolete task")]));
    expect(container.textContent).not.toContain("Obsolete task");
    await act(async () => resolveCompanyB?.([task("task-b", "Company B task")]));
    expect(container.textContent).toContain("Company B task");
    expect(state.sidebarMounts).toBe(1);

    await act(async () => vi.advanceTimersByTimeAsync(3_000));
    expect(state.readTaskList).toHaveBeenCalledTimes(5);
    await act(async () => root.unmount());
    mounted = false;
    await act(async () => vi.advanceTimersByTimeAsync(3_000));
    expect(state.readTaskList).toHaveBeenCalledTimes(5);
  });
});
