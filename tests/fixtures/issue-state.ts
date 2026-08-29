import { buildInitialIssueWorkflowState, IssueWorkflowStateSchema, type IssueWorkflowState } from "../../src/engine/issue-contracts.js";

export const initialIssueWorkflowInput = {
  workflowId: "workflow-installation-issue-task-recovery",
  companyId: "company-recovery",
  projectId: "project-recovery",
  issueId: "task-recovery",
  projectRevisionId: "revision-recovery",
  briefArtifactId: "artifact-brief",
  briefSha256: "a".repeat(64),
  imageArtifactIds: [],
  requestHash: "b".repeat(64),
  roleProfiles: { planner: "profile-planner" },
  supplementalReview: false,
  repairCycleLimit: 2,
  stateChangedAt: "2026-08-11T00:00:00.000Z",
};

// The ONLY hand-written IssueWorkflowState literal in the test suite. New state
// fields with creation-time values are added HERE and nowhere else.
export function expectedInitialIssueWorkflowState(): IssueWorkflowState {
  return IssueWorkflowStateSchema.parse({
    workflowId: initialIssueWorkflowInput.workflowId,
    companyId: initialIssueWorkflowInput.companyId,
    projectId: initialIssueWorkflowInput.projectId,
    issueId: initialIssueWorkflowInput.issueId,
    projectRevisionId: initialIssueWorkflowInput.projectRevisionId,
    requestHash: initialIssueWorkflowInput.requestHash,
    phase: "backlog",
    revision: 0,
    owner: "human",
    allowedCommands: ["start_planning"],
    pendingAction: "Start planning",
    lastEventId: `${initialIssueWorkflowInput.workflowId}:0`,
    continuationCount: 0,
    lastSummaryHash: null,
    repairCycle: 0,
    blocker: null,
    stateChangedAt: initialIssueWorkflowInput.stateChangedAt,
    activeOperation: null,
    processedCommandIds: [],
  });
}

export function initialStateFixture(): IssueWorkflowState {
  return buildInitialIssueWorkflowState(initialIssueWorkflowInput);
}
