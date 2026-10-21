/** @vitest-environment jsdom */
import { act, createContext, useContext, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { expect, test, vi } from "vitest";

import type { TaskAnalytics } from "../contracts/analytics.js";
import type { TaskUsage } from "../contracts/usage.js";
import type * as usageMetricsModule from "../features/analytics/lib/usage-metrics.js";

const api = vi.hoisted(() => ({ readJsonUnchecked: vi.fn(), withCompany: (path: string) => path }));
vi.mock("../lib/api.js", () => api);
vi.mock("../shell/company-context.js", () => ({ useCompanyContext: () => ({ currentCompany: { id: "company-1" } }), useOptionalCompanyContext: () => null }));
vi.mock("../shell/application-frame.js", () => ({ ApplicationFrame: ({ children, headerRight }: { children: ReactNode; headerRight?: ReactNode }) => <>{headerRight}{children}</> }));
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
import { dateInputValue } from "../components/app/date-range.js";
import { usageIsUnpriced, usageMetrics } from "../features/analytics/lib/usage-metrics.js";
import { saveUsageDisplay } from "../features/analytics/lib/usage-display.js";

function usage(overrides: Partial<TaskUsage> = {}): TaskUsage {
  return {
    sessionId: "shared-session", messageId: "message", turnId: "turn", role: "root", provider: "opencode", model: "model",
    startedAt: 0, completedAt: 1_000, failed: false, summary: false, steps: 1, cost: 2, subsidized: true,
    tokens: { input: 10, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, source: "message", generationMs: null, firstResponseMs: null, ...overrides,
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

test("shows token counts and token labels in place of spend when the usage display is Tokens", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const tokens = (input: number) => ({ input, output: 0, reasoning: 0, cache: { read: 0, write: 0 } });
  const tasks = [
    task("Delivered", { usage: [usage({ tokens: tokens(80_000) }), usage({ messageId: "second", cost: 3, tokens: tokens(200) })] }),
    task("Pending", { status: "active", usage: [usage({ messageId: "third", cost: 0, subsidized: false, tokens: tokens(919_800) })] }),
    task("No usage", { observedSessions: 0 }),
  ];
  api.readJsonUnchecked.mockImplementation(async (path: string) => path.endsWith("/projects") ? { projects: [{ id: "project-1", name: "Project" }] } : { tasks, generatedAt: new Date().toISOString() });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const metric = (label: string) => Array.from(container.querySelectorAll("dt")).find(item => item.textContent === label)?.nextElementSibling;
  const headers = (section: string) => Array.from(container.querySelectorAll(`section[aria-label="${section}"] th`)).map(item => item.textContent);
  const createObjectURL = vi.fn((_blob: Blob) => "blob:analytics");
  Object.assign(URL, { createObjectURL, revokeObjectURL: vi.fn() });
  const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  try {
    saveUsageDisplay("tokens");
    await act(async () => root.render(<AnalyticsView />));
    await act(async () => { await import("../features/analytics/analytics-charts.js"); });
    expect(metric("Estimated spend")).toBeUndefined();
    expect(metric("Token usage")?.textContent).toBe("1M");
    expect(metric("Token usage")?.querySelector("span")?.title).toContain("Total tokens");
    expect(metric("Token usage")?.nextElementSibling?.textContent).toBe("2 of 3 tasks with usage · tokens");
    expect(metric("Tokens per delivered task")?.textContent).toBe("80.2K");
    expect(metric("Token usage on tasks not delivered")?.textContent).toBe("920K");
    expect(container.querySelector('section[aria-label="Token usage over time"] h2')?.textContent).toBe("Token usage over time");
    expect(container.querySelector('section[aria-label="Token usage over time"]')?.textContent).toContain("Tokens · UTC days");
    expect(headers("Task analytics")).toEqual(["Task", "Status", "Coordinator / Delegated turns", "Agent time", "Output tokens/s", "Median first response", "Tokens", "Coverage"]);
    expect(headers("Project analytics")).toEqual(["Project", "Delivered / Total", "Turns", "Agent time", "Tokens"]);
    expect(container.querySelector('section[aria-label="Project analytics"] tbody tr')?.lastElementChild?.textContent).toBe("1M");
    expect(container.querySelector('[data-value="cost"]')?.textContent).toBe("Most tokens");
    expect(Array.from(container.querySelectorAll('section[aria-label="Task analytics"] tbody tr td:first-child a')).map(item => item.textContent)).toEqual(["Pending", "Delivered", "No usage"]);

    await act(async () => Array.from(container.querySelectorAll("button")).find(button => button.textContent === "Export CSV")!.click());
    const csv = await createObjectURL.mock.calls[0]![0].text();
    const [header, first] = csv.split("\r\n");
    expect(header).toBe("Task,Status,Tokens,Coordinator turns,Delegated turns,Agent seconds,Output tokens per second,Median first response ms");
    expect(first?.startsWith('"Pending","active","919800","1","0","1",')).toBe(true);

    await act(async () => { saveUsageDisplay("spend"); });
    expect(metric("Token usage")).toBeUndefined();
    expect(metric("Estimated spend")?.textContent).toBe("$5.00");
    expect(headers("Task analytics")).toEqual(["Task", "Status", "Coordinator / Delegated turns", "Tokens", "Agent time", "Output tokens/s", "Median first response", "Est. USD", "Coverage"]);
    expect(container.querySelector('[data-value="cost"]')?.textContent).toBe("Highest cost");
  } finally {
    saveUsageDisplay("spend");
    click.mockRestore();
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

test("narrows every analytics cohort to tasks created in the date range and project", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const daysAgo = (days: number) => { const date = new Date(); date.setDate(date.getDate() - days); return date.toISOString(); };
  const tasks = [
    task("Recent", { createdAt: daysAgo(0), usage: [usage({ tokens: { input: 10, output: 20, reasoning: 0, cache: { read: 0, write: 0 } }, generationMs: 1_000, firstResponseMs: 200 })] }),
    task("Last week", { createdAt: daysAgo(5), projectId: "project-2", usage: [usage({ messageId: "second", cost: 3, tokens: { input: 10, output: 40, reasoning: 0, cache: { read: 0, write: 0 } }, generationMs: 1_000, firstResponseMs: 600 })] }),
    task("Old", { createdAt: daysAgo(40), usage: [usage({ messageId: "third", cost: 5 })] }),
  ];
  api.readJsonUnchecked.mockImplementation(async (path: string) => path.endsWith("/projects") ? { projects: [{ id: "project-1", name: "Project" }, { id: "project-2", name: "Other" }] } : { tasks, generatedAt: new Date().toISOString() });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const metric = (label: string) => Array.from(container.querySelectorAll("dt")).find(item => item.textContent === label)?.nextElementSibling;
  const ledgerTitles = () => Array.from(container.querySelectorAll('section[aria-label="Task analytics"] tbody tr td:first-child a')).map(item => item.textContent);
  const setDate = async (label: string, value: string) => {
    const input = container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  };
  const dateValue = (days: number) => dateInputValue(new Date(daysAgo(days)));
  const modelRow = () => {
    const table = Array.from(container.querySelectorAll("section")).find(section => section.querySelector("h2")?.textContent === "Models")!.querySelector("table")!;
    const headers = Array.from(table.querySelectorAll("thead th")).map(cell => cell.textContent);
    const cells = Array.from(table.querySelectorAll("tbody tr:first-child td")).map(cell => cell.textContent);
    return { rate: cells[headers.indexOf("Output tokens/s")], firstResponse: cells[headers.indexOf("Median first response")] };
  };
  try {
    await act(async () => root.render(<AnalyticsView />));
    expect(container.querySelector('[aria-label="Creation period"]')).toBeNull();
    expect(container.querySelector<HTMLInputElement>('input[aria-label="Creation start date"]')?.value).toBe(dateValue(29));
    expect(container.querySelector<HTMLInputElement>('input[aria-label="Creation end date"]')?.value).toBe(dateValue(0));
    expect(ledgerTitles()).toEqual(["Last week", "Recent"]);
    expect(metric("Estimated spend")?.textContent).toBe("$5.00");
    expect(modelRow()).toEqual({ rate: "30.0", firstResponse: "400 ms" });

    await setDate("Creation start date", dateValue(45));
    expect(ledgerTitles()).toEqual(["Old", "Last week", "Recent"]);
    expect(metric("Estimated spend")?.textContent).toBe("$10.00");
    // The untimed old task leaves the timed values unchanged.
    expect(modelRow()).toEqual({ rate: "30.0", firstResponse: "400 ms" });

    await setDate("Creation end date", dateValue(1));
    expect(ledgerTitles()).toEqual(["Old", "Last week"]);
    expect(metric("Estimated spend")?.textContent).toBe("$8.00");
    expect(modelRow()).toEqual({ rate: "40.0", firstResponse: "600 ms" });

    await setDate("Creation start date", dateValue(45));
    await setDate("Creation end date", dateValue(30));
    expect(ledgerTitles()).toEqual(["Old"]);
    expect(modelRow()).toEqual({ rate: "Not available", firstResponse: "Not available" });
    await setDate("Creation end date", dateValue(1));

    await act(async () => container.querySelector<HTMLButtonElement>('[data-value="project-2"]')!.click());
    expect(ledgerTitles()).toEqual(["Last week"]);
    await act(async () => container.querySelectorAll<HTMLButtonElement>('[data-value="all"]')[0]!.click());
    expect(ledgerTitles()).toEqual(["Old", "Last week"]);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test("shows model timing in the ledger and the CSV export", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const output = (value: number) => ({ input: 10, output: value, reasoning: 0, cache: { read: 0, write: 0 } });
  const tasks = [
    task("Timed", { usage: [usage({ tokens: output(30), generationMs: 2_000, firstResponseMs: 1_500 }), usage({ messageId: "second", tokens: output(50), generationMs: 2_000, firstResponseMs: 500 })] }),
    task("Untimed", { usage: [usage({ messageId: "third", cost: 1 })] }),
  ];
  api.readJsonUnchecked.mockImplementation(async (path: string) => path.endsWith("/projects") ? { projects: [] } : { tasks, generatedAt: new Date().toISOString() });
  const blobs: Blob[] = [];
  const createObjectURL = vi.fn((blob: Blob) => { blobs.push(blob); return "blob:analytics"; });
  Object.assign(URL, { createObjectURL, revokeObjectURL: vi.fn() });
  const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<AnalyticsView />));
    const ledger = container.querySelector('section[aria-label="Task analytics"] table')!;
    const headers = Array.from(ledger.querySelectorAll("thead th")).map(cell => cell.textContent);
    const row = (title: string) => {
      const cells = Array.from(Array.from(ledger.querySelectorAll("tbody tr")).find(item => item.querySelector("a")?.textContent === title)!.querySelectorAll("td")).map(cell => cell.textContent);
      return [cells[headers.indexOf("Output tokens/s")], cells[headers.indexOf("Median first response")]];
    };
    expect(row("Timed")).toEqual(["20.0", "1.0s"]);
    expect(row("Untimed")).toEqual(["Not available", "Not available"]);

    await act(async () => Array.from(container.querySelectorAll("button")).find(button => button.textContent === "Export CSV")!.click());
    expect(click).toHaveBeenCalled();
    const [header, ...lines] = (await blobs[0]!.text()).split("\r\n");
    expect(header).toBe("Task,Status,Estimated USD,Coordinator turns,Delegated turns,Tokens,Agent seconds,Output tokens per second,Median first response ms");
    const columns = (line: string) => line.split(",").slice(-2);
    expect(lines.map(columns)).toEqual([['"20"', '"1000"'], ['""', '""']]);
  } finally {
    click.mockRestore();
    await act(async () => root.unmount());
    container.remove();
  }
});
