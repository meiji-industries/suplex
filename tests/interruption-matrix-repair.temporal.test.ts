import { join } from "node:path";

import { expect, test } from "vitest";

import { queryIssueWorkflow, startIssueWorkflow } from "../src/temporal/service.js";
import { createTemporalHarness, type TemporalHarness } from "./helpers/temporal-harness.js";

const base = "a".repeat(40);
const unchangedHead = "b".repeat(40);
const tree = "c".repeat(40);

function continuation(h: TemporalHarness, issueId: string) {
  return {
    phase: "delivery_ready" as const,
    revision: 20,
    owner: "lead" as const,
    allowedCommands: ["review_delivery" as const, "cancel_issue" as const],
    pendingAction: "Lead delivery review",
    lastEventId: `${issueId}:20`,
    continuationCount: 0,
    lastSummaryHash: null,
    blocker: null,
    stateChangedAt: new Date().toISOString(),
    leadSessionRef: "repair-lead-session",
    leadExecutionId: "repair-lead-execution",
    leadOutputArtifactId: h.artifacts.integrationLeadOutputArtifactId,
    planRevision: 1,
    developerExecutionId: "repair-developer-original",
    developerSessionRef: "repair-developer-session",
    worktreePath: join(h.root, "worktrees", issueId),
    branchName: `forge/issue/${issueId}`,
    targetBaseSha: base,
    resultCommit: unchangedHead,
    resultTree: tree,
    dirtyState: "clean" as const,
    deliveryArtifactId: "repair-delivery-artifact",
    developerEvidenceArtifactId: "repair-evidence-artifact",
  };
}

async function waitForPhase(h: TemporalHarness, workflowId: string, phase: string) {
  let state = await queryIssueWorkflow(h.config, workflowId);
  for (let attempt = 0; attempt < 100 && state.phase !== phase; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    state = await queryIssueWorkflow(h.config, workflowId);
  }
  return state;
}

test("required local test fails and auto-repairs", { timeout: 120_000 }, async () => {
  const h = createTemporalHarness();
  let reviews = 0;
  let repairs = 0;
  h.activityOverrides.set("reviewDelivery", async (input) => {
    reviews += 1;
    return {
      outcome: "completed" as const,
      attemptId: `repair-review-${reviews}`,
      correctionAttempts: 0,
      subject: input.subject,
      review: {
        reviewId: `repair-review-id-${reviews}`,
        leadExecutionId: "repair-review-lead",
        leadSessionRef: "repair-lead-session",
        opinionArtifactId: h.artifacts.integrationLeadOutputArtifactId,
        evidenceArtifactId: "repair-review-evidence",
        opinion: "blocking" as const,
        summary: "Required local test still fails.",
        findings: [{ findingId: "required-local-test", severity: "blocking" as const, rationale: "The required local test failed.", evidenceRef: "fixture", disposition: "open" as const, repairInstruction: "Repair the failing test." }],
        supersedesReviewId: input.supersedesReviewId ?? null,
      },
    };
  });
  h.activityOverrides.set("runDeveloperRepairSupervised", async (input) => {
    repairs += 1;
    return {
      status: "completed" as const,
      resultHash: "d".repeat(64),
      result: {
        outcome: "completed" as const,
        repairAttemptId: `repair-attempt-${repairs}`,
        cycle: input.cycle,
        reviewId: input.reviewId,
        subject: { planRevision: input.planRevision, targetBaseSha: input.targetBaseSha, subjectCommit: input.subjectCommit, subjectTree: input.subjectTree, developerExecutionId: input.developerExecutionId, deliveryArtifactId: "repair-delivery-artifact", developerEvidenceArtifactId: "repair-evidence-artifact", leadSessionRef: input.leadSessionRef, developerSessionRef: input.developerSessionRef },
        developerExecutionId: `repair-developer-${repairs}`,
        developerSessionRef: "repair-developer-session",
        worktreePath: join(h.root, "worktrees", "repair-no-progress"),
        branchName: "forge/issue/repair-no-progress",
        resultCommit: unchangedHead,
        resultTree: tree,
        dirtyState: "clean" as const,
        deliveryArtifactId: "repair-delivery-artifact",
        evidenceArtifactId: "repair-evidence-artifact",
        summary: "The repair did not change the revision.",
      },
    };
  });
  await h.start();
  try {
    const started = await startIssueWorkflow(h.config, {
      companyId: "issue-company",
      projectId: "issue-project",
      issueId: "repair-no-progress",
      projectRevisionId: "issue-revision",
      briefArtifactId: "issue-brief",
      briefSha256: "0".repeat(64),
      imageArtifactIds: [],
      roleProfiles: h.issueRoleProfiles,
      supplementalReview: false,
      continuationState: continuation(h, "repair-no-progress"),
    });
    const blocked = await waitForPhase(h, started.workflowId, "delivery_blocked");

    expect(blocked.phase).toBe("delivery_blocked");
    expect(blocked.blocker?.actions).toContainEqual(expect.objectContaining({ label: "Resume Developer turn" }));
    expect(blocked.blocker?.summary).toEqual(expect.stringMatching(/^Automatic repair is not making progress/));
    expect(reviews).toBe(2);
    expect(repairs).toBe(1);
    expect(await queryIssueWorkflow(h.config, started.workflowId)).toEqual(blocked);
  } finally {
    await h.stop();
  }
});
