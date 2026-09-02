import { join } from "node:path";
import { expect, test } from "vitest";

import { at } from "../src/issue-phases.js";
import { ApplicationFailure } from "../src/engine/failures.js";
import { executeIssueCommand, queryIssueWorkflow, signalIssueGithubPullRequestSync } from "../src/engine/service.js";
import { createEngineHarness, engineFixture, ImmediateClock, type EngineHarness } from "./helpers/engine-harness.js";

const head = "b".repeat(40), tree = "c".repeat(40), remoteHead = "d".repeat(40);

class FiveSecondClock extends ImmediateClock {
  private remaining = 5_000;
  private blocked!: () => void;
  readonly sleeping = new Promise<void>((resolve) => { this.blocked = resolve; });

  override async wait(milliseconds: number, signal: AbortSignal): Promise<void> {
    const elapsed = Math.min(milliseconds, this.remaining);
    this.remaining -= elapsed;
    await super.wait(elapsed, signal);
    if (this.remaining > 0) return;
    this.blocked();
    await new Promise<void>((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
  }
}

class FifteenSecondWindowClock extends ImmediateClock {
  private remaining = 15_000;
  private elapsed!: () => void;
  readonly windowElapsed = new Promise<void>((resolve) => { this.elapsed = resolve; });

  override async wait(milliseconds: number, signal: AbortSignal): Promise<void> {
    const elapsed = Math.min(milliseconds, this.remaining);
    this.remaining -= elapsed;
    await super.wait(elapsed, signal);
    if (this.remaining > 0) return;
    this.elapsed();
    await new Promise<void>((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
  }
}

function ciState(h: EngineHarness, issueId: string) {
  return { ...at("ci_waiting"), revision: 20, owner: "lead" as const, allowedCommands: ["cancel_issue" as const], pendingAction: "Waiting for CI", lastEventId: `${issueId}:20`, continuationCount: 0, lastSummaryHash: null, blocker: null, stateChangedAt: new Date(h.clock.now()).toISOString(), leadSessionRef: "lead-session", leadExecutionId: "lead-execution", leadOutputArtifactId: "plan", planRevision: 1, developerExecutionId: "developer", developerSessionRef: "developer-session", worktreePath: join(h.root, "worktrees", issueId), branchName: `forge/issue/${issueId}`, targetBaseSha: engineFixture.base, resultCommit: head, resultTree: tree, dirtyState: "clean" as const, deliveryArtifactId: "delivery", developerEvidenceArtifactId: "evidence", deliveryReviewId: "review", releaseId: `release-${issueId}`, releaseRepository: "acme/forge", pullRequestNumber: 42, pullRequestUrl: "https://github.test/42", expectedHeadSha: head, expectedHeadTree: tree, ciAttempt: 0, ciOutcome: "waiting" as const, ciNextPollAt: null };
}

test.each(["ci_waiting", "manual_merge", "releasing"] as const)("an unchanged %s shipping state does not re-project while it waits", async (step) => {
  const clock = new FiveSecondClock();
  let tooManyProjections!: () => void;
  const hotLoop = new Promise<void>((resolve) => { tooManyProjections = resolve; });
  let projections = 0;
  const h = await createEngineHarness({
    projectIssueState: async (event) => {
      projections += 1;
      if (projections >= 3) tooManyProjections();
      return event.state;
    },
    loadTaskSourcePullRequest: async () => null,
    observeGithubPullRequest: async () => ({ exists: true, number: 42, url: "https://github.test/42", state: "open", isDraft: false, headSha: head, baseSha: engineFixture.base, mergeable: "MERGEABLE", checks: { total: 1, pending: 1, failing: 0, successful: 0 }, autoMergeEnabled: false, reviewDecision: null }),
    reconcileCi: async (input) => ({ runId: "ci", attemptId: "pending", attemptNumber: input.attemptNumber, expectedHeadSha: input.expectedHeadSha, observedHeadSha: input.expectedHeadSha, evidenceArtifactId: "ci-evidence", outcome: "waiting", reason: "checks_pending", owner: "system", repairable: false, summary: "Waiting for CI", retryAt: new Date(Date.now() + 60_000).toISOString(), nextPollAt: null, policyHash: engineFixture.sha256, propagationDeadline: null, overallDeadline: null }),
  }, clock);
  h.seedTask(`unchanged-${step}`);
  try {
    const initial = { ...ciState(h, `unchanged-${step}`), ...at(step), releaseRepository: null, releaseRetryAt: step === "releasing" ? new Date(Date.now() + 15_000).toISOString() : null };
    const started = await h.startContinuation(`unchanged-${step}`, initial);
    const before = h.engine.run(started.workflowId).state.revision;
    const snapshotCountBefore = h.database.authQuery((db) => (db.prepare("SELECT count(*) AS count FROM forge_workflow_snapshots WHERE workflow_id = ?").get(started.workflowId) as { count: number }).count);
    const waitResult = await Promise.race([clock.sleeping.then(() => "sleeping"), hotLoop.then(() => "hot-loop")]);
    const after = h.engine.run(started.workflowId).state;
    const snapshots = h.database.authQuery((db) => (db.prepare("SELECT count(*) AS count FROM forge_workflow_snapshots WHERE workflow_id = ?").get(started.workflowId) as { count: number }).count);
    expect(waitResult).toBe("sleeping");
    expect(after.revision - before).toBeLessThanOrEqual(2);
    expect(snapshots - snapshotCountBefore).toBeLessThanOrEqual(2);
  } finally { await h.stop(); }
});

test("unchanged CI shipping observes GitHub once in a fifteen-second window", async () => {
  const clock = new FifteenSecondWindowClock();
  let observedTwice!: () => void;
  const duplicateObservation = new Promise<void>((resolve) => { observedTwice = resolve; });
  let observations = 0;
  const h = await createEngineHarness({
    observeGithubPullRequest: async () => {
      observations += 1;
      if (observations > 1) observedTwice();
      return { exists: true, number: 42, url: "https://github.test/42", state: "open", isDraft: false, headSha: head, baseSha: engineFixture.base, mergeable: "MERGEABLE", checks: { total: 1, pending: 1, failing: 0, successful: 0 }, autoMergeEnabled: false, reviewDecision: null };
    },
    reconcileCi: async (input) => ({ runId: "ci", attemptId: "pending", attemptNumber: input.attemptNumber, expectedHeadSha: input.expectedHeadSha, observedHeadSha: input.expectedHeadSha, evidenceArtifactId: "ci-evidence", outcome: "waiting", reason: "checks_pending", owner: "system", repairable: false, summary: "Waiting for CI", retryAt: null, nextPollAt: null, policyHash: engineFixture.sha256, propagationDeadline: null, overallDeadline: null }),
  }, clock);
  h.seedTask("unchanged-ci-observation");
  try {
    const started = await h.startContinuation("unchanged-ci-observation", ciState(h, "unchanged-ci-observation"), { deliveryTarget: "merged" });
    await h.settle(started.workflowId, (state) => state.step === "ci_waiting" && state.ciNextPollAt !== null);
    expect(await Promise.race([clock.windowElapsed.then(() => "window-elapsed"), duplicateObservation.then(() => "observed-twice")])).toBe("window-elapsed");
    expect(observations).toBe(1);
  } finally { await h.stop(); }
});

test("a GitHub authentication failure blocks CI after one observation", async () => {
  let observations = 0;
  const h = await createEngineHarness({
    observeGithubPullRequest: async () => {
      observations += 1;
      throw ApplicationFailure.nonRetryable("GitHub CLI authentication is unavailable", "authentication-required");
    },
  });
  h.seedTask("ci-authentication-failure");
  try {
    const started = await h.startContinuation("ci-authentication-failure", ciState(h, "ci-authentication-failure"), { deliveryTarget: "merged" });
    const blocked = await h.settle(started.workflowId, (state) => state.step === "ci_waiting" && state.owner === "human" && state.blocker?.category === "provider_authentication");
    expect(observations).toBe(1);
    expect(Date.parse(blocked.ciNextPollAt!)-h.clock.now()).toBe(60_000);
    expect(blocked).toMatchObject({ allowedCommands: expect.arrayContaining(["reconcile_ci", "cancel_issue"]), pendingAction: "GitHub sign-in is required to continue.", blocker: { category: "provider_authentication" } });
  } finally { await h.stop(); }
});

test("foreign PR head changes return reviewed work to delivery review", async () => {
  const h = await createEngineHarness({ projectIssueState: async (event) => event.state, observeGithubPullRequest: async () => ({ exists: true, number: 42, url: "https://github.test/42", state: "open", isDraft: false, headSha: remoteHead, baseSha: engineFixture.base, mergeable: "MERGEABLE", checks: { total: 1, pending: 0, failing: 0, successful: 1 }, autoMergeEnabled: false, reviewDecision: null }), reconcileMerge: async () => ({ outcome: "changed_head", observedHeadSha: remoteHead, mergeObservationId: "head-change", completionReceiptId: null, observedAt: new Date().toISOString(), mergedAt: null, retryAt: null, blockerCode: "head_changed", evidenceArtifactId: null, pullRequestNumber: 42, pullRequestUrl: "https://github.test/42" }) });
  h.seedTask("foreign-head");
  try {
    const started = await h.startContinuation("foreign-head", { ...ciState(h, "foreign-head"), ...at("manual_merge"), allowedCommands: ["reconcile_merge"], pendingAction: "Waiting for merge", acceptanceId: "acceptance" });
    const initial = await queryIssueWorkflow(h.config, started.workflowId);
    const changed = await executeIssueCommand(h.config, started.workflowId, "reconcile_merge", { expectedRevision: initial.revision, actorUserId: engineFixture.actorUserId });
    expect(changed).toMatchObject({ step: "delivery_ready", pendingAction: "Reviewing the latest changes", expectedHeadSha: remoteHead, resultCommit: remoteHead, blocker: null });
    expect(await executeIssueCommand(h.config, started.workflowId, "reconcile_merge", { expectedRevision: changed.revision, actorUserId: engineFixture.actorUserId })).toEqual(changed);
  } finally { await h.stop(); }
});

test("source pull request stays pre-delivery until an external merge is observed", async () => {
  let merged = false;
  const h = await createEngineHarness({ projectIssueState: async (event) => event.state, observeGithubPullRequest: async () => ({ exists: true, number: 1517, url: "https://github.test/1517", state: merged ? "merged" : "open", isDraft: false, headSha: head, baseSha: engineFixture.base, mergeable: "MERGEABLE", checks: { total: 1, pending: 0, failing: 0, successful: 1 }, autoMergeEnabled: false, reviewDecision: null }) });
  h.seedTask("source-pr");
  try {
    const source = { kind: "pull_request" as const, number: 1517, url: "https://github.test/1517", headBranch: "feat/imported", baseBranch: "main", headSha: head, baseSha: engineFixture.base };
    const started = await h.startContinuation("source-pr", { ...at("development"), revision: 5, owner: "human", allowedCommands: ["cancel_issue"], pendingAction: "Blocked delivery", lastEventId: "source-pr:5", continuationCount: 0, lastSummaryHash: null }, { repository: "acme/forge", source });
    await signalIssueGithubPullRequestSync(h.config, started.workflowId);
    expect(await h.settle(started.workflowId, (state) => state.pullRequestNumber === 1517)).toMatchObject({ step: "development", releaseRepository: "acme/forge", pullRequestNumber: 1517 });
    merged = true; await signalIssueGithubPullRequestSync(h.config, started.workflowId);
    expect(await h.settle(started.workflowId, (state) => state.step === "done")).toMatchObject({ step: "done", githubPullRequestState: "merged" });
  } finally { await h.stop(); }
});

test("a throwing guarded handler is projected and a later command still works", async () => {
  const projections: unknown[] = [];
  const h = await createEngineHarness({ projectIssueState: async (event) => { projections.push(structuredClone(event.state)); return event.state; }, reconcileTargetBase: async (input) => ({ outcome: "no_drift", checkId: `base-${input.checkpoint}`, checkpoint: input.checkpoint, expectedBaseSha: input.expectedBaseSha, observedBaseSha: input.expectedBaseSha, headSha: input.expectedHeadSha, headTree: input.expectedHeadTree }), acceptDelivery: async () => { throw ApplicationFailure.nonRetryable("Merge commits are disabled", "github-merge-method-rejected"); } });
  h.seedTask("guarded");
  try {
    const accepted = { ...ciState(h, "guarded"), ...at("accepted"), revision: 30, owner: "human" as const, allowedCommands: ["accept_delivery" as const, "request_delivery_changes" as const, "cancel_issue" as const], pendingAction: "Member acceptance required", finalReviewId: "final", finalReviewOutcome: "approved" as const };
    const started = await h.startContinuation("guarded", accepted, { pullRequestMode: "auto_merge", autoMergeActorUserId: engineFixture.actorUserId });
    const guarded = await executeIssueCommand(h.config, started.workflowId, "accept_delivery", { expectedRevision: (await queryIssueWorkflow(h.config, started.workflowId)).revision, actorUserId: engineFixture.actorUserId });
    expect(guarded).toMatchObject({ step: "accepted", lastHandlerError: { command: "accept_delivery" } });
    expect(projections.at(-1)).toMatchObject({ step: "accepted", revision: guarded.revision });
    const cancelled = await executeIssueCommand(h.config, started.workflowId, "cancel_issue", { expectedRevision: guarded.revision, actorUserId: engineFixture.actorUserId });
    expect(cancelled).toMatchObject({ phase: "cancelled" });
  } finally { await h.stop(); }
});

test("host restarts resume CI reconciliation from the same persisted phase", async () => {
  let polls = 0;
  const h = await createEngineHarness({ projectIssueState: async (event) => event.state, observeGithubPullRequest: async () => ({ exists: false, number: null, url: null, state: null, isDraft: null, headSha: null, baseSha: null, mergeable: "UNKNOWN", checks: { total: 0, pending: 0, failing: 0, successful: 0 }, autoMergeEnabled: false, reviewDecision: null }), reconcileCi: async (input) => ({ runId: "ci", attemptId: `attempt-${++polls}`, attemptNumber: input.attemptNumber, expectedHeadSha: input.expectedHeadSha, observedHeadSha: input.expectedHeadSha, evidenceArtifactId: "ci-evidence", outcome: "passed", reason: "checks_passed_merged", owner: null, repairable: false, summary: "Merged", retryAt: null, nextPollAt: null, policyHash: engineFixture.sha256, propagationDeadline: null, overallDeadline: null }) });
  h.seedTask("restart-ci");
  try {
  h.activities.projectIssueState = async (event) => { h.database.projectIssueEvents([event]); return event.state; };
    const blocked = { ...ciState(h, "restart-ci"), ...at("ci_waiting"), owner: "human" as const, allowedCommands: ["reconcile_ci" as const, "cancel_issue" as const], pendingAction: "Retry CI" };
    const started = await h.startContinuation("restart-ci", blocked);
    const waiting = await queryIssueWorkflow(h.config, started.workflowId);
    await h.restart();
    const restarted = await queryIssueWorkflow(h.config, started.workflowId);
    expect(restarted).toMatchObject({ phase: waiting.phase });
    expect(restarted.revision).toBeGreaterThan(waiting.revision);
    const resumed = await executeIssueCommand(h.config, started.workflowId, "reconcile_ci", { expectedRevision: restarted.revision, actorUserId: engineFixture.actorUserId });
    expect(resumed.revision).toBeGreaterThan(waiting.revision); expect(resumed.lastHandlerError).toBeFalsy(); expect(polls).toBe(1);
  } finally { await h.stop(); }
});
