import { afterEach, expect, test, vi } from "vitest";

import { agentRuntimeDetail, agentRuntimeSummary, animateReorderedAgentRow } from "../src/frontend/components/app/agents-leaderboard.js";
import type { ApiAgentRuntime } from "../src/frontend/lib/view-shared.js";

const originalWindow = globalThis.window;
const originalElement = globalThis.Element;

afterEach(() => {
  Object.defineProperty(globalThis, "window", { configurable: true, value: originalWindow });
  Object.defineProperty(globalThis, "Element", { configurable: true, value: originalElement });
});

test("only animates rows whose rendered order changes", () => {
  const animate = vi.fn();
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { matchMedia: () => ({ matches: false }) },
  });
  class MockElement {}
  Object.defineProperty(MockElement.prototype, "animate", { value: animate });
  Object.defineProperty(globalThis, "Element", { configurable: true, value: MockElement });
  const rows = {
    alpha: new MockElement(),
    bravo: new MockElement(),
    charlie: new MockElement(),
  } as unknown as Record<string, Element>;
  const firstRender: Record<string, { index: number; top: number }> = {
    alpha: { index: 0, top: 0 },
    bravo: { index: 1, top: 36 },
    charlie: { index: 2, top: 72 },
  };

  for (const [id, position] of Object.entries(firstRender)) animateReorderedAgentRow(rows[id]!, undefined, position);
  for (const [id, position] of Object.entries(firstRender)) animateReorderedAgentRow(rows[id]!, position, position);
  expect(animate).not.toHaveBeenCalled();

  const swappedRender: Record<string, { index: number; top: number }> = {
    alpha: { index: 1, top: 36 },
    bravo: { index: 0, top: 0 },
    charlie: { index: 2, top: 72 },
  };
  for (const [id, position] of Object.entries(swappedRender)) animateReorderedAgentRow(rows[id]!, firstRender[id], position);

  expect(animate).toHaveBeenCalledTimes(2);
  expect(animate).toHaveBeenNthCalledWith(1, [{ transform: "translateY(-36px)" }, { transform: "translateY(0)" }], { duration: 240, easing: "ease-out" });
  expect(animate).toHaveBeenNthCalledWith(2, [{ transform: "translateY(36px)" }, { transform: "translateY(0)" }], { duration: 240, easing: "ease-out" });
});

test("runtime summary prioritizes working entries and detail preserves every assignment", () => {
  const agent = { lastSeenAt: "2026-08-31T00:00:00.000Z" };
  const runtime = [
    { agentId: "agent", taskId: "task-review", role: "reviewer", paneId: "pane-review", liveStatus: "active", diagnosis: "resting", detail: "Resting" },
    { agentId: "agent", taskId: "task-build", role: "builder", paneId: "pane-build", liveStatus: "active", diagnosis: "working", detail: "Working" },
    { agentId: "agent", taskId: "task-plan", role: "planner", paneId: "pane-plan", liveStatus: "active", diagnosis: "blocked", detail: "Blocked" },
  ] satisfies ApiAgentRuntime[];

  expect(agentRuntimeSummary(agent, [])).toMatch(/^Last seen /);
  expect(agentRuntimeSummary(agent, [{ ...runtime[1]! }])).toBe("builder · Working");
  expect(agentRuntimeSummary(agent, runtime)).toBe("builder · Working +2 more");
  expect(agentRuntimeDetail(agent, runtime)).toContain("task-review");
  expect(agentRuntimeDetail(agent, runtime)).toContain("task-build");
  expect(agentRuntimeDetail(agent, runtime)).toContain("task-plan");
});
