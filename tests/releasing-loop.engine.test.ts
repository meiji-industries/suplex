import { expect, test } from "vitest";

import { at } from "../src/issue-phases.js";
import { buildInitialIssueWorkflowState } from "../src/engine/issue-contracts.js";
import { createEngineHarness, engineFixture, ImmediateClock } from "./helpers/engine-harness.js";

class RetryClock extends ImmediateClock {
  readonly waits: number[] = [];

  override async wait(milliseconds: number, signal: AbortSignal): Promise<void> {
    this.waits.push(milliseconds);
    await super.wait(milliseconds, signal);
  }
}

test("a blocked publish reconciles a moved base before another review", async () => {
  const clock = new RetryClock();
  const h = await createEngineHarness({
    pushDeliveryBranch: async (input) => ({ repository: "acme/forge", branchName: input.branchName, commitSha: input.commitSha }),
    publishRelease: async (input) => ({ outcome: "blocked", repository: "acme/forge", branchName: input.branchName, headSha: input.subjectCommit, headTree: input.subjectTree, reused: false, attempt: 1, releaseId: null, pullRequestNumber: null, pullRequestUrl: null, isDraft: true, code: "target-base-drift", summary: "Target base moved after delivery review", retryAt: null }),
    reconcileTargetBase: async () => ({ outcome: "blocked", checkId: "base-check", checkpoint: "pre_release", code: "base_advanced_again", owner: "lead", retryable: true, summary: "Target base moved after delivery review" }),
  }, clock);
  h.seedTask("publish-drift");
  const workflowId = h.workflowId("publish-drift");
  const continuationState = {
    ...buildInitialIssueWorkflowState({ workflowId, companyId: engineFixture.companyId, projectId: engineFixture.projectId, issueId: "publish-drift", projectRevisionId: engineFixture.projectRevisionId, briefArtifactId: engineFixture.briefArtifactId, briefSha256: engineFixture.sha256, imageArtifactIds: [], requestHash: engineFixture.sha256, roleProfiles: engineFixture.roleProfiles, supplementalReview: false, repairCycleLimit: 2 }),
    ...at("delivery_reviewed"), revision: 5, owner: "lead" as const, allowedCommands: ["publish_draft" as const, "cancel_issue" as const], pendingAction: "Forge opens the pull request", deliveryReviewId: "review", developerExecutionId: "developer", branchName: "forge/issue/publish-drift", targetBaseSha: engineFixture.base, resultCommit: engineFixture.commit, resultTree: engineFixture.tree, deliveryArtifactId: "delivery", developerEvidenceArtifactId: "evidence", releaseRepository: "acme/forge", lastEventId: `${workflowId}:5`,
  };
  try {
    const started = await h.startContinuation("publish-drift", continuationState);
    const state = await h.settle(started.workflowId, (value) => value.step === "development" && value.targetBaseCheckId === "base-check");
    expect(state).toMatchObject({ owner: "lead", targetBaseCheckpoint: "pre_release", targetBaseBlockerCode: "base_advanced_again" });
    expect(clock.waits).toContain(30_000);
    expect(h.calls.get("publishRelease")).toBe(1);
    expect(h.calls.get("reviewDelivery") ?? 0).toBe(0);
    expect(h.calls.get("reconcileTargetBase")).toBe(1);
  } finally { await h.stop(); }
});
