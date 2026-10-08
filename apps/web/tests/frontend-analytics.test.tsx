/** @vitest-environment jsdom */
import { act, createContext, useContext, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { expect, test, vi } from "vitest";

import type { TaskAnalytics } from "../contracts/analytics.js";
import type { TaskUsage } from "../contracts/usage.js";
import type * as usageMetricsModule from "../features/analytics/lib/usage-metrics.js";

const api = vi.hoisted(() => ({ readJsonUnchecked: vi.fn(), withCompany: (path: string) => path }));
vi.mock("../lib/api.js", () => api);
vi.mock("../shell/company-context.js", () => ({ useCompanyContext: () => ({ currentCompany: { id: "company-1" } }) }));
vi.mock("../shell/application-frame.js", () => ({ ApplicationFrame: ({ children }: { children: ReactNode }) => children }));
vi.mock("../features/tasks/task-status.js", () => ({ TaskStatus: ({ status }: { status: string }) => status, taskStatusLabels: { delivered: "Delivered", active: "Active" } }));
vi.mock("../features/analytics/lib/usage-metrics.js", async importOriginal => {
  const actual = await importOriginal<typeof usageMetricsModule>();
  return { ...actual, usageMetrics: vi.fn(actual.usageMetrics), usageIsUnpriced: vi.fn(actual.usageIsUnpriced) };
});
vi.mock("../components/ui/chart.js", () => ({ ChartContainer: ({ children }: { children: ReactNode }) => children, ChartTooltip: () => null, ChartTooltipContent: () => null }));
vi.mock("recharts", () => Object.fromEntries(["Area", "AreaChart", "CartesianGrid", "Pie", "PieChart", "XAxis", "YAxis"].map(name => [name, () => null])));
vi.mock("../components/ui/select.js", () => {
  const context = createContext<(value: string) => void>(() => {});
  return {
    Select: ({ children, onValueChange }: { children: ReactNode; onValueChange: (value: string) => void }) => <context.Provider value={onValueChange}>{children}</context.Provider>,
    SelectTrigger: () => null,
    SelectValue: () => null,
    SelectContent: ({ children }: { children: ReactNode }) => children,
    SelectItem: ({ value, children }: { value: string; children: ReactNode }) => {
      const change = useContext(context);
      return <button data-value={value} onClick={() => change(value)}>{children}</button>;
    },
  };
});

import { AnalyticsView } from "../features/analytics/analytics.js";
import { usageIsUnpriced, usageMetrics } from "../features/analytics/lib/usage-metrics.js";

function usage(overrides: Partial<TaskUsage> = {}): TaskUsage {
  return {
    sessionId: "shared-session", messageId: "message", turnId: "turn", role: "root", provider: "opencode", model: "model",
    startedAt: 0, completedAt: 1_000, failed: false, summary: false, steps: 1, cost: 2, subsidized: true,
    tokens: { input: 10, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, source: "message", ...overrides,
  };
}

function task(id: string, overrides: Partial<TaskAnalytics> = {}): TaskAnalytics {
  return {
    id, title: id, issueKey: null, projectId: "project-1", status: "delivered", deliveryTarget: "pull_request_draft", archived: false,
    createdAt: new Date().toISOString(), usage: [], sessions: 1, observedSessions: 1, staleSessions: 0,
    observedAt: null, observationStartedAt: null, questions: 0, observedWaitMs: 0, deliveryMs: null, ...overrides,
  };
}

test("keeps cohort, partial, and missing-usage values while ledger search and sorting reuse usage calculations", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const tasks = [
    task("Delivered", { usage: [usage(), usage({ messageId: "second", startedAt: 500, completedAt: 1_500, cost: 3 })], deliveryMs: 10_000 }),
    task("Pending", { status: "active", usage: [usage({ messageId: "third", startedAt: 1_000, completedAt: 2_000, cost: 4, subsidized: false }), usage({ sessionId: "incomplete-session", role: "worker", completedAt: null, cost: 0, subsidized: false })], observedSessions: 1, sessions: 2 }),
    task("No usage", { observedSessions: 0 }),
  ];
  api.readJsonUnchecked.mockImplementation(async (path: string) => path.endsWith("/projects") ? { projects: [{ id: "project-1", name: "Project" }] } : { tasks, generatedAt: new Date().toISOString() });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const metric = (label: string) => Array.from(container.querySelectorAll("dt")).find(item => item.textContent === label)?.nextElementSibling;
  const ledger = () => container.querySelector('section[aria-label="Task analytics"]')!;
  const ledgerTitles = () => Array.from(ledger().querySelectorAll("tbody tr td:first-child a")).map(item => item.textContent);
  try {
    await act(async () => root.render(<AnalyticsView />));
    await act(async () => { await import("../features/analytics/analytics-charts.js"); });
    expect(container.querySelector('section[aria-label="Activity"]')?.textContent).toContain("Activity");
    const activityHeatmap = container.querySelector('[role="group"][aria-label="Spend activity by local day"]');
    expect(activityHeatmap?.querySelector('[role="img"][aria-label]')?.getAttribute("aria-label")).toMatch(/^\d{4}-\d{2}-\d{2}: \$0\.00$/);
    expect(metric("Estimated spend")?.textContent).toBe("$9.00");
    expect(metric("Estimated spend")?.querySelector("span")?.title).toContain("partial usage");
    expect(metric("Delivered")?.textContent).toBe("67%");
    expect(metric("Agent turns")?.textContent).toBe("2");
    expect(metric("Agent time")?.textContent).toBe("2s");
    expect(metric("Cost per delivered task")?.textContent).toBe("$5.00");
    expect(metric("Cost per delivered task")?.querySelector("span")?.title).toContain("public models.dev list price");
    expect(metric("Spend on tasks not delivered")?.textContent).toBe("$4.00");
    expect(metric("Messages without completion")?.textContent).toBe("1");
    expect(ledger().textContent).toContain("Not available");
    expect(ledgerTitles()).toEqual(["Delivered", "Pending", "No usage"]);
    expect(container.querySelector('section[aria-label="Project analytics"]')?.textContent).toContain("$9.00");
    const metricsCalls = vi.mocked(usageMetrics).mock.calls.length;
    const chartCalls = vi.mocked(usageIsUnpriced).mock.calls.length;
    expect(chartCalls).toBeGreaterThan(0);

    const input = container.querySelector<HTMLInputElement>('input[aria-label="Search analytics tasks"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "pending");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(ledgerTitles()).toEqual(["Pending"]);
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "");
      input.dispatchEvent(new Event("input", { bubbles: true }));
      container.querySelector<HTMLButtonElement>('[data-value="turns"]')!.click();
    });
    expect(ledgerTitles()).toEqual(["Pending", "Delivered", "No usage"]);
    expect(vi.mocked(usageMetrics).mock.calls).toHaveLength(metricsCalls);
    expect(vi.mocked(usageIsUnpriced).mock.calls).toHaveLength(chartCalls);
    expect(metric("Estimated spend")?.textContent).toBe("$9.00");
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test.each([
  { name: "missing usage", entries: [], expected: "Not available" },
  { name: "unpriced usage", entries: [usage({ cost: 0, subsidized: false })], expected: "Not available" },
  { name: "measured zero cost", entries: [usage({ cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } })], expected: "$0.00" },
])("preserves $name costs", async ({ entries, expected }) => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  api.readJsonUnchecked.mockImplementation(async (path: string) => path.endsWith("/projects") ? { projects: [] } : { tasks: [task("Task", { usage: entries })], generatedAt: new Date().toISOString() });
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    await act(async () => root.render(<AnalyticsView />));
    for (const label of ["Estimated spend", "Cost per delivered task"]) {
      expect(Array.from(container.querySelectorAll("dt")).find(item => item.textContent === label)?.nextElementSibling?.textContent).toBe(expected);
    }
  } finally {
    await act(async () => root.unmount());
  }
});
