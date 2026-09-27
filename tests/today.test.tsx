/**
 * @vitest-environment jsdom
 * @vitest-environment-options { "url": "https://suplex.test/today" }
 */
import { act, createElement, useState, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Today } from "../src/frontend/contracts/today.js";
import type * as todayApiModule from "../src/frontend/features/today/lib/today-api.js";

const state = vi.hoisted(() => ({
  getToday: vi.fn<() => Promise<Today>>(),
  runTaskAction: vi.fn<() => Promise<unknown>>(),
}));

vi.mock("../src/frontend/features/today/lib/today-api.js", async importOriginal => ({
  ...await importOriginal<typeof todayApiModule>(),
  getToday: state.getToday,
}));
vi.mock("../src/frontend/features/tasks/lib/task-api.js", () => ({ runTaskAction: state.runTaskAction }));
vi.mock("../src/frontend/shell/application-frame.js", async () => {
  const React = await import("react");
  return { ApplicationFrame: ({ children }: { children: ReactNode }) => React.createElement("div", null, children) };
});
vi.mock("../src/frontend/shell/company-context.js", () => ({ useCompanyContext: () => ({ selectCompany: vi.fn() }) }));
vi.mock("../src/frontend/components/app/entity-avatar.js", () => ({ EntityAvatar: () => null }));
vi.mock("../src/frontend/features/tasks/task-status.js", () => ({ TaskStatus: () => null }));
vi.mock("../src/frontend/features/tasks/task-question.js", async () => {
  const React = await import("react");
  return { TaskQuestion: ({ question, busy, onAnswer }: { question: { id: string }; busy: boolean; onAnswer: (answer: { answer: string; confirmCommandsStopped: boolean }) => Promise<void> }) => {
    const [draft, setDraft] = useState("");
    return React.createElement("div", null,
      React.createElement("input", { "aria-label": `Draft ${question.id}`, value: draft, onChange: (event: React.ChangeEvent<HTMLInputElement>) => setDraft(event.target.value) }),
      React.createElement("button", { disabled: busy, onClick: () => void onAnswer({ answer: draft, confirmCommandsStopped: false }) }, `Submit ${question.id}`),
    );
  } };
});

import { TodayView } from "../src/frontend/features/today/today.js";
import { currentLocalWeek } from "../src/frontend/features/today/lib/today-api.js";

function response(): Today {
  const question = (taskId: string, companyId: string) => ({ taskId, title: taskId, companyId, companyName: companyId, projectId: `project-${companyId}`, projectName: "Project", issueKey: null, status: "waiting_human" as const, deliveryTarget: "local_worktree" as const, lastUpdated: "2026-09-22T12:00:00.000Z", shippedAt: null, humanQuestion: { kind: "question" as const, id: `q-${taskId}`, text: "Choose", options: [], requiresCommandCleanup: false } });
  return { generatedAt: "2026-09-22T12:00:00.000Z", weekStartsAt: "2026-09-21T04:00:00.000Z", weekEndsAt: "2026-09-28T04:00:00.000Z", companies: [{ id: "a", name: "A" }, { id: "b", name: "B" }], needsYou: [question("a", "a"), question("b", "b")], inProgress: [], shippedThisWeek: [], spendByCompany: [] };
}

describe("Today", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    vi.useFakeTimers();
    state.getToday.mockReset().mockResolvedValue(response());
    state.runTaskAction.mockReset().mockResolvedValue({});
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.useRealTimers();
  });

  it("preserves drafts across polling and submits different questions independently", async () => {
    await act(async () => root.render(createElement(TodayView)));
    const inputs = container.querySelectorAll("input");
    const setValue = (input: HTMLInputElement, value: string): void => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      if (!setter) throw new Error("Input value setter is not available");
      setter.call(input, value);
      input.dispatchEvent(new Event("change", { bubbles: true }));
    };
    await act(async () => {
      setValue(inputs[0]!, "First draft");
      setValue(inputs[1]!, "Second draft");
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect((container.querySelector('[aria-label="Draft q-a"]') as HTMLInputElement).value).toBe("First draft");
    expect((container.querySelector('[aria-label="Draft q-b"]') as HTMLInputElement).value).toBe("Second draft");

    let finishFirst: (() => void) | undefined;
    state.runTaskAction.mockImplementationOnce(() => new Promise(resolve => { finishFirst = () => resolve({}); }));
    const first = Array.from(container.querySelectorAll("button")).find(button => button.textContent === "Submit q-a")!;
    const second = Array.from(container.querySelectorAll("button")).find(button => button.textContent === "Submit q-b")!;
    await act(async () => first.click());
    expect(first.disabled).toBe(true);
    expect(second.disabled).toBe(false);
    await act(async () => second.click());
    expect(state.runTaskAction).toHaveBeenCalledTimes(2);
    expect(state.runTaskAction).toHaveBeenNthCalledWith(1, "a", "answer", { questionId: "q-a", answer: "First draft", confirmCommandsStopped: false });
    expect(state.runTaskAction).toHaveBeenNthCalledWith(2, "b", "answer", { questionId: "q-b", answer: "Second draft", confirmCommandsStopped: false });
    await act(async () => finishFirst?.());
  });

  it("computes a local Monday-to-Monday range", () => {
    const week = currentLocalWeek(new Date(2026, 8, 27, 15, 30));
    const start = new Date(week.startsAt);
    const end = new Date(week.endsAt);
    expect(start.getDay()).toBe(1);
    expect(start.getHours()).toBe(0);
    expect(end.getDay()).toBe(1);
    expect(end.getHours()).toBe(0);
    expect((end.getTime() - start.getTime()) / 3_600_000).toBeGreaterThanOrEqual(167);
    expect((end.getTime() - start.getTime()) / 3_600_000).toBeLessThanOrEqual(169);
  });
});
