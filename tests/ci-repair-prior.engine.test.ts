import { expect, test } from "vitest";

import { at } from "../src/issue-phases.js";
import { buildInitialIssueWorkflowState } from "../src/engine/issue-contracts.js";
import { ApplicationFailure } from "../src/engine/failures.js";
import { executeIssueCommand, queryIssueWorkflow } from "../src/engine/service.js";
import { createEngineHarness, engineFixture } from "./helpers/engine-harness.js";

const failedHead = "d".repeat(40);

function repairState(workflowId: string, issueId: string) {
  return {
    ...buildInitialIssueWorkflowState({ workflowId, companyId: engineFixture.companyId, projectId: engineFixture.projectId, issueId, projectRevisionId: engineFixture.projectRevisionId, briefArtifactId: engineFixture.briefArtifactId, briefSha256: engineFixture.sha256, imageArtifactIds: [], requestHash: engineFixture.sha256, roleProfiles: engineFixture.roleProfiles, supplementalReview: false, repairCycleLimit: 2 }),
    ...at("ci_repairing"),
    revision: 20,
    owner: "human" as const,
    allowedCommands: ["repair_ci" as const, "cancel_issue" as const],
    pendingAction: "Repair CI",
    releaseId: "release-1",
    branchName: "forge/issue/ci-repair-prior",
    resultCommit: failedHead,
    resultTree: engineFixture.tree,
    developerExecutionId: "failed-turn",
    developerSessionRef: "failed-turn-session",
    ciRunId: "ci-run-1",
    ciAttemptId: "ci-attempt-1",
    ciRepairPlanId: "ci-repair-plan-1",
    ciRepairPlanArtifactId: "ci-repair-plan-artifact-1",
    ciRepairPlanEvidenceArtifactId: "ci-repair-evidence-artifact-1",
    lastEventId: `${workflowId}:20`,
  };
}

function seedExecution(h: Awaited<ReturnType<typeof createEngineHarness>>, issueId: string, id: string, status: "completed" | "failed", sessionRef: string | null) {
  const now = new Date().toISOString();
  h.database.authQuery((db) => db.prepare("INSERT INTO forge_developer_executions (id, task_id, company_id, workflow_id, plan_revision, attempt, status, branch_name, worktree_path, target_base_sha, session_ref, started_at, finished_at, result_commit, result_tree, dirty_state) VALUES (?, ?, ?, ?, 1, ?, ?, 'forge/issue/ci-repair-prior', ?, ?, ?, ?, ?, ?, ?, 'clean')").run(id, issueId, engineFixture.companyId, h.workflowId(issueId), status === "completed" ? 1 : 2, status, `/worktrees/${id}`, engineFixture.base, sessionRef, now, now, failedHead, engineFixture.tree));
}

function scopeMismatchFailure() {
  return ApplicationFailure.nonRetryable("The repair scope does not match the delivery.", "developer-scope-mismatch", { code: "developer-scope-mismatch", summary: "The repair scope does not match the delivery." });
}

test("CI repair reads the completed delivery as its prior after a failed turn", async () => {
  const issueId = "ci-repair-prior";
  let repairInput: { priorDeveloperExecutionId: string; priorDeveloperSessionRef: string; worktreePath?: string } | undefined;
  const h = await createEngineHarness({
    projectIssueState: async (event) => event.state,
    findCiRepairPriorDelivery: async (input) => h.database.authQuery((db) => db.prepare(`SELECT id AS developerExecutionId, session_ref AS developerSessionRef, worktree_path AS worktreePath
      FROM forge_developer_executions WHERE task_id = ? AND company_id = ? AND workflow_id = ?
        AND status IN ('completed', 'blocked') AND lower(result_commit) = lower(?) AND session_ref IS NOT NULL
      ORDER BY finished_at DESC, started_at DESC LIMIT 1`).get(input.taskId, input.companyId, input.workflowId, input.resultCommit) as { developerExecutionId: string; developerSessionRef: string; worktreePath: string } | undefined ?? null),
    runCiRepair: async (input) => {
      repairInput = input;
      throw scopeMismatchFailure();
    },
  });
  h.seedTask(issueId);
  try {
    seedExecution(h, issueId, "completed-delivery", "completed", "completed-session");
    seedExecution(h, issueId, "failed-turn", "failed", null);
    const started = await h.startContinuation(issueId, repairState(h.workflowId(issueId), issueId));
    const state = await executeIssueCommand(h.config, started.workflowId, "repair_ci", { expectedRevision: (await queryIssueWorkflow(h.config, started.workflowId)).revision, actorUserId: engineFixture.actorUserId });

    expect(repairInput).toMatchObject({ priorDeveloperExecutionId: "completed-delivery", priorDeveloperSessionRef: "completed-session", worktreePath: "/worktrees/completed-delivery" });
    expect(state).toMatchObject({ step: "ci_waiting", owner: "human", pendingAction: "The CI repair could not start: The repair scope does not match the delivery.", blocker: { category: "verification_unrecoverable" } });
  } finally {
    await h.stop();
  }
});

test("a scope mismatch stops CI repair retries and leaves an actionable human blocker", async () => {
  const issueId = "ci-repair-scope-mismatch";
  const h = await createEngineHarness({
    projectIssueState: async (event) => event.state,
    findCiRepairPriorDelivery: async () => ({ developerExecutionId: "completed-delivery", developerSessionRef: "completed-session", worktreePath: "/worktrees/completed-delivery" }),
    runCiRepair: async () => { throw scopeMismatchFailure(); },
  });
  h.seedTask(issueId);
  try {
    const started = await h.startContinuation(issueId, repairState(h.workflowId(issueId), issueId));
    const state = await executeIssueCommand(h.config, started.workflowId, "repair_ci", { expectedRevision: (await queryIssueWorkflow(h.config, started.workflowId)).revision, actorUserId: engineFixture.actorUserId });

    expect(h.calls.get("runCiRepair")).toBe(1);
    expect(state.blocker?.actions.map((action) => action.command)).toEqual(["repair_ci", "cancel_issue"]);
  } finally {
    await h.stop();
  }
});
