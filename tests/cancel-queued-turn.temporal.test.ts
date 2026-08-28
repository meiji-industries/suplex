import { expect, test } from "vitest";

import { executeIssueCommand, queryIssueWorkflow, startIssueWorkflow } from "../src/temporal/service.js";
import { createTemporalHarness, type TemporalHarness } from "./helpers/temporal-harness.js";

const base = "a".repeat(40);

function continuation(h: TemporalHarness, issueId: string) {
  return {
    phase: "ready_for_development" as const, revision: 1, owner: "lead" as const,
    allowedCommands: ["start_development" as const, "cancel_issue" as const], pendingAction: "Start development",
    lastEventId: `${issueId}:1`, continuationCount: 0, lastSummaryHash: null, blocker: null,
    stateChangedAt: new Date().toISOString(), planRevision: 1, planMaterial: true, planApproved: true,
    leadSessionRef: "lead-session", leadOutputArtifactId: h.artifacts.integrationLeadOutputArtifactId,
  };
}

async function waitForPhase(h: TemporalHarness, workflowId: string, phase: string) {
  let state = await queryIssueWorkflow(h.config, workflowId);
  for (let attempt = 0; attempt < 120 && state.phase !== phase; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    state = await queryIssueWorkflow(h.config, workflowId);
  }
  return state;
}

function completed(input: { developerTurnExecutionId: string }) {
  return {
    status: "completed" as const, resultHash: "d".repeat(64), result: {
      developerExecutionId: input.developerTurnExecutionId, developerSessionRef: "developer-session",
      branchName: "forge/issue/cancel-queued", targetBaseSha: base, currentStep: 1,
      resultCommit: "b".repeat(40), resultTree: "c".repeat(40), dirtyState: "clean" as const,
      deliveryArtifactId: "developer-delivery", evidenceArtifactId: "developer-evidence",
      deliverySummary: "Developer delivery", outcome: "completed" as const,
    },
  };
}

test("cancel while queued prevents a Developer turn from starting, then retry starts one turn", { timeout: 120_000 }, async () => {
  const h = createTemporalHarness();
  let openGate!: () => void;
  const gate = new Promise<void>((resolve) => { openGate = resolve; });
  let queued = true;
  let turnStarts = 0;
  h.activityOverrides.set("runDeveloperExecutionSupervised", async (input) => {
    if (queued) await gate;
    const claim = h.database.authQuery((db) => db.prepare("SELECT status, result_json AS resultJson FROM forge_operation_claims WHERE operation_key = ?").get(`turn|${input.taskId}|${input.developerTurnExecutionId}`) as { status: string; resultJson: string | null } | undefined);
    if (claim?.status === "failed" && JSON.parse(claim.resultJson ?? "{}").reasonCode === "cancelled") return { status: "failed" as const, developerExecutionId: input.developerTurnExecutionId, reasonCode: "cancelled", summary: "Cancelled before the turn started", evidenceArtifactId: null };
    turnStarts += 1;
    return completed(input);
  });
  await h.start();
  try {
    const started = await startIssueWorkflow(h.config, {
      companyId: "issue-company", projectId: "issue-project", issueId: "cancel-queued-turn", projectRevisionId: "issue-revision",
      briefArtifactId: "issue-brief", briefSha256: "0".repeat(64), imageArtifactIds: [], roleProfiles: h.issueRoleProfiles,
      supplementalReview: false, continuationState: continuation(h, "cancel-queued-turn"),
    });
    await waitForPhase(h, started.workflowId, "development");
    const active = await queryIssueWorkflow(h.config, started.workflowId);
    const cancelCommand = { expectedRevision: active.revision, actorUserId: "issue-admin", commandId: "cancel-queued-developer" };
    const cancelled = await executeIssueCommand(h.config, started.workflowId, "cancel_development", cancelCommand);
    expect(cancelled).toMatchObject({ phase: "delivery_blocked", developerRecoveryStatus: "cancelled" });
    expect(await executeIssueCommand(h.config, started.workflowId, "cancel_development", cancelCommand)).toEqual(cancelled);
    openGate();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(turnStarts).toBe(0);
    queued = false;
    const retried = await executeIssueCommand(h.config, started.workflowId, "retry_development", { expectedRevision: cancelled.revision, actorUserId: "issue-admin" });
    expect(retried).toMatchObject({ phase: "delivery_ready" });
    expect(turnStarts).toBe(1);
  } finally { await h.stop(); }
});
