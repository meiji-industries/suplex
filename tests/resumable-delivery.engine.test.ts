import { expect, test } from "vitest";

import { at } from "../src/issue-phases.js";
import { buildInitialIssueWorkflowState } from "../src/engine/issue-contracts.js";
import { createEngineHarness, engineFixture } from "./helpers/engine-harness.js";

function releasing(harness: Awaited<ReturnType<typeof createEngineHarness>>, issueId: string) {
  const workflowId = harness.workflowId(issueId);
  return {
    ...buildInitialIssueWorkflowState({ workflowId, companyId: engineFixture.companyId, projectId: engineFixture.projectId, issueId, projectRevisionId: engineFixture.projectRevisionId, briefArtifactId: engineFixture.briefArtifactId, briefSha256: engineFixture.sha256, imageArtifactIds: [], requestHash: engineFixture.sha256, roleProfiles: engineFixture.roleProfiles, supplementalReview: false, repairCycleLimit: 2 }),
    ...at("releasing"), revision: 5, owner: "lead" as const, allowedCommands: [], pendingAction: "Forge opens the pull request", deliveryReviewId: "review", developerExecutionId: "developer", branchName: `forge/issue/${issueId}`, targetBaseSha: engineFixture.base, resultCommit: engineFixture.commit, resultTree: engineFixture.tree, releaseRepository: "acme/forge", activeOperation: null, releaseRetryAt: null, lastEventId: `${workflowId}:5`,
  };
}

test("a known merged pull request completes while the local worktree is dirty or absent", async () => {
  for (const worktree of [
    { present: true, owned: true, dirtyFileCount: 1, branch: null, activeExecution: false, revision: null },
    { present: false, owned: false, dirtyFileCount: 0, branch: null, activeExecution: false, revision: null },
  ]) {
    const h = await createEngineHarness({
      inspectTaskWorktree: async () => worktree,
      observeGithubPullRequest: async () => ({ exists: true, number: 127, url: "https://github.test/127", state: "merged", isDraft: false, headSha: engineFixture.commit, baseSha: engineFixture.base, mergeable: "MERGEABLE", checks: { total: 1, pending: 0, failing: 1, successful: 0 }, autoMergeEnabled: false, reviewDecision: null }),
    });
    h.seedTask(`merged-${worktree.present}`);
    try {
      const started = await h.startContinuation(`merged-${worktree.present}`, releasing(h, `merged-${worktree.present}`), { deliveryTarget: "merged" });
      const done = await h.settle(started.workflowId, (state) => state.step === "done");
      expect(done.step).toBe("done");
      expect(h.calls.get("inspectTaskWorktree") ?? 0).toBe(0);
    } finally { await h.stop(); }
  }
});

test.each([
  ["pull_request_draft", true],
  ["pull_request_ready", false],
] as const)("a %s target completes before an old failed check is repaired", async (deliveryTarget, isDraft) => {
  const h = await createEngineHarness({
    observeGithubPullRequest: async () => ({ exists: true, number: 127, url: "https://github.test/127", state: "open", isDraft, headSha: engineFixture.commit, baseSha: engineFixture.base, mergeable: "MERGEABLE", checks: { total: 1, pending: 0, failing: 1, successful: 0 }, autoMergeEnabled: false, reviewDecision: null }),
  });
  h.seedTask(`target-${deliveryTarget}`, { deliveryTarget });
  try {
    const started = await h.startContinuation(`target-${deliveryTarget}`, releasing(h, `target-${deliveryTarget}`), { deliveryTarget });
    expect((await h.settle(started.workflowId, (state) => state.step === "done")).step).toBe("done");
  } finally { await h.stop(); }
});

test.each([
  ["CONFLICTING", "open"],
  ["MERGEABLE", "closed"],
] as const)("a %s PR routes to the conflict path, never CI repair", async (mergeable, state) => {
  const h = await createEngineHarness({
    observeGithubPullRequest: async () => ({ exists: true, number: 127, url: "https://github.test/127", state, isDraft: false, headSha: engineFixture.commit, baseSha: engineFixture.base, mergeable, checks: { total: 1, pending: 0, failing: 1, successful: 0 }, autoMergeEnabled: false, reviewDecision: null }),
  });
  h.seedTask(`non-ci-${state}`);
  try {
    const started = await h.startContinuation(`non-ci-${state}`, releasing(h, `non-ci-${state}`));
    const result = await h.settle(started.workflowId, (value) => value.step === "merge_conflict_reviewing");
    expect(result.step).not.toBe("ci_repair_planning");
  } finally { await h.stop(); }
});

test("a failed required check starts CI repair without another publication or review", async () => {
  const h = await createEngineHarness({
    observeGithubPullRequest: async () => ({ exists: true, number: 127, url: "https://github.test/127", state: "open", isDraft: false, headSha: engineFixture.commit, baseSha: engineFixture.base, mergeable: "MERGEABLE", checks: { total: 1, pending: 0, failing: 1, successful: 0 }, autoMergeEnabled: false, reviewDecision: null }),
  });
  h.seedTask("c8", { deliveryTarget: "merged" });
  try {
    const started = await h.startContinuation("c8", releasing(h, "c8"), { deliveryTarget: "merged" });
    const state = await h.settle(started.workflowId, (value) => value.step === "ci_repair_planning");
    expect(state.step).toBe("ci_repair_planning");
    expect(h.calls.get("pushDeliveryBranch") ?? 0).toBe(0);
    expect(h.calls.get("reviewDelivery") ?? 0).toBe(0);
  } finally { await h.stop(); }
});
