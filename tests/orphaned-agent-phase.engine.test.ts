import { expect, test } from "vitest";

import { buildInitialIssueWorkflowState, type IssueWorkflowState } from "../src/engine/issue-contracts.js";
import { queryIssueWorkflow, startIssueWorkflow } from "../src/engine/service.js";
import { createEngineHarness, engineFixture } from "./helpers/engine-harness.js";

function input(issueId: string, continuationState: IssueWorkflowState) {
  return {
    companyId: engineFixture.companyId,
    projectId: engineFixture.projectId,
    issueId,
    projectRevisionId: engineFixture.projectRevisionId,
    briefArtifactId: engineFixture.briefArtifactId,
    briefSha256: engineFixture.sha256,
    imageArtifactIds: [],
    roleProfiles: engineFixture.roleProfiles,
    supplementalReview: false,
    continuationState,
  };
}

test("a resumed merge-conflict resolution with no live execution becomes a human recovery state", async () => {
  const h = await createEngineHarness();
  h.seedTask("orphaned-merge-resolution");
  const workflowId = h.workflowId("orphaned-merge-resolution");
  const continuationState = {
    ...buildInitialIssueWorkflowState({ workflowId, companyId: engineFixture.companyId, projectId: engineFixture.projectId, issueId: "orphaned-merge-resolution", projectRevisionId: engineFixture.projectRevisionId, briefArtifactId: engineFixture.briefArtifactId, imageArtifactIds: [], roleProfiles: engineFixture.roleProfiles, supplementalReview: false, requestHash: engineFixture.sha256, repairCycleLimit: 2 }),
    phase: "merge_conflict_resolving" as const,
    revision: 7,
    owner: "lead" as const,
    allowedCommands: ["cancel_development" as const, "cancel_issue" as const],
    activeOperation: { commandId: `${workflowId}:auto-resolve_merge_conflict:7`, kind: "repair" as const, startedRevision: 7 },
    developerExecutionId: "missing-developer-execution",
    developerAttempt: 2,
    lastEventId: `${workflowId}:7`,
  };
  try {
    const started = await startIssueWorkflow(h.config, input("orphaned-merge-resolution", continuationState));
    await h.settle(started.workflowId, (state) => state.phase === "merge_conflict_required" && state.owner === "human");
    expect(await queryIssueWorkflow(h.config, workflowId)).toMatchObject({ phase: "merge_conflict_required", owner: "human", activeOperation: null, allowedCommands: ["resolve_merge_conflict", "cancel_issue"], developerRecoveryStatus: "interrupted" });
  } finally { await h.stop(); }
});

test("a resumed development turn with no live execution becomes the existing developer recovery state", async () => {
  const h = await createEngineHarness();
  h.seedTask("orphaned-development");
  const workflowId = h.workflowId("orphaned-development");
  const continuationState = {
    ...buildInitialIssueWorkflowState({ workflowId, companyId: engineFixture.companyId, projectId: engineFixture.projectId, issueId: "orphaned-development", projectRevisionId: engineFixture.projectRevisionId, briefArtifactId: engineFixture.briefArtifactId, imageArtifactIds: [], roleProfiles: engineFixture.roleProfiles, supplementalReview: false, requestHash: engineFixture.sha256, repairCycleLimit: 2 }),
    phase: "development" as const,
    revision: 7,
    owner: "lead" as const,
    allowedCommands: ["cancel_development" as const, "cancel_issue" as const],
    activeOperation: { commandId: `${workflowId}:auto-start_development:7`, kind: "development" as const, startedRevision: 7 },
    developerExecutionId: "missing-developer-execution",
    developerAttempt: 2,
    lastEventId: `${workflowId}:7`,
  };
  try {
    const started = await startIssueWorkflow(h.config, input("orphaned-development", continuationState));
    await h.settle(started.workflowId, (state) => state.phase === "delivery_blocked" && state.owner === "human");
    expect(await queryIssueWorkflow(h.config, workflowId)).toMatchObject({ phase: "delivery_blocked", owner: "human", activeOperation: null, allowedCommands: ["retry_development", "cancel_issue"], developerRecoveryStatus: "interrupted" });
  } finally { await h.stop(); }
});
