import { expect, test } from "vitest";

import { reconcileDonePullRequests, selectDonePullRequestSyncCandidates } from "../src/done-pull-request-reconciliation.js";
import type { GithubPullRequestObservation } from "../src/github-release.js";
import { buildInitialIssueWorkflowState, IssueWorkflowStateSchema } from "../src/engine/issue-contracts.js";
import { createEngineHarness, engineFixture } from "./helpers/engine-harness.js";

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

test("done pull-request reconciliation advances immutable terminal observation history", async () => {
  const harness = await createEngineHarness();
  const issueId = "done-pr-reconciliation", workflowId = harness.workflowId(issueId);
  harness.seedTask(issueId);
  const initial = buildInitialIssueWorkflowState({ workflowId, companyId: engineFixture.companyId, projectId: engineFixture.projectId, issueId, projectRevisionId: engineFixture.projectRevisionId, briefArtifactId: engineFixture.briefArtifactId, briefSha256: engineFixture.sha256, imageArtifactIds: [], requestHash: "b".repeat(64), roleProfiles: engineFixture.roleProfiles, supplementalReview: false, repairCycleLimit: 2 });
  try {
    for (let revision = 0; revision < 4; revision += 1) {
      const state = IssueWorkflowStateSchema.parse({ ...initial, revision, phase: revision === 0 ? "backlog" : "planning", owner: revision === 0 ? "human" : "lead", allowedCommands: revision === 0 ? ["start_planning"] : [], pendingAction: revision === 0 ? "Start planning" : "Lead planning", lastEventId: `${workflowId}:${revision}` });
      harness.database.projectIssueEvent({ schemaVersion: 1, runId: "run-done-pr", eventId: state.lastEventId, state });
    }
    const done = IssueWorkflowStateSchema.parse({ ...initial, revision: 4, phase: "done", owner: "human", allowedCommands: [], pendingAction: "Done — draft pull request #42 opened", releaseRepository: "acme/forge", branchName: "forge/done-pr-reconciliation", pullRequestNumber: 42, githubPullRequestState: "open", lastEventId: `${workflowId}:4` });
    harness.database.projectIssueEvent({ schemaVersion: 1, runId: "run-done-pr", eventId: done.lastEventId, state: done });
    const observed: GithubPullRequestObservation = { exists: true, number: 42, url: "https://github.test/acme/forge/pull/42", state: "merged", isDraft: false, headSha: engineFixture.commit, baseSha: engineFixture.base, mergeable: "MERGEABLE", checks: { total: 1, pending: 0, failing: 0, successful: 1 }, autoMergeEnabled: false, reviewDecision: "APPROVED" };

    await expect(reconcileDonePullRequests(harness.database, { observePullRequest: async () => observed }, () => "2026-08-30T12:00:00.000Z")).resolves.toEqual({ inspected: 1, changed: [{ taskId: issueId, pullRequestNumber: 42, state: "merged" }] });
    expect(harness.database.authQuery((db) => db.prepare("SELECT revision, last_event_id, last_run_id FROM forge_issue_projections WHERE task_id = ?").get(issueId))).toEqual({ revision: 5, last_event_id: `${workflowId}:5`, last_run_id: `${workflowId}:done-pr-reconciliation` });
    const snapshots = harness.database.authQuery((db) => db.prepare("SELECT revision, json_extract(state_json, '$.githubPullRequestState') AS state FROM forge_workflow_snapshots WHERE task_id = ? AND revision >= 4 ORDER BY revision").all(issueId));
    expect(snapshots).toEqual([{ revision: 4, state: "open" }, { revision: 5, state: "merged" }]);
  } finally {
    await harness.stop();
  }
});
