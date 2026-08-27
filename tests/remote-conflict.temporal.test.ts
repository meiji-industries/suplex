import { join } from "node:path";

import { expect, test } from "vitest";

import { connectTemporal, queryIssueWorkflow, startIssueWorkflow } from "../src/temporal/service.js";
import { issueUpdates } from "../src/temporal/issue-updates.js";
import { createTemporalHarness, type TemporalHarness } from "./helpers/temporal-harness.js";

const base = "a".repeat(40);
const head = "b".repeat(40);
const tree = "c".repeat(40);
const remoteHead = "d".repeat(40);
const resolvedHead = "e".repeat(40);
const resolvedTree = "f".repeat(40);
const sha256 = "9".repeat(64);

function continuation(h: TemporalHarness, issueId: string) {
  return {
    phase: "ci_waiting" as const,
    revision: 20,
    owner: "lead" as const,
    allowedCommands: ["cancel_issue" as const],
    pendingAction: "Waiting for CI",
    lastEventId: `${issueId}:20`,
    continuationCount: 0,
    lastSummaryHash: null,
    blocker: null,
    stateChangedAt: new Date().toISOString(),
    leadSessionRef: "lead-session-original",
    leadExecutionId: "lead-execution-original",
    leadOutputArtifactId: h.artifacts.integrationLeadOutputArtifactId,
    planRevision: 1,
    developerExecutionId: "developer-execution-original",
    developerSessionRef: "developer-session-original",
    worktreePath: join(h.root, "worktrees", issueId),
    branchName: `forge/issue/${issueId}`,
    targetBaseSha: base,
    resultCommit: head,
    resultTree: tree,
    dirtyState: "clean" as const,
    deliveryArtifactId: "delivery-original",
    developerEvidenceArtifactId: "developer-evidence-original",
    releaseId: `release-${issueId}`,
    pullRequestNumber: 42,
    pullRequestUrl: "https://github.com/acme/forge/pull/42",
    expectedHeadSha: head,
    expectedHeadTree: tree,
    ciAttempt: 0,
    ciOutcome: "waiting" as const,
    ciNextPollAt: null,
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

async function integrateRemoteConflict(h: TemporalHarness, workflowId: string, command: { expectedRevision: number; actorUserId: string; commandId: string; forwardMergeId: string; priorHead: string; priorTree: string; remoteHead: string; conflictArtifact: { id: string; kind: "forward-merge-conflict" }; conflictFileCount: number }) {
  const temporal = await connectTemporal(h.config);
  try {
    await temporal.client.workflow.getHandle(workflowId).executeUpdate(issueUpdates.integrate_remote_conflict, { args: [command], updateId: command.commandId });
  } finally {
    await temporal.connection.close();
  }
}

test("remote conflict enters and completes merge resolution", { timeout: 120_000 }, async () => {
  const h = createTemporalHarness();
  const projected: Array<Awaited<ReturnType<typeof queryIssueWorkflow>>> = [];
  h.activityOverrides.set("planMergeConflict", async (input) => ({
    disposition: "mechanical" as const,
    planId: "remote-merge-plan",
    planArtifactId: "remote-merge-plan-artifact",
    evidenceArtifactId: "remote-merge-plan-evidence",
    leadExecutionId: "remote-merge-lead-execution",
    leadSessionRef: input.leadSessionRef,
    summary: "Apply the remote merge resolution.",
  }));
  h.activityOverrides.set("resolveMergeConflictSupervised", async () => ({
    status: "completed" as const,
    resultHash: sha256,
    result: {
      developerExecutionId: "remote-merge-developer-execution",
      developerSessionRef: "remote-merge-developer-session",
      resultCommit: resolvedHead,
      resultTree: resolvedTree,
      deliveryArtifactId: "remote-merge-delivery-artifact",
      deliveryArtifactSha256: sha256,
      evidenceArtifactId: "remote-merge-evidence-artifact",
      evidenceArtifactSha256: sha256,
      verificationArtifactId: "remote-merge-verification-artifact",
      verificationArtifactSha256: sha256,
      summary: "Resolved the remote branch conflict.",
    },
  }));
  h.activityOverrides.set("projectIssueState", async (event) => {
    projected.push(event.state);
    return event.state;
  });
  await h.start();
  try {
    const issueId = "remote-conflict";
    const started = await startIssueWorkflow(h.config, {
      companyId: "issue-company",
      projectId: "issue-project",
      issueId,
      projectRevisionId: "issue-revision",
      briefArtifactId: "issue-brief",
      briefSha256: "0".repeat(64),
      imageArtifactIds: [],
      roleProfiles: h.issueRoleProfiles,
      supplementalReview: false,
      continuationState: continuation(h, issueId),
    });
    const initial = await queryIssueWorkflow(h.config, started.workflowId);
    const command = {
      expectedRevision: initial.revision,
      actorUserId: "issue-admin",
      commandId: "remote-conflict-command",
      forwardMergeId: "remote-forward-merge",
      priorHead: head,
      priorTree: tree,
      remoteHead,
      conflictArtifact: { id: "remote-conflict-artifact", kind: "forward-merge-conflict" as const },
      conflictFileCount: 2,
    };

    await integrateRemoteConflict(h, started.workflowId, command);
    await waitForPhase(h, started.workflowId, "delivery_ready");
    const conflicted = projected.find((state) => state.phase === "merge_conflict_required");
    const settled = projected.find((state) => state.phase === "delivery_ready");
    expect(conflicted).toMatchObject({
      phase: "merge_conflict_required",
      forwardMergeConflictArtifact: command.conflictArtifact,
      forwardMergeConflictFileCount: command.conflictFileCount,
      forwardMergeId: command.forwardMergeId,
      forwardMergePriorHead: head,
      forwardMergePriorTree: tree,
      forwardMergeTargetBaseSha: remoteHead,
    });
    expect(settled).toMatchObject({ phase: "delivery_ready", resultCommit: resolvedHead, resultTree: resolvedTree });

    const current = await queryIssueWorkflow(h.config, started.workflowId);
    await integrateRemoteConflict(h, started.workflowId, { ...command, expectedRevision: current.revision });
    expect(projected.filter((state) => state.phase === "merge_conflict_required")).toHaveLength(1);
  } finally {
    await h.stop();
  }
});
