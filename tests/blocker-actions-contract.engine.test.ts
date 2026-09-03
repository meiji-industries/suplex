import { expect, test } from "vitest";

import { at, isBlocked } from "../src/issue-phases.js";
import { buildInitialIssueWorkflowState } from "../src/engine/issue-contracts.js";
import { issueUpdates } from "../src/engine/issue-updates.js";
import { humanBlocker } from "../src/engine/workflow/state-transitions.js";
import { createEngineHarness, engineFixture } from "./helpers/engine-harness.js";

test("a publish-retry blocker action is accepted without a review blocker code", async () => {
  const h = await createEngineHarness({
    reviewDelivery: async (input) => ({
      outcome: "completed",
      attemptId: "retry-review",
      correctionAttempts: 0,
      subject: input.subject,
      review: {
        reviewId: "retry-review",
        leadExecutionId: "lead-review",
        leadSessionRef: "lead-session",
        opinionArtifactId: "review-opinion",
        evidenceArtifactId: "review-evidence",
        opinion: "approved",
        summary: "Matches plan",
        repairPlan: null,
        findings: [],
        supersedesReviewId: null,
        reviewArtifact: { artifactId: "review-artifact", companyId: engineFixture.companyId, kind: "delivery-review", sha256: engineFixture.sha256, byteSize: 1, mimeType: "application/json" },
      },
    }),
  });
  h.seedTask("publish-retry-blocker-contract");
  const workflowId = h.workflowId("publish-retry-blocker-contract");
  const blocker = humanBlocker("provider_connectivity_exhausted", "The provider failure continued after the automatic retries.", [{ command: "review_delivery", label: "Retry now", requiresNote: false, destructive: false }, { command: "cancel_issue", label: "Cancel the task", requiresNote: false, destructive: true }], undefined);
  const continuationState = {
    ...buildInitialIssueWorkflowState({ workflowId, companyId: engineFixture.companyId, projectId: engineFixture.projectId, issueId: "publish-retry-blocker-contract", projectRevisionId: engineFixture.projectRevisionId, briefArtifactId: engineFixture.briefArtifactId, briefSha256: engineFixture.sha256, imageArtifactIds: [], requestHash: engineFixture.sha256, roleProfiles: engineFixture.roleProfiles, supplementalReview: false, repairCycleLimit: 2 }),
    ...at("delivery_ready"),
    revision: 5,
    owner: "human" as const,
    allowedCommands: ["review_delivery" as const, "cancel_issue" as const],
    pendingAction: blocker.summary,
    blocker,
    developerExecutionId: "developer",
    developerSessionRef: "developer-session",
    branchName: "forge/issue/publish-retry-blocker-contract",
    targetBaseSha: engineFixture.base,
    resultCommit: engineFixture.commit,
    resultTree: engineFixture.tree,
    deliveryArtifactId: "delivery",
    developerEvidenceArtifactId: "developer-evidence",
    leadSessionRef: "lead-session",
    leadOutputArtifactId: "lead-output",
    processedCommandIds: [
      `${workflowId}:auto-retry:review_delivery:${engineFixture.commit}:1`,
      `${workflowId}:auto-retry:review_delivery:${engineFixture.commit}:2`,
      `${workflowId}:auto-retry:review_delivery:${engineFixture.commit}:3`,
    ],
    lastEventId: `${workflowId}:5`,
  };
  try {
    await h.startContinuation("publish-retry-blocker-contract", continuationState);
    const blocked = await h.settle(workflowId, isBlocked);
    await expect(h.engine.run(workflowId).execute(issueUpdates.review_delivery, {
      expectedRevision: blocked.revision,
      actorUserId: engineFixture.actorUserId,
      commandId: "publish-retry-blocker-contract-review",
    }, "publish-retry-blocker-contract-review")).resolves.toMatchObject({ blocker: null });
  } finally {
    await h.stop();
  }
});
