import { expect, test, vi } from "vitest";

import { reconcileGithubObservations } from "../src/github-observation-reconciliation.js";
import type { GithubPullRequestObservation } from "../src/github-release.js";
import { buildInitialIssueWorkflowState, IssueWorkflowStateSchema } from "../src/engine/issue-contracts.js";

function state(phase: "ci_waiting" | "manual_merge" | "development", allowedCommands: string[], expectedHeadSha = "a".repeat(40)) {
  return IssueWorkflowStateSchema.parse({
    ...buildInitialIssueWorkflowState({ workflowId: `workflow-${phase}`, companyId: "company", projectId: "project", issueId: `task-${phase}`, projectRevisionId: "revision", briefArtifactId: "brief", briefSha256: "a".repeat(64), imageArtifactIds: [], requestHash: "b".repeat(64), roleProfiles: {}, supplementalReview: false, repairCycleLimit: 2 }),
    phase,
    revision: 3,
    owner: "lead",
    allowedCommands: allowedCommands as never,
    pendingAction: "Waiting",
    expectedHeadSha,
    lastEventId: `workflow-${phase}:3`,
  });
}

function database(rows: Array<{ taskId: string; phase: string; stateJson: string }>) {
  return { authQuery: (query: (db: { prepare: () => { all: () => unknown } }) => unknown) => query({ prepare: () => ({ all: () => rows.map((row) => ({ ...row, companyId: "company", workflowId: `workflow-${row.phase}`, revision: 3, repository: "acme/forge", branch: `forge/${row.taskId}`, pullRequestNumber: 42 })) }) }) };
}

function observed(overrides: Partial<Pick<GithubPullRequestObservation, "state" | "headSha"> & { failing: number; pending: number; successful: number; total: number }> = {}): GithubPullRequestObservation {
  const { failing, pending, successful, total, ...pullRequest } = overrides;
  return { exists: true, number: 42, url: "https://github.com/acme/forge/pull/42", state: "open", isDraft: false, headSha: "a".repeat(40), baseSha: "b".repeat(40), mergeable: "CLEAN", autoMergeEnabled: false, reviewDecision: null, ...pullRequest, checks: { total: total ?? 1, pending: pending ?? 0, failing: failing ?? 0, successful: successful ?? 1 } };
}

test("selects active GitHub phases and maps observations to the accepted reconciliation command", async () => {
  const rows = [
    { taskId: "ci", phase: "ci_waiting", stateJson: JSON.stringify(state("ci_waiting", ["reconcile_ci"])) },
    { taskId: "merge", phase: "manual_merge", stateJson: JSON.stringify(state("manual_merge", ["reconcile_merge"])) },
    { taskId: "development", phase: "development", stateJson: JSON.stringify(state("development", [])) },
  ];
  const execute = vi.fn<(...args: any[]) => Promise<any>>(async () => ({}));
  const result = await reconcileGithubObservations(database(rows) as never, {} as never, { observe: async (input) => input.branch === "forge/merge" ? observed({ state: "closed" }) : observed({ pending: 1, successful: 0 }), execute: execute as never });

  expect(result.inspected).toBe(2);
  expect(result.signalled).toBe(2);
  expect(result.outcomes.map((outcome) => outcome.commandKind)).toEqual(["reconcile_ci", "reconcile_merge"]);
  expect(execute.mock.calls.map((call) => call[2])).toEqual(["reconcile_ci", "reconcile_merge"]);
});

test("deduplicates the same observation without additional workflow commands or timeline rows", async () => {
  const rows = [{ taskId: "ci", phase: "ci_waiting", stateJson: JSON.stringify(state("ci_waiting", ["reconcile_ci"])) }];
  const execute = vi.fn<(...args: any[]) => Promise<any>>(async (_config, _workflowId, _kind, input) => {
    const current = JSON.parse(rows[0]!.stateJson);
    rows[0]!.stateJson = JSON.stringify({ ...current, processedCommandIds: [input.commandId] });
  });
  const options = { observe: async () => observed({ pending: 1, successful: 0 }), execute: execute as never };

  const first = await reconcileGithubObservations(database(rows) as never, {} as never, options);
  const timelineRows = 0;
  const second = await reconcileGithubObservations(database(rows) as never, {} as never, options);

  expect(first.signalled).toBe(1);
  expect(second.outcomes).toEqual([expect.objectContaining({ deduplicated: true, commandKind: "reconcile_ci" })]);
  expect(execute).toHaveBeenCalledTimes(1);
  expect(timelineRows).toBe(0);
});

test("counts transient GitHub observation errors and continues", async () => {
  const rows = [{ taskId: "ci", phase: "ci_waiting", stateJson: JSON.stringify(state("ci_waiting", ["reconcile_ci"])) }];
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const result = await reconcileGithubObservations(database(rows) as never, {} as never, { observe: async () => { throw new Error("rate limited"); } });
  warn.mockRestore();

  expect(result).toMatchObject({ inspected: 1, signalled: 0, errors: 1, outcomes: [] });
});

test("a merged pull request is adopted into the projection when the workflow cannot take the command", async () => {
  const rows = [{ taskId: "merge", phase: "manual_merge", stateJson: JSON.stringify(state("manual_merge", ["reconcile_merge"])) }];
  const projectIssueState = vi.fn();
  const db = { ...database(rows), projectIssueState };
  const execute = vi.fn<(...args: any[]) => Promise<any>>(async () => { throw new Error("workflow execution already completed"); });
  const result = await reconcileGithubObservations(db as never, {} as never, { observe: async () => observed({ state: "merged" }), execute: execute as never });
  expect(result.errors).toBe(0);
  expect(result.signalled).toBe(1);
  expect(projectIssueState).toHaveBeenCalledTimes(1);
  expect(projectIssueState.mock.calls[0]![0]).toMatchObject({ taskId: "merge", phase: "done", pendingAction: "Merged", revision: 4 });
});
