import { expect, test } from "vitest";

import { selectDonePullRequestSyncCandidates } from "../src/done-pull-request-reconciliation.js";
import { buildInitialIssueWorkflowState, IssueWorkflowStateSchema } from "../src/temporal/issue-contracts.js";

function doneState(githubPullRequestState: "open" | "merged" | "closed" | null) {
  return IssueWorkflowStateSchema.parse({ ...buildInitialIssueWorkflowState({ workflowId: "workflow-done-pr", companyId: "company", projectId: "project", issueId: "task", projectRevisionId: "revision", briefArtifactId: "brief", briefSha256: "a".repeat(64), imageArtifactIds: [], requestHash: "b".repeat(64), roleProfiles: {}, supplementalReview: false, repairCycleLimit: 2 }), revision: 4, phase: "done", owner: "human", allowedCommands: [], pendingAction: "Done — draft pull request #42 opened", githubPullRequestState, lastEventId: "workflow-done-pr:4" });
}

test("done pull-request sync selects only open observed pull requests", () => {
  const rows = [
    { taskId: "open", repository: "acme/forge", branch: "forge/open", pullRequestNumber: 42, stateJson: JSON.stringify(doneState("open")) },
    { taskId: "never", repository: "acme/forge", branch: "forge/never", pullRequestNumber: 43, stateJson: JSON.stringify(doneState(null)) },
    { taskId: "merged", repository: "acme/forge", branch: "forge/merged", pullRequestNumber: 44, stateJson: JSON.stringify(doneState("merged")) },
    { taskId: "closed", repository: "acme/forge", branch: "forge/closed", pullRequestNumber: 45, stateJson: JSON.stringify(doneState("closed")) },
  ];
  const database = { authQuery: (query: (db: { prepare: () => { all: () => typeof rows } }) => unknown) => query({ prepare: () => ({ all: () => rows }) }) };
  expect(selectDonePullRequestSyncCandidates(database as never).map(({ taskId }) => taskId)).toEqual(["open", "never"]);
});
