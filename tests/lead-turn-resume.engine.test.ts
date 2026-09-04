import { expect, test } from "vitest";

import { at } from "../src/issue-phases.js";
import { queryIssueWorkflow } from "../src/engine/service.js";
import { IssueContinuationStateSchema, type IssueActivities } from "../src/engine/issue-contracts.js";
import { createEngineHarness, engineFixture } from "./helpers/engine-harness.js";

function reviewingDeliveryState(workflowId: string) {
  return IssueContinuationStateSchema.parse({
    ...at("reviewing_delivery"),
    revision: 7,
    owner: "lead",
    allowedCommands: [],
    pendingAction: "The Planner reviews the delivery",
    leadSessionRef: "lead-session",
    leadOutputArtifactId: "plan-artifact",
    developerExecutionId: "developer-execution",
    developerSessionRef: "developer-session",
    branchName: "forge/issue/resume-review",
    targetBaseSha: engineFixture.base,
    resultCommit: engineFixture.commit,
    resultTree: engineFixture.tree,
    expectedHeadSha: engineFixture.commit,
    expectedHeadTree: engineFixture.tree,
    dirtyState: "clean",
    deliveryArtifactId: "delivery-artifact",
    developerEvidenceArtifactId: "developer-evidence",
    planRevision: 1,
    continuationCount: 0,
    lastSummaryHash: "a".repeat(64),
    lastEventId: `${workflowId}:7`,
  });
}

test("a restarted delivery review resumes once and applies the claimed Herdr result", async () => {
  let reviews = 0;
  const activities: Partial<IssueActivities> = {
    reviewDelivery: async (input) => {
      reviews += 1;
      return {
        outcome: "completed",
        attemptId: "review-attempt",
        correctionAttempts: 0,
        subject: input.subject,
        review: {
          reviewId: "delivery-review",
          leadExecutionId: "lead-review",
          leadSessionRef: "lead-session",
          opinionArtifactId: "review-opinion",
          evidenceArtifactId: "review-evidence",
          opinion: "approved",
          summary: "Approved",
          repairPlan: null,
          findings: [],
          supersedesReviewId: null,
          reviewArtifact: { artifactId: "review-artifact", companyId: engineFixture.companyId, kind: "delivery-review", sha256: engineFixture.sha256, byteSize: 1, mimeType: "application/json" },
        },
      };
    },
    pushDeliveryBranch: async () => ({ repository: "acme/forge", branchName: "forge/issue/resume-review", commitSha: engineFixture.commit }),
  };
  const harness = await createEngineHarness(activities);
  const issueId = "resume-review";
  harness.seedTask(issueId, { deliveryTarget: "remote_branch" });
  const workflowId = harness.workflowId(issueId);
  const now = "2026-08-29T00:00:00.000Z";
  harness.database.authQuery((db) => {
    db.prepare("INSERT INTO forge_herdr_role_sessions (id, task_id, session_role, generation, is_current, provider_kind, agent_name, pane_id, status, created_at, updated_at) VALUES ('planner-session', ?, 'planner', 1, 1, 'codex', 'planner', 'planner-pane', 'ready', ?, ?)").run(issueId, now, now);
    db.prepare("INSERT INTO forge_agent_executions (id, task_id, company_id, workflow_id, role, status, attempt, workflow_revision, purpose, started_at) VALUES ('lead-review', ?, ?, ?, 'planner', 'completed', 1, 1, 'delivery-review', ?)").run(issueId, engineFixture.companyId, workflowId, now);
    db.prepare("INSERT INTO forge_herdr_turns (turn_id, task_id, role_session_id, execution_role, ledger, execution_id, prompt_kind, prompt_sha256, result_relative_path, correction_index, status, created_at, updated_at) VALUES ('completed-review-turn', ?, 'planner-session', 'planner', 'agent', 'lead-review', 'delivery-review', ?, 'herdr-results/resume-review/planner/result-completed-review-turn.json', 0, 'completed', ?, ?)").run(issueId, "a".repeat(64), now, now);
  });
  try {
    await harness.startContinuation(issueId, reviewingDeliveryState(workflowId), { deliveryTarget: "remote_branch" });
    const done = await harness.settle(workflowId, (state) => state.step === "done");
    expect(done.processedCommandIds?.some((commandId) => commandId.startsWith(`${workflowId}:resume:reviewing_delivery:`))).toBe(true);
    expect(reviews).toBe(1);
    await harness.restart();
    expect((await queryIssueWorkflow(harness.config, workflowId)).step).toBe("done");
    expect(reviews).toBe(1);
  } finally {
    await harness.stop();
  }
});
