import { expect, test } from "vitest";

import { at, isBlocked } from "../src/issue-phases.js";

import { buildInitialIssueWorkflowState } from "../src/engine/issue-contracts.js";
import { queryIssueWorkflow } from "../src/engine/service.js";
import { createEngineHarness, engineFixture } from "./helpers/engine-harness.js";

test("a resumed merge-conflict resolution with no live execution becomes a human recovery state", async () => {
  const h = await createEngineHarness();
  h.seedTask("orphaned-merge-resolution");
  const workflowId = h.workflowId("orphaned-merge-resolution");
  const continuationState = {
    ...buildInitialIssueWorkflowState({ workflowId, companyId: engineFixture.companyId, projectId: engineFixture.projectId, issueId: "orphaned-merge-resolution", projectRevisionId: engineFixture.projectRevisionId, briefArtifactId: engineFixture.briefArtifactId, imageArtifactIds: [], roleProfiles: engineFixture.roleProfiles, supplementalReview: false, requestHash: engineFixture.sha256, repairCycleLimit: 2 }),
    ...at("merge_conflict_resolving"),
    revision: 7,
    owner: "lead" as const,
    allowedCommands: ["cancel_development" as const, "cancel_issue" as const],
    activeOperation: { commandId: `${workflowId}:auto-resolve_merge_conflict:7`, kind: "repair" as const, startedRevision: 7 },
    developerExecutionId: "missing-developer-execution",
    developerAttempt: 2,
    lastEventId: `${workflowId}:7`,
  };
  try {
    const started = await h.startContinuation("orphaned-merge-resolution", continuationState);
    await h.settle(started.workflowId, (state) => isBlocked(state) && state.step === "merge_conflict_resolving" && state.owner === "human");
    expect(await queryIssueWorkflow(h.config, workflowId)).toMatchObject({ step: "merge_conflict_resolving", owner: "human", activeOperation: null, allowedCommands: ["resolve_merge_conflict", "cancel_issue"], developerRecoveryStatus: "interrupted" });
  } finally { await h.stop(); }
});

test("a resumed development turn with no live execution becomes the existing developer recovery state", async () => {
  const h = await createEngineHarness();
  h.seedTask("orphaned-development");
  const workflowId = h.workflowId("orphaned-development");
  const continuationState = {
    ...buildInitialIssueWorkflowState({ workflowId, companyId: engineFixture.companyId, projectId: engineFixture.projectId, issueId: "orphaned-development", projectRevisionId: engineFixture.projectRevisionId, briefArtifactId: engineFixture.briefArtifactId, imageArtifactIds: [], roleProfiles: engineFixture.roleProfiles, supplementalReview: false, requestHash: engineFixture.sha256, repairCycleLimit: 2 }),
    ...at("development"),
    revision: 7,
    owner: "lead" as const,
    allowedCommands: ["cancel_development" as const, "cancel_issue" as const],
    activeOperation: { commandId: `${workflowId}:auto-start_development:7`, kind: "development" as const, startedRevision: 7 },
    developerExecutionId: "missing-developer-execution",
    developerAttempt: 2,
    lastEventId: `${workflowId}:7`,
  };
  try {
    const started = await h.startContinuation("orphaned-development", continuationState);
    await h.settle(started.workflowId, (state) => isBlocked(state) && state.step === "development" && state.owner === "human");
    expect(await queryIssueWorkflow(h.config, workflowId)).toMatchObject({ step: "development", owner: "human", activeOperation: null, allowedCommands: ["retry_development", "cancel_issue"], developerRecoveryStatus: "interrupted" });
  } finally { await h.stop(); }
});
