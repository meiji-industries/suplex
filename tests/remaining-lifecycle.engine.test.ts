import { join } from "node:path";
import { expect, test } from "vitest";
import { ApplicationFailure } from "../src/engine/failures.js";
import type { IssueWorkflowInput } from "../src/engine/issue-contracts.js";
import { executeIssueCommand, queryIssueWorkflow, resyncIssueProjection, signalIssueGithubPullRequestSync, startIssueWorkflow } from "../src/engine/service.js";
import { createEngineHarness, engineFixture, type EngineHarness } from "./helpers/engine-harness.js";

const head = "b".repeat(40), tree = "c".repeat(40), remoteHead = "d".repeat(40);

function startInput(_h: EngineHarness, issueId: string, continuationState: IssueWorkflowInput["continuationState"], extra: Partial<IssueWorkflowInput> = {}) {
  return { companyId: engineFixture.companyId, projectId: engineFixture.projectId, issueId, projectRevisionId: engineFixture.projectRevisionId, briefArtifactId: engineFixture.briefArtifactId, briefSha256: engineFixture.sha256, imageArtifactIds: [], roleProfiles: engineFixture.roleProfiles, supplementalReview: false, continuationState, ...extra };
}

function ciState(h: EngineHarness, issueId: string) {
  return { phase: "ci_waiting" as const, revision: 20, owner: "lead" as const, allowedCommands: ["cancel_issue" as const], pendingAction: "Waiting for CI", lastEventId: `${issueId}:20`, continuationCount: 0, lastSummaryHash: null, blocker: null, stateChangedAt: new Date(h.clock.now()).toISOString(), leadSessionRef: "lead-session", leadExecutionId: "lead-execution", leadOutputArtifactId: "plan", planRevision: 1, developerExecutionId: "developer", developerSessionRef: "developer-session", worktreePath: join(h.root, "worktrees", issueId), branchName: `forge/issue/${issueId}`, targetBaseSha: engineFixture.base, resultCommit: head, resultTree: tree, dirtyState: "clean" as const, deliveryArtifactId: "delivery", developerEvidenceArtifactId: "evidence", deliveryReviewId: "review", releaseId: `release-${issueId}`, releaseRepository: "acme/forge", pullRequestNumber: 42, pullRequestUrl: "https://github.test/42", expectedHeadSha: head, expectedHeadTree: tree, ciAttempt: 0, ciOutcome: "waiting" as const, ciNextPollAt: null };
}

test("foreign PR head changes return reviewed work to delivery review", async () => {
  const h = await createEngineHarness({ projectIssueState: async (event) => event.state, observeGithubPullRequest: async () => ({ exists: true, number: 42, url: "https://github.test/42", state: "open", isDraft: false, headSha: remoteHead, baseSha: engineFixture.base, mergeable: "MERGEABLE", checks: { total: 1, pending: 0, failing: 0, successful: 1 }, autoMergeEnabled: false, reviewDecision: null }), reconcileMerge: async () => ({ outcome: "changed_head", observedHeadSha: remoteHead, mergeObservationId: "head-change", completionReceiptId: null, observedAt: new Date().toISOString(), mergedAt: null, retryAt: null, blockerCode: "head_changed", evidenceArtifactId: null, pullRequestNumber: 42, pullRequestUrl: "https://github.test/42" }) });
  h.seedTask("foreign-head");
  try {
    const started = await startIssueWorkflow(h.config, startInput(h, "foreign-head", { ...ciState(h, "foreign-head"), phase: "manual_merge", allowedCommands: ["reconcile_merge"], pendingAction: "Waiting for merge", acceptanceId: "acceptance" }));
    const initial = await queryIssueWorkflow(h.config, started.workflowId);
    const changed = await executeIssueCommand(h.config, started.workflowId, "reconcile_merge", { expectedRevision: initial.revision, actorUserId: engineFixture.actorUserId });
    expect(changed).toMatchObject({ phase: "delivery_ready", pendingAction: "Reviewing the latest changes", expectedHeadSha: remoteHead, resultCommit: remoteHead, blocker: null });
    expect(await executeIssueCommand(h.config, started.workflowId, "reconcile_merge", { expectedRevision: changed.revision, actorUserId: engineFixture.actorUserId })).toEqual(changed);
  } finally { await h.stop(); }
});

test("source pull request stays pre-delivery until an external merge is observed", async () => {
  let merged = false;
  const h = await createEngineHarness({ projectIssueState: async (event) => event.state, observeGithubPullRequest: async () => ({ exists: true, number: 1517, url: "https://github.test/1517", state: merged ? "merged" : "open", isDraft: false, headSha: head, baseSha: engineFixture.base, mergeable: "MERGEABLE", checks: { total: 1, pending: 0, failing: 0, successful: 1 }, autoMergeEnabled: false, reviewDecision: null }) });
  h.seedTask("source-pr");
  try {
    const source = { kind: "pull_request" as const, number: 1517, url: "https://github.test/1517", headBranch: "feat/imported", baseBranch: "main", headSha: head, baseSha: engineFixture.base };
    const started = await startIssueWorkflow(h.config, startInput(h, "source-pr", { phase: "delivery_blocked", revision: 5, owner: "human", allowedCommands: ["cancel_issue"], pendingAction: "Blocked delivery", lastEventId: "source-pr:5", continuationCount: 0, lastSummaryHash: null }, { repository: "acme/forge", source }));
    await signalIssueGithubPullRequestSync(h.config, started.workflowId);
    expect(await queryIssueWorkflow(h.config, started.workflowId)).toMatchObject({ phase: "delivery_blocked", releaseRepository: "acme/forge", pullRequestNumber: 1517 });
    merged = true; await signalIssueGithubPullRequestSync(h.config, started.workflowId);
    expect(await h.settle(started.workflowId, (state) => state.phase === "done")).toMatchObject({ phase: "done", githubPullRequestState: "merged" });
  } finally { await h.stop(); }
});

test("a throwing guarded handler is projected and a later command still works", async () => {
  const projections: unknown[] = [];
  const h = await createEngineHarness({ projectIssueState: async (event) => { projections.push(structuredClone(event.state)); return event.state; }, reconcileTargetBase: async (input) => ({ outcome: "no_drift", checkId: `base-${input.checkpoint}`, checkpoint: input.checkpoint, expectedBaseSha: input.expectedBaseSha, observedBaseSha: input.expectedBaseSha, headSha: input.expectedHeadSha, headTree: input.expectedHeadTree }), acceptDelivery: async () => { throw ApplicationFailure.nonRetryable("Merge commits are disabled", "github-merge-method-rejected"); } });
  h.seedTask("guarded");
  try {
    const accepted = { ...ciState(h, "guarded"), phase: "accepted" as const, revision: 30, owner: "human" as const, allowedCommands: ["accept_delivery" as const, "request_delivery_changes" as const, "cancel_issue" as const], pendingAction: "Member acceptance required", finalReviewId: "final", finalReviewOutcome: "approved" as const };
    const started = await startIssueWorkflow(h.config, startInput(h, "guarded", accepted, { pullRequestMode: "auto_merge", autoMergeActorUserId: engineFixture.actorUserId }));
    const guarded = await executeIssueCommand(h.config, started.workflowId, "accept_delivery", { expectedRevision: 30, actorUserId: engineFixture.actorUserId });
    expect(guarded).toMatchObject({ phase: "accepted", lastHandlerError: { command: "accept_delivery" } });
    expect(projections.at(-1)).toMatchObject({ phase: "accepted", revision: guarded.revision });
    const cancelled = await executeIssueCommand(h.config, started.workflowId, "cancel_issue", { expectedRevision: guarded.revision, actorUserId: engineFixture.actorUserId });
    expect(cancelled).toMatchObject({ phase: "cancelled" });
  } finally { await h.stop(); }
});

test("host restarts resume CI reconciliation from the same persisted phase", async () => {
  let polls = 0;
  const h = await createEngineHarness({ projectIssueState: async (event) => event.state, observeGithubPullRequest: async () => ({ exists: false, number: null, url: null, state: null, isDraft: null, headSha: null, baseSha: null, mergeable: "UNKNOWN", checks: { total: 0, pending: 0, failing: 0, successful: 0 }, autoMergeEnabled: false, reviewDecision: null }), reconcileCi: async (input) => ({ runId: "ci", attemptId: `attempt-${++polls}`, attemptNumber: input.attemptNumber, expectedHeadSha: input.expectedHeadSha, observedHeadSha: input.expectedHeadSha, evidenceArtifactId: "ci-evidence", outcome: "passed", reason: "checks_passed_merged", owner: null, repairable: false, summary: "Merged", retryAt: null, nextPollAt: null, policyHash: engineFixture.sha256, propagationDeadline: null, overallDeadline: null }) });
  h.seedTask("restart-ci");
  try {
    h.activities.projectIssueState = async (event) => { h.database.projectIssueEvent(event); h.database.observeIssueProjection(event); return event.state; };
    const blocked = { ...ciState(h, "restart-ci"), phase: "delivery_blocked" as const, owner: "human" as const, allowedCommands: ["reconcile_ci" as const, "cancel_issue" as const], pendingAction: "Retry CI" };
    const started = await startIssueWorkflow(h.config, startInput(h, "restart-ci", blocked));
    const waiting = await resyncIssueProjection(h.config, started.workflowId, { expectedRevision: blocked.revision, actorUserId: engineFixture.actorUserId });
    await h.restart();
    expect(await queryIssueWorkflow(h.config, started.workflowId)).toMatchObject({ phase: waiting.phase, revision: waiting.revision });
    const resumed = await executeIssueCommand(h.config, started.workflowId, "reconcile_ci", { expectedRevision: waiting.revision, actorUserId: engineFixture.actorUserId });
    expect(resumed.revision).toBeGreaterThan(waiting.revision); expect(resumed.lastHandlerError).toBeFalsy(); expect(polls).toBe(1);
  } finally { await h.stop(); }
});

