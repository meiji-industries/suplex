import { describe, expect, it } from "vitest";

import { createDeveloperLiveStatusReporter, developerLiveStatus } from "../src/developer-live-status.js";

describe("developerLiveStatus", () => {
  it("maps Codex JSONL milestones to concise status text", () => {
    expect(developerLiveStatus(JSON.stringify({ type: "item.started", item: { type: "reasoning" } }))).toBe("Thinking");
    expect(developerLiveStatus(JSON.stringify({ type: "item.started", item: { type: "command_execution", command: "pnpm vitest run tests/developer-live-status.test.ts" } }))).toBe("Running: pnpm vitest run tests/developer-live-status.test.ts");
    expect(developerLiveStatus(JSON.stringify({ type: "item.completed", item: { type: "agent_message" } }))).toBe("Developer finished; awaiting verification");
    expect(developerLiveStatus(JSON.stringify({ type: "turn.completed" }))).toBe("Developer finished; awaiting verification");
  });

  it("debounces stream updates for two seconds", () => {
    let clock = 0;
    const statuses: string[] = [];
    const reporter = createDeveloperLiveStatusReporter((status) => { if (status) statuses.push(status); }, () => clock);
    reporter.report(JSON.stringify({ type: "item.started", item: { type: "reasoning" } }));
    reporter.report(JSON.stringify({ type: "item.started", item: { type: "command_execution", command: "pnpm test" } }));
    clock = 2_000;
    reporter.report(JSON.stringify({ type: "item.started", item: { type: "command_execution", command: "pnpm test" } }));
    expect(statuses).toEqual(["Thinking", "Running: pnpm test"]);
  });
});
