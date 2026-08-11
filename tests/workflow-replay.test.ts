import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, test } from "vitest";

import { assertContinuationStateWithinLimit, assertHistoryEventCountWithinLimit, assertPayloadWithinLimit, WORKFLOW_HISTORY_EVENT_LIMIT } from "../src/temporal/policy.js";
import { readReplayHistory, replayIssueHistory } from "../src/temporal/replay.js";

const fixturePath = join(process.cwd(), ".scratch/forge-mvp/replay/issue-workflow-backlog-planning.json");

test("the captured backlog-to-planning history is sanitized and replays through the current Workflow bundle", async () => {
  const history = await readReplayHistory(fixturePath);
  expect(history.events.length).toBeGreaterThan(10);
  await replayIssueHistory(history, "workflow-replay-issue-history");
});

test("an incompatible Workflow history fails the replay gate", async () => {
  const history = await readReplayHistory(fixturePath);
  const incompatible = JSON.parse(JSON.stringify(history)) as typeof history;
  const started = incompatible.events.find((event) => event && typeof event === "object" && "workflowExecutionStartedEventAttributes" in event) as { workflowExecutionStartedEventAttributes?: { workflowType?: { name?: string } } } | undefined;
  if (!started?.workflowExecutionStartedEventAttributes?.workflowType) throw new Error("Fixture has no Workflow start event");
  started.workflowExecutionStartedEventAttributes.workflowType.name = "removedIssueWorkflow";
  await expect(replayIssueHistory(incompatible, "workflow-replay-incompatible")).rejects.toThrow();
});

test("Workflow imports stay deterministic and payload policy rejects oversized boundaries", async () => {
  const workflowSources = await Promise.all(["workflows.ts", "issue-contracts.ts", "contracts.ts", "policy.ts"].map((filename) => readFile(join(process.cwd(), "src/temporal", filename), "utf8")));
  for (const source of workflowSources) {
    expect(source).not.toMatch(/from ["']node:/);
    expect(source).not.toMatch(/@temporalio\/(client|worker|activity)/);
    expect(source).not.toMatch(/\b(Math\.random|randomUUID|process\.|fetch\(|new Date\()/);
  }
  for (const boundary of ["input", "command", "signal", "result", "memo", "search metadata"]) {
    expect(() => assertPayloadWithinLimit(boundary, "x".repeat(32 * 1024))).toThrow(/payload policy/);
  }
  expect(() => assertContinuationStateWithinLimit({ carried: "x".repeat(8 * 1024) })).toThrow(/payload policy/);
  expect(() => assertHistoryEventCountWithinLimit(WORKFLOW_HISTORY_EVENT_LIMIT + 1)).toThrow(/history/);
  expect(() => assertPayloadWithinLimit("small", { issueId: "issue-1", revision: 1 })).not.toThrow();
});
