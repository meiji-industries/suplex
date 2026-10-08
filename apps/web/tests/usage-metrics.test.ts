import { describe, expect, it } from "vitest";

import type { TaskUsage } from "../contracts/usage.js";
import { usageMetrics } from "../features/analytics/lib/usage-metrics.js";

function usage(overrides: Partial<TaskUsage>): TaskUsage {
  return {
    sessionId: "session-a",
    messageId: "message-a",
    turnId: "turn-a",
    role: "root",
    provider: "anthropic",
    model: "claude",
    startedAt: 1_000,
    completedAt: 1_000,
    failed: false,
    summary: false,
    steps: 1,
    cost: 0,
    subsidized: false,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    source: "message",
    ...overrides,
  };
}

describe("usageMetrics agent time", () => {
  it("measures a native turn from its first and last point observations", () => {
    const metrics = usageMetrics([
      usage({ messageId: "first", startedAt: 1_000, completedAt: 1_000 }),
      usage({ messageId: "last", startedAt: 6_000, completedAt: 6_000 }),
    ]);

    expect(metrics.durationMs).toBe(5_000);
  });

  it("unions overlapping turns in one session and sums concurrent sessions", () => {
    const metrics = usageMetrics([
      usage({ messageId: "a-start", turnId: "turn-a", startedAt: 0, completedAt: 0 }),
      usage({ messageId: "a-end", turnId: "turn-a", startedAt: 10_000, completedAt: 10_000 }),
      usage({ messageId: "b-start", turnId: "turn-b", startedAt: 5_000, completedAt: 5_000 }),
      usage({ messageId: "b-end", turnId: "turn-b", startedAt: 15_000, completedAt: 15_000 }),
      usage({ sessionId: "session-b", messageId: "c", turnId: "turn-c", startedAt: 2_000, completedAt: 7_000 }),
    ]);

    expect(metrics.durationMs).toBe(20_000);
  });

  it("reports missing timing when native observations cannot form a positive interval", () => {
    const metrics = usageMetrics([
      usage({ completedAt: 1_000 }),
      usage({ messageId: "live", turnId: "turn-live", startedAt: 2_000, completedAt: null }),
    ]);

    expect(metrics.durationMs).toBeNull();
  });
});
