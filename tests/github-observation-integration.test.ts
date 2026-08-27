import { expect, test, vi } from "vitest";

import { reconcileGithubObservations } from "../src/github-observation-reconciliation.js";
import { buildInitialIssueWorkflowState, IssueWorkflowStateSchema } from "../src/temporal/issue-contracts.js";

const state = IssueWorkflowStateSchema.parse({
  ...buildInitialIssueWorkflowState({ workflowId: "workflow", companyId: "company", projectId: "project", issueId: "task", projectRevisionId: "revision", briefArtifactId: "brief", briefSha256: "a".repeat(64), imageArtifactIds: [], requestHash: "b".repeat(64), roleProfiles: {}, supplementalReview: false, repairCycleLimit: 2 }),
  phase: "ci_waiting", revision: 3, owner: "lead", allowedCommands: ["reconcile_ci"], pendingAction: "Waiting", expectedHeadSha: "a".repeat(40), lastEventId: "workflow:3",
});

function database() {
  return { authQuery: (query: (db: { prepare: () => { all: () => unknown } }) => unknown) => query({ prepare: () => ({ all: () => [{ taskId: "task", companyId: "company", workflowId: "workflow", revision: 3, phase: "ci_waiting", repository: "acme/forge", branch: "forge/task", pullRequestNumber: 1, worktreePath: "/worktrees/task", targetBaseSha: "b".repeat(40), stateJson: JSON.stringify(state) }] }) }) };
}

test("head changes integrate before reconciliation and defer the command during a Developer turn", async () => {
  const integrate = vi.fn(async () => ({ kind: "skipped_active_turn" as const }));
  const execute = vi.fn(async () => ({}));
  const result = await reconcileGithubObservations(database() as never, {} as never, {
    observe: async () => ({ exists: true, number: 1, url: "https://example.invalid/pr/1", state: "open", isDraft: false, headSha: "c".repeat(40), baseSha: "b".repeat(40), mergeable: "CLEAN", autoMergeEnabled: false, reviewDecision: null, checks: { total: 1, pending: 0, failing: 0, successful: 1 } }),
    integrate: integrate as never,
    execute: execute as never,
  });

  expect(integrate).toHaveBeenCalledOnce();
  expect(execute).not.toHaveBeenCalled();
  expect(result.outcomes).toEqual([expect.objectContaining({ observation: "head_changed", integration: "skipped_active_turn", commandKind: null })]);
});
