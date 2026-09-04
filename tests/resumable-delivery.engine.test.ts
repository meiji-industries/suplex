import { expect, test } from "vitest";

import { at } from "../src/issue-phases.js";
import { buildInitialIssueWorkflowState } from "../src/engine/issue-contracts.js";
import { createEngineHarness, engineFixture } from "./helpers/engine-harness.js";

class ControlledClock extends (await import("./helpers/engine-harness.js")).ImmediateClock {
  private wake: (() => void) | null = null;
  private current = Date.parse("2026-08-29T00:00:00.000Z");
  private waitMilliseconds = 0;
  override now(): number { return this.current; }
  override async wait(milliseconds: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted) throw signal.reason;
    this.waitMilliseconds = milliseconds;
    await new Promise<void>((resolve) => { this.wake = resolve; });
  }
  releaseWake(): void { this.current += this.waitMilliseconds; this.wake?.(); this.wake = null; }
}

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

test("a provider-unavailable publish waits before one due retry without a review burst", async () => {
  const clock = new ControlledClock();
  let attempts = 0;
  const h = await createEngineHarness({
    observeGithubPullRequest: async () => ({ exists: false, number: null, url: null, state: null, isDraft: null, headSha: null, baseSha: null, mergeable: null, checks: { total: 0, pending: 0, failing: 0, successful: 0 }, autoMergeEnabled: false, reviewDecision: null }),
    pushDeliveryBranch: async (input) => ({ repository: "acme/forge", branchName: input.branchName, commitSha: input.commitSha }),
    publishRelease: async (input) => {
      attempts += 1;
      return { outcome: "blocked" as const, repository: "acme/forge", branchName: input.branchName, headSha: engineFixture.commit, headTree: engineFixture.tree, reused: false, attempt: attempts, releaseId: null, pullRequestNumber: null, pullRequestUrl: null, isDraft: false, code: "provider-unavailable" as const, summary: "GitHub timed out", retryAt: null };
    },
  }, clock);
  h.seedTask("provider-wake");
  try {
    const started = await h.startContinuation("provider-wake", releasing(h, "provider-wake"));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(attempts).toBe(1);
    expect(h.engine.run(started.workflowId).state.releaseRetryAt).toBe(new Date(clock.now() + 60_000).toISOString());
    expect(h.calls.get("reviewDelivery") ?? 0).toBe(0);
    for (let turn = 0; turn < 61 && attempts < 2; turn += 1) {
      clock.releaseWake();
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    expect(attempts).toBe(2);
    expect(h.calls.get("reviewDelivery") ?? 0).toBe(0);
  } finally { await h.stop(); }
});

test("an incomplete Builder result cannot publish or review", async () => {
  const h = await createEngineHarness({
    readHerdrTurn: async () => ({ type: "owner.absent" }),
    runDeveloperExecutionSupervised: async (input) => ({ status: "completed" as const, resultHash: engineFixture.sha256, result: { developerExecutionId: input.developerTurnExecutionId, developerSessionRef: "builder-session", branchName: "forge/issue/incomplete", targetBaseSha: engineFixture.base, currentStep: 1, resultCommit: engineFixture.commit, resultTree: engineFixture.tree, dirtyState: "clean" as const, deliveryArtifactId: "delivery", evidenceArtifactId: "evidence", deliverySummary: "Verification remains incomplete", outcome: "blocked" as const, steps: [{ number: 1, status: "completed" as const }, { number: 2, status: "incomplete" as const }], authorizedStepsNotCompleted: [2], blocker: null } }),
  });
  h.seedTask("56");
  const workflowId = h.workflowId("56");
  const state = { ...buildInitialIssueWorkflowState({ workflowId, companyId: engineFixture.companyId, projectId: engineFixture.projectId, issueId: "56", projectRevisionId: engineFixture.projectRevisionId, briefArtifactId: engineFixture.briefArtifactId, briefSha256: engineFixture.sha256, imageArtifactIds: [], requestHash: engineFixture.sha256, roleProfiles: engineFixture.roleProfiles, supplementalReview: false, repairCycleLimit: 2 }), ...at("ready_for_development"), revision: 1, owner: "lead" as const, allowedCommands: ["start_development" as const, "cancel_issue" as const], pendingAction: "Start the build", planRevision: 1, planApproved: true, leadSessionRef: "lead", leadOutputArtifactId: "plan", lastEventId: `${workflowId}:1` };
  try {
    const started = await h.startContinuation("56", state);
    const incomplete = await h.settle(started.workflowId, (value) => value.step === "delivery_ready" && value.pendingAction === "The verification is not complete");
    expect(incomplete.deliveryReviewId).toBeNull();
    expect(h.calls.get("pushDeliveryBranch") ?? 0).toBe(0);
    expect(h.calls.get("publishRelease") ?? 0).toBe(0);
  } finally { await h.stop(); }
});
