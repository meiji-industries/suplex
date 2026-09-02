import { expect, test, vi } from "vitest";

import { reconcileGithubObservations } from "../src/github-observation-reconciliation.js";
import { buildInitialIssueWorkflowState, IssueWorkflowStateSchema } from "../src/engine/issue-contracts.js";
import { at } from "../src/issue-phases.js";

const state = IssueWorkflowStateSchema.parse({
  ...buildInitialIssueWorkflowState({ workflowId: "workflow", companyId: "company", projectId: "project", issueId: "task", projectRevisionId: "revision", briefArtifactId: "brief", briefSha256: "a".repeat(64), imageArtifactIds: [], requestHash: "b".repeat(64), roleProfiles: {}, supplementalReview: false, repairCycleLimit: 2 }),
  ...at("ci_waiting"), revision: 3, owner: "lead", allowedCommands: ["reconcile_ci"], pendingAction: "Waiting", expectedHeadSha: "a".repeat(40), lastEventId: "workflow:3",
});

function database() {
  return { authQuery: (query: (db: { prepare: () => { all: () => unknown } }) => unknown) => query({ prepare: () => ({ all: () => [{ taskId: "task", companyId: "company", workflowId: "workflow", revision: 3, phase: "ci_waiting", repository: "acme/forge", branch: "forge/task", pullRequestNumber: 1, worktreePath: "/worktrees/task", targetBaseSha: "b".repeat(40), stateJson: JSON.stringify(state) }] }) }) };
}

test("head changes integrate before reconciliation and defer the command during a Developer turn", async () => {
  const integrate = vi.fn(async () => ({ kind: "skipped_active_turn" as const }));
  const execute = vi.fn(async (_config, _workflowId, _command, input) => {
    state.processedCommandIds = [input.commandId];
    return {};
  });
  const result = await reconcileGithubObservations(database() as never, {} as never, {
    observe: async () => ({ exists: true, number: 1, url: "https://example.invalid/pr/1", state: "open", isDraft: false, headSha: "c".repeat(40), baseSha: "b".repeat(40), mergeable: "CLEAN", autoMergeEnabled: false, reviewDecision: null, checks: { total: 1, pending: 0, failing: 0, successful: 1 } }),
    integrate: integrate as never,
    execute: execute as never,
  });

  expect(integrate).toHaveBeenCalledOnce();
  expect(execute).not.toHaveBeenCalled();
  expect(result.outcomes).toEqual([expect.objectContaining({ observation: "head_changed", integration: "skipped_active_turn", commandKind: null })]);
});

test("a remote branch conflict dispatches its durable merge-resolution command once", async () => {
  const integrate = vi.fn(async () => ({ kind: "conflict" as const, remoteHead: "c".repeat(40), forwardMergeId: "merge_remote", conflictArtifactId: "artifact_remote", conflictFileCount: 1 }));
  const execute = vi.fn(async (_config, _workflowId, _command, input) => {
    state.processedCommandIds = [input.commandId];
    return {};
  });
  const conflictDatabase = {
    authQuery: (query: (db: { prepare: () => { all: () => unknown; get: () => unknown } }) => unknown) => query({ prepare: () => ({
      all: () => [{ taskId: "task", companyId: "company", workflowId: "workflow", revision: 3, phase: "ci_waiting", repository: "acme/forge", branch: "forge/task", pullRequestNumber: 1, worktreePath: "/worktrees/task", targetBaseSha: "b".repeat(40), stateJson: JSON.stringify(state) }],
      get: () => ({ priorHead: "a".repeat(40), priorTree: "d".repeat(40) }),
    }) }),
  };
  const result = await reconcileGithubObservations(conflictDatabase as never, {} as never, {
    observe: async () => ({ exists: true, number: 1, url: "https://example.invalid/pr/1", state: "open", isDraft: false, headSha: "c".repeat(40), baseSha: "b".repeat(40), mergeable: "CONFLICTING", autoMergeEnabled: false, reviewDecision: null, checks: { total: 1, pending: 0, failing: 0, successful: 1 } }),
    integrate: integrate as never,
    execute: execute as never,
  });

  expect(execute).toHaveBeenCalledWith(expect.anything(), "workflow", "integrate_remote_conflict", expect.objectContaining({ forwardMergeId: "merge_remote", priorHead: "a".repeat(40), priorTree: "d".repeat(40), remoteHead: "c".repeat(40), conflictArtifact: { id: "artifact_remote", kind: "forward-merge-conflict" } }));
  expect(result.outcomes).toEqual([expect.objectContaining({ commandKind: "integrate_remote_conflict", integration: "conflict", deduplicated: false })]);
  const duplicate = await reconcileGithubObservations(conflictDatabase as never, {} as never, {
    observe: async () => ({ exists: true, number: 1, url: "https://example.invalid/pr/1", state: "open", isDraft: false, headSha: "c".repeat(40), baseSha: "b".repeat(40), mergeable: "CONFLICTING", autoMergeEnabled: false, reviewDecision: null, checks: { total: 1, pending: 0, failing: 0, successful: 1 } }),
    integrate: integrate as never,
    execute: execute as never,
  });
  expect(execute).toHaveBeenCalledOnce();
  expect(duplicate.outcomes).toEqual([expect.objectContaining({ commandKind: "integrate_remote_conflict", deduplicated: true })]);
});
