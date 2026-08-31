import { expect, test } from "vitest";

import { buildInitialIssueWorkflowState, type IssueWorkflowState } from "../src/engine/issue-contracts.js";
import { runExecution, type RunExecutionContext } from "../src/engine/registry.js";
import type { IssueWorkflowContext } from "../src/engine/workflow/context.js";
import { autoRetryDeliveryBlocker, canAutoRetryDeliveryBlocker, createAcquireExternalTurn } from "../src/engine/workflow/runtime.js";

test("simple capacity admission preserves the current pending action", async () => {
  let state: IssueWorkflowState = {
    ...buildInitialIssueWorkflowState({
      workflowId: "workflow-simple-capacity",
      companyId: "company-simple-capacity",
      projectId: "project-simple-capacity",
      issueId: "task-simple-capacity",
      projectRevisionId: "revision-simple-capacity",
      briefArtifactId: "brief-simple-capacity",
      briefSha256: "a".repeat(64),
      imageArtifactIds: [],
      requestHash: "b".repeat(64),
      roleProfiles: {},
      supplementalReview: false,
    }),
    phase: "planning",
    owner: "lead",
    pendingAction: "Lead planning",
  };
  const projected: IssueWorkflowState[] = [];
  const acquireExternalTurn = createAcquireExternalTurn(
    {
      get: () => state,
      set: (next) => {
        state = next;
      },
    },
    {
      projectState: async (next) => {
        projected.push(next);
        return next;
      },
    },
  );

  await expect(acquireExternalTurn(
    { operation: "lead_planning", role: "planner" },
    async (capacityRequestId) => capacityRequestId,
    () => undefined,
  )).resolves.toBeUndefined();

  expect(state).toMatchObject({
    revision: 1,
    lastEventId: "workflow-simple-capacity:1",
    pendingAction: "Lead planning",
  });
  expect(projected).toEqual([state]);
});

function automaticRetryExecution(waits: number[]): RunExecutionContext {
  return {
    workflowId: "workflow-target-base-retry",
    runId: "run-target-base-retry",
    signal: new AbortController().signal,
    commands: new Map(),
    queries: new Map(),
    interrupts: new Map(),
    acceptedInterrupt: undefined,
    interruptResult: undefined,
    async activity() { throw new Error("Unexpected activity"); },
    async wait(milliseconds) { waits.push(milliseconds); },
    now: () => 0,
    wake() {},
    autoActionsHalted: () => false,
  };
}

function targetBaseDriftState(overrides: Partial<IssueWorkflowState> = {}): IssueWorkflowState {
  return {
    ...buildInitialIssueWorkflowState({
      workflowId: "workflow-target-base-retry",
      companyId: "company-target-base-retry",
      projectId: "project-target-base-retry",
      issueId: "task-target-base-retry",
      projectRevisionId: "revision-target-base-retry",
      briefArtifactId: "brief-target-base-retry",
      briefSha256: "a".repeat(64),
      imageArtifactIds: [],
      requestHash: "b".repeat(64),
      roleProfiles: {},
      supplementalReview: false,
    }),
    phase: "delivery_blocked",
    owner: "human",
    allowedCommands: ["publish_draft", "cancel_issue", "retry_target_base_reconciliation"],
    pendingAction: "Target base moved after delivery review",
    targetBaseCheckId: "check-target-base-retry",
    targetBaseCheckpoint: "pre_release",
    releaseFailureCode: "target-base-drift",
    ...overrides,
  };
}

function targetBaseRetryContext(
  state: IssueWorkflowState,
  retries: string[],
  projections: IssueWorkflowState[],
): IssueWorkflowContext {
  const context = {
    input: {},
    state,
    async project() {
      projections.push(context.state);
      return context.state;
    },
    commandAlreadyProcessed(commandId: string) {
      return (context.state.processedCommandIds ?? []).includes(commandId);
    },
    markCommandProcessed(commandId: string) {
      context.state = {
        ...context.state,
        processedCommandIds: [...(context.state.processedCommandIds ?? []), commandId],
      };
    },
    async retryTargetBaseReconciliation(command: { commandId: string }) {
      retries.push(command.commandId);
      expect(context.state.pendingAction).toBe("Target base moved; reconciling automatically before publishing.");
      return context.state;
    },
  };
  return context as unknown as IssueWorkflowContext;
}

test("target-base drift without a check scopes the first retry to the result commit", async () => {
  const waits: number[] = [];
  const retries: string[] = [];
  const resultCommit = "c".repeat(40);
  const context = targetBaseRetryContext(targetBaseDriftState({
    targetBaseCheckId: null,
    resultCommit,
  }), retries, []);

  await runExecution.run(automaticRetryExecution(waits), async () => {
    expect(canAutoRetryDeliveryBlocker(context)).toBe(true);
    await expect(autoRetryDeliveryBlocker(context)).resolves.toBe(true);
  });

  expect(waits).toEqual([30_000]);
  expect(retries).toEqual([
    `workflow-target-base-retry:auto-retry:retry_target_base_reconciliation:${resultCommit}:1`,
  ]);
});

test("target-base reconciliation precedes delivery review and retains capped backoff", async () => {
  const waits: number[] = [];
  const retries: string[] = [];
  const projections: IssueWorkflowState[] = [];
  const context = targetBaseRetryContext(targetBaseDriftState({
    allowedCommands: ["review_delivery", "cancel_issue", "retry_target_base_reconciliation"],
  }), retries, projections);

  await runExecution.run(automaticRetryExecution(waits), async () => {
    expect(canAutoRetryDeliveryBlocker(context)).toBe(true);
    await expect(autoRetryDeliveryBlocker(context)).resolves.toBe(true);
    await expect(autoRetryDeliveryBlocker(context)).resolves.toBe(true);
    await expect(autoRetryDeliveryBlocker(context)).resolves.toBe(true);
    expect(canAutoRetryDeliveryBlocker(context)).toBe(false);
  });

  expect(waits).toEqual([30_000, 120_000, 300_000]);
  expect(retries).toEqual([
    "workflow-target-base-retry:auto-retry:retry_target_base_reconciliation:check-target-base-retry:1",
    "workflow-target-base-retry:auto-retry:retry_target_base_reconciliation:check-target-base-retry:2",
    "workflow-target-base-retry:auto-retry:retry_target_base_reconciliation:check-target-base-retry:3",
  ]);
  expect(projections).toHaveLength(4);
  expect(projections.map(({ revision, pendingAction, processedCommandIds }) => ({ revision, pendingAction, attempts: processedCommandIds?.length }))).toEqual([
    { revision: 1, pendingAction: "Target base moved after delivery review", attempts: 1 },
    { revision: 2, pendingAction: "Target base moved; reconciling automatically before publishing.", attempts: 1 },
    { revision: 3, pendingAction: "Target base moved; reconciling automatically before publishing.", attempts: 2 },
    { revision: 4, pendingAction: "Target base moved; reconciling automatically before publishing.", attempts: 3 },
  ]);
  expect(projections.every(({ blocker }) => blocker === null)).toBe(true);
});

test("other auto-retry candidate pairs remain human decisions", async () => {
  const waits: number[] = [];
  const retries: string[] = [];
  const context = targetBaseRetryContext(targetBaseDriftState({
    allowedCommands: ["repair_delivery", "cancel_issue", "retry_target_base_reconciliation"],
    resultCommit: "e".repeat(40),
  }), retries, []);

  await runExecution.run(automaticRetryExecution(waits), async () => {
    expect(canAutoRetryDeliveryBlocker(context)).toBe(false);
    await expect(autoRetryDeliveryBlocker(context)).resolves.toBe(false);
  });

  expect(waits).toEqual([]);
  expect(retries).toEqual([]);
});

test("exhausted target-base retries report reconciliation failure once", async () => {
  const waits: number[] = [];
  const retries: string[] = [];
  const projections: IssueWorkflowState[] = [];
  const resultCommit = "d".repeat(40);
  const retryPrefix = `workflow-target-base-retry:auto-retry:retry_target_base_reconciliation:${resultCommit}:`;
  const context = targetBaseRetryContext(targetBaseDriftState({
    targetBaseCheckId: null,
    resultCommit,
    processedCommandIds: [`${retryPrefix}1`, `${retryPrefix}2`, `${retryPrefix}3`],
  }), retries, projections);

  await runExecution.run(automaticRetryExecution(waits), async () => {
    expect(canAutoRetryDeliveryBlocker(context)).toBe(false);
    await expect(autoRetryDeliveryBlocker(context)).resolves.toBe(true);
    await expect(autoRetryDeliveryBlocker(context)).resolves.toBe(false);
  });

  expect(waits).toEqual([]);
  expect(retries).toEqual([]);
  expect(projections).toHaveLength(1);
  expect(context.state).toMatchObject({
    owner: "human",
    allowedCommands: ["retry_target_base_reconciliation", "cancel_issue"],
    pendingAction: "The target base moved. Automatic reconciliation did not succeed. You can retry the reconciliation.",
  });
});

test("recorded human blocker actions prevent unrelated automatic retries", async () => {
  const waits: number[] = [];
  const retries: string[] = [];
  const context = targetBaseRetryContext(targetBaseDriftState({
    allowedCommands: ["retry_development", "cancel_issue", "retry_target_base_reconciliation"],
    pendingAction: "Automatic continuation is not making progress: steps 5 remain after 2 turns",
    blocker: {
      category: "agent_exhausted",
      summary: "Automatic continuation is not making progress: steps 5 remain after 2 turns",
      unblockOwner: "human",
      actions: [
        { command: "retry_development", label: "Retry development", requiresNote: false, destructive: false },
        { command: "cancel_issue", label: "Cancel issue", requiresNote: false, destructive: true },
      ],
      evidence: { artifactId: "artifact-agent-exhausted", kind: "developer-repair" },
      createdAt: "2026-08-30T00:00:00.000Z",
      retry: null,
    },
  }), retries, []);

  await runExecution.run(automaticRetryExecution(waits), async () => {
    expect(canAutoRetryDeliveryBlocker(context)).toBe(false);
    await expect(autoRetryDeliveryBlocker(context)).resolves.toBe(false);
  });

  expect(waits).toEqual([]);
  expect(retries).toEqual([]);
});
