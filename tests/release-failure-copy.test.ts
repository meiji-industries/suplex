import { expect, test } from "vitest";

import { at } from "../src/issue-phases.js";
import { buildInitialIssueWorkflowState, type IssueWorkflowState } from "../src/engine/issue-contracts.js";
import { runExecution, type RunExecutionContext } from "../src/engine/registry.js";
import type { IssueWorkflowContext } from "../src/engine/workflow/context.js";
import { autoRetryDeliveryBlocker } from "../src/engine/workflow/runtime.js";
import { evidencePointer, humanBlocker } from "../src/engine/workflow/state-transitions.js";
import { ReleaseFailureCodeSchema, releaseFailureCopy } from "../src/release-failures.js";

const genericProviderSummary = "The provider failure continued after the automatic retries.";

function automaticRetryExecution(): RunExecutionContext {
  return {
    workflowId: "workflow-release-failure-copy",
    runId: "run-release-failure-copy",
    signal: new AbortController().signal,
    commands: new Map(),
    queries: new Map(),
    interrupts: new Map(),
    acceptedInterrupt: undefined,
    interruptResult: undefined,
    async activity() { throw new Error("Unexpected activity"); },
    async wait() { throw new Error("Unexpected wait"); },
    now: () => 0,
    wake() {},
    autoActionsHalted: () => false,
  };
}

function exhaustedReleaseState(releaseFailureSummary?: string): IssueWorkflowState {
  const resultCommit = "c".repeat(40);
  const state = {
    ...buildInitialIssueWorkflowState({
      workflowId: "workflow-release-failure-copy",
      companyId: "company-release-failure-copy",
      projectId: "project-release-failure-copy",
      issueId: "task-release-failure-copy",
      projectRevisionId: "revision-release-failure-copy",
      briefArtifactId: "brief-release-failure-copy",
      briefSha256: "a".repeat(64),
      imageArtifactIds: [],
      requestHash: "b".repeat(64),
      roleProfiles: {},
      supplementalReview: false,
    }),
    ...at("delivery_ready"),
    owner: "human" as const,
    allowedCommands: ["review_delivery" as const, "cancel_issue" as const],
    pendingAction: "Forge retries the release.",
    releaseFailureSummary,
    resultCommit,
    deliveryRepairBlockerEvidenceArtifactId: "release-failure-evidence",
    processedCommandIds: [1, 2, 3].map((attempt) => `workflow-release-failure-copy:auto-retry:review_delivery:${resultCommit}:${attempt}`),
    blocker: humanBlocker("provider_connectivity_exhausted", genericProviderSummary, [{ command: "review_delivery", label: "Retry now", requiresNote: false, destructive: false }, { command: "cancel_issue", label: "Cancel the task", requiresNote: false, destructive: true }], evidencePointer("release-failure-evidence", "attention-evidence")),
  };
  return state;
}

test.each(ReleaseFailureCodeSchema.options)("an exhausted %s release failure keeps its owner summary", async (code) => {
  const context = {
    input: {},
    state: exhaustedReleaseState(releaseFailureCopy[code]),
    async project() { return context.state; },
    commandAlreadyProcessed(commandId: string) { return context.state.processedCommandIds?.includes(commandId) ?? false; },
    markCommandProcessed() {},
  } as unknown as IssueWorkflowContext;

  await runExecution.run(automaticRetryExecution(), async () => {
    await expect(autoRetryDeliveryBlocker(context)).resolves.toBe(true);
  });

  expect(context.state.pendingAction).toBe(releaseFailureCopy[code]);
  expect(context.state.blocker?.summary).toBe(releaseFailureCopy[code]);
  expect(context.state.pendingAction).not.toBe(genericProviderSummary);
  expect(context.state.blocker?.summary).not.toBe(genericProviderSummary);
});

test("an exhausted release failure without a persisted summary uses the generic provider summary", async () => {
  const context = {
    input: {},
    state: exhaustedReleaseState(),
    async project() { return context.state; },
    commandAlreadyProcessed(commandId: string) { return context.state.processedCommandIds?.includes(commandId) ?? false; },
    markCommandProcessed() {},
  } as unknown as IssueWorkflowContext;

  await runExecution.run(automaticRetryExecution(), async () => {
    await expect(autoRetryDeliveryBlocker(context)).resolves.toBe(true);
  });

  expect(context.state.pendingAction).toBe(genericProviderSummary);
  expect(context.state.blocker?.summary).toBe(genericProviderSummary);
});
