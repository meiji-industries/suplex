import { expect, test } from "vitest";

import { at } from "../src/issue-phases.js";
import { buildInitialIssueWorkflowState, type IssueActivities } from "../src/engine/issue-contracts.js";
import { createEngineHarness, engineFixture } from "./helpers/engine-harness.js";

function parkedState(workflowId: string, issueId: string, step: "delivery_reviewed" | "delivery_ready" = "delivery_reviewed") {
  return {
    ...buildInitialIssueWorkflowState({ workflowId, companyId: engineFixture.companyId, projectId: engineFixture.projectId, issueId, projectRevisionId: engineFixture.projectRevisionId, briefArtifactId: engineFixture.briefArtifactId, briefSha256: engineFixture.sha256, imageArtifactIds: [], requestHash: engineFixture.sha256, roleProfiles: engineFixture.roleProfiles, supplementalReview: false, repairCycleLimit: 2 }),
    ...at(step),
    revision: 7,
    owner: "human" as const,
    allowedCommands: [step === "delivery_reviewed" ? "publish_draft" as const : "review_delivery" as const, "cancel_issue" as const],
    pendingAction: "The previous automatic action stopped.",
    blocker: { category: "agent_exhausted" as const, summary: "The previous automatic action stopped.", unblockOwner: "human" as const, actions: [{ command: step === "delivery_reviewed" ? "publish_draft" as const : "review_delivery" as const, label: "Retry now", requiresNote: false, destructive: false }], evidence: { artifactId: "evidence", kind: "attention-evidence" as const }, createdAt: "2026-08-29T00:00:00.000Z", retry: null },
    branchName: "forge/issue/reobserve",
    targetBaseSha: engineFixture.base,
    resultCommit: engineFixture.commit,
    resultTree: engineFixture.tree,
    developerExecutionId: "developer-1",
    developerSessionRef: "developer-session",
    deliveryReviewId: step === "delivery_reviewed" ? "review-1" : null,
    releaseRepository: "acme/forge",
    lastEventId: `${workflowId}:7`,
  };
}

const github = { exists: false, number: null, url: null, state: null, isDraft: null, headSha: null, baseSha: null, mergeable: null, checks: { total: 0, pending: 0, failing: 0, successful: 0 }, autoMergeEnabled: null, reviewDecision: null } as const;

test("a parked reviewed delivery re-observes owners and publishes once", async () => {
  const activities: Partial<IssueActivities> = {
    inspectTaskWorktree: async () => ({ present: true, owned: true, dirtyFileCount: 0, branch: "forge/issue/reobserve", activeExecution: false, revision: { proven: true, head: engineFixture.commit, headTree: engineFixture.tree, branch: "forge/issue/reobserve", clean: true } }),
    observeGithubPullRequest: async () => github,
    pushDeliveryBranch: async () => ({ repository: "acme/forge", branchName: "forge/issue/reobserve", commitSha: engineFixture.commit }),
  };
  const h = await createEngineHarness(activities);
  h.seedTask("reobserve-publish", { deliveryTarget: "remote_branch" });
  try {
    const started = await h.startContinuation("reobserve-publish", parkedState(h.workflowId("reobserve-publish"), "reobserve-publish"), { deliveryTarget: "remote_branch" });
    const state = await h.settle(started.workflowId, (next) => next.step === "done");
    expect(state.processedCommandIds).toContain(`${started.workflowId}:auto-reobserve:publish_draft:${engineFixture.commit}`);
    expect(h.calls.get("pushDeliveryBranch")).toBe(1);
    await h.restart();
    expect(h.calls.get("pushDeliveryBranch")).toBe(1);
  } finally { await h.stop(); }
});

test("a failed git proof remains parked and refreshes its observation time", async () => {
  const activities: Partial<IssueActivities> = {
    inspectTaskWorktree: async () => ({ present: true, owned: true, dirtyFileCount: 0, branch: "forge/issue/reobserve", activeExecution: false, revision: { proven: false, head: null, headTree: null, branch: null, clean: false } }),
    observeGithubPullRequest: async () => github,
  };
  const h = await createEngineHarness(activities);
  h.seedTask("reobserve-git", { deliveryTarget: "remote_branch" });
  try {
    const before = parkedState(h.workflowId("reobserve-git"), "reobserve-git");
    const started = await h.startContinuation("reobserve-git", before, { deliveryTarget: "remote_branch" });
    const state = await h.settle(started.workflowId, (next) => next.stateChangedAt !== before.stateChangedAt);
    expect(state.owner).toBe("human");
    expect(state.blocker?.category).toBe("agent_exhausted");
  } finally { await h.stop(); }
});

test("a product decision park is not re-observed", async () => {
  const activities: Partial<IssueActivities> = {
    inspectTaskWorktree: async () => ({ present: true, owned: true, dirtyFileCount: 0, branch: "forge/issue/reobserve", activeExecution: false, revision: { proven: true, head: engineFixture.commit, headTree: engineFixture.tree, branch: "forge/issue/reobserve", clean: true } }),
  };
  const h = await createEngineHarness(activities);
  h.seedTask("reobserve-decision", { deliveryTarget: "remote_branch" });
  try {
    const before = { ...parkedState(h.workflowId("reobserve-decision"), "reobserve-decision"), blocker: { ...parkedState(h.workflowId("reobserve-decision"), "reobserve-decision").blocker, category: "member_decision" as const } };
    const started = await h.startContinuation("reobserve-decision", before, { deliveryTarget: "remote_branch" });
    const state = await h.settle(started.workflowId, (next) => next.owner === "human");
    expect(state.blocker?.category).toBe("member_decision");
    expect(h.calls.get("inspectTaskWorktree") ?? 0).toBe(0);
  } finally { await h.stop(); }
});
