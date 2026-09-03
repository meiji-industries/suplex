import { afterEach, expect, test, vi } from "vitest";

import { AGENT_RECENCY_WINDOW_MS, agentRuntimeDetail, agentRuntimeSummary, animateReorderedAgentRow, filterRecentAgents } from "../src/frontend/components/app/agents-leaderboard.js";
import type { ApiAgent, ApiAgentRuntime } from "../src/frontend/lib/view-shared.js";

const originalWindow = globalThis.window;
const originalElement = globalThis.Element;

function agent(id: string, lastSeenAt: string): ApiAgent {
  return { id, name: id, role: "planner", avatarSeed: id, profileId: `${id}-profile`, provider: "codex", model: "gpt-5.6-sol", reasoningLevel: "medium", servicePriority: "standard", capacity: null, effectiveCapacity: 2, archivedAt: null, activeCount: 0, lastSeenAt, createdAt: lastSeenAt, updatedAt: lastSeenAt };
}

afterEach(() => {
  Object.defineProperty(globalThis, "window", { configurable: true, value: originalWindow });
  Object.defineProperty(globalThis, "Element", { configurable: true, value: originalElement });
});

test("keeps sidebar agents seen within the inclusive six-hour window", () => {
  const now = Date.parse("2026-09-03T12:00:00.000Z");
  const recent = agent("recent", "2026-09-03T06:00:00.001Z");
  const cutoff = agent("cutoff", "2026-09-03T06:00:00.000Z");
  const stale = agent("stale", "2026-09-03T05:59:59.999Z");

  expect(filterRecentAgents([recent], now)).toEqual([recent]);
  expect(filterRecentAgents([cutoff], now)).toEqual([cutoff]);
  expect(filterRecentAgents([stale], now)).toEqual([]);
});

test("filters stale agents from mixed and all-stale sidebar lists", () => {
  const now = Date.parse("2026-09-03T12:00:00.000Z");
  const recent = agent("recent", "2026-09-03T06:00:00.001Z");
  const cutoff = agent("cutoff", "2026-09-03T06:00:00.000Z");
  const stale = agent("stale", "2026-09-03T05:59:59.999Z");

  expect(filterRecentAgents([recent, stale, cutoff], now)).toEqual([recent, cutoff]);
  expect(filterRecentAgents([stale], now)).toEqual([]);
  expect(AGENT_RECENCY_WINDOW_MS).toBe(6 * 60 * 60 * 1_000);
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
