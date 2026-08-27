import { join } from "node:path";

import { expect, test } from "vitest";

import { executeIssueCommand, queryIssueWorkflow, startIssueWorkflow } from "../src/temporal/service.js";
import { createTemporalHarness, type TemporalHarness } from "./helpers/temporal-harness.js";

const base = "a".repeat(40);
const head = "b".repeat(40);
const tree = "c".repeat(40);
const resolvedHead = "d".repeat(40);
const resolvedTree = "e".repeat(40);
const sha256 = "f".repeat(64);

function continuation(h: TemporalHarness, issueId: string) {
  return {
    phase: "merge_conflict_required" as const,
    revision: 20,
    owner: "lead" as const,
    allowedCommands: ["resolve_merge_conflict" as const, "cancel_issue" as const],
    pendingAction: "Resolving the conflict",
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
    forwardMergeId: `forward-merge-${issueId}`,
    forwardMergePriorHead: head,
    forwardMergePriorTree: tree,
    forwardMergeTargetBaseSha: base,
    forwardMergeConflictArtifact: { id: "conflict-artifact", kind: "forward-merge-conflict" as const },
    forwardMergeConflictFileCount: 1,
  };
}

async function startConflict(h: TemporalHarness, issueId: string) {
  return startIssueWorkflow(h.config, {
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
}

async function waitFor(h: TemporalHarness, workflowId: string, predicate: (state: Awaited<ReturnType<typeof queryIssueWorkflow>>) => boolean) {
  let state = await queryIssueWorkflow(h.config, workflowId);
  for (let attempt = 0; attempt < 100 && !predicate(state); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    state = await queryIssueWorkflow(h.config, workflowId);
  }
  return state;
}

async function stableState(h: TemporalHarness, workflowId: string) {
  let previous = await queryIssueWorkflow(h.config, workflowId);
  for (let attempt = 0; attempt < 100; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    const current = await queryIssueWorkflow(h.config, workflowId);
    if (JSON.stringify(current) === JSON.stringify(previous)) return current;
    previous = current;
  }
  return previous;
}

function mechanicalPlan(input: { leadSessionRef: string }) {
  return {
    disposition: "mechanical" as const,
    planId: "merge-plan",
    planArtifactId: "merge-plan-artifact",
    evidenceArtifactId: "merge-plan-evidence",
    leadExecutionId: "merge-lead-execution",
    leadSessionRef: input.leadSessionRef,
    summary: "Apply the mechanical merge resolution.",
  };
}

function completedResolution() {
  return {
    status: "completed" as const,
    resultHash: sha256,
    result: {
      developerExecutionId: "merge-developer-execution",
      developerSessionRef: "merge-developer-session",
      resultCommit: resolvedHead,
      resultTree: resolvedTree,
      deliveryArtifactId: "merge-delivery-artifact",
      deliveryArtifactSha256: sha256,
      evidenceArtifactId: "merge-evidence-artifact",
      evidenceArtifactSha256: sha256,
      verificationArtifactId: "merge-verification-artifact",
      verificationArtifactSha256: sha256,
      summary: "Resolved the forward merge conflict.",
    },
  };
}

test("remote branch integration conflicts and auto-enters resolution", { timeout: 120_000 }, async () => {
  const h = createTemporalHarness();
  const planInputs: Array<{ leadSessionRef: string; operatorNotes?: string[] }> = [];
  const projectedPhases: string[] = [];
  let resolutions = 0;
  h.activityOverrides.set("planMergeConflict", async (input) => {
    planInputs.push(input);
    return mechanicalPlan(input);
  });
  h.activityOverrides.set("resolveMergeConflictSupervised", async () => {
    resolutions += 1;
    return completedResolution();
  });
  h.activityOverrides.set("projectIssueState", async (event) => {
    projectedPhases.push(event.state.phase);
    return event.state;
  });
  await h.start();
  try {
    const started = await startConflict(h, "merge-auto-resolution");
    const settled = await waitFor(h, started.workflowId, () => projectedPhases.includes("delivery_ready"));

    expect(projectedPhases).toContain("delivery_ready");
    expect(settled).toMatchObject({ resultCommit: resolvedHead, resultTree: resolvedTree });
    expect(planInputs).toHaveLength(1);
    expect(resolutions).toBe(1);
    expect(await stableState(h, started.workflowId)).toEqual(await stableState(h, started.workflowId));
  } finally {
    await h.stop();
  }
});

test("planner note answers a merge decision on the same lead session", { timeout: 120_000 }, async () => {
  const h = createTemporalHarness();
  const planInputs: Array<{ leadSessionRef: string; operatorNotes?: string[] }> = [];
  let mechanical = false;
  const projectedPhases: string[] = [];
  h.activityOverrides.set("planMergeConflict", async (input) => {
    planInputs.push(input);
    if (mechanical) return mechanicalPlan(input);
    return {
      disposition: "product_decision" as const,
      planId: "merge-decision-plan",
      planArtifactId: "merge-decision-artifact",
      evidenceArtifactId: "merge-decision-evidence",
      leadExecutionId: "merge-decision-lead",
      leadSessionRef: input.leadSessionRef,
      summary: "Choose which behavior should win.",
      question: "Which behavior should win?",
      choices: [{ id: "preserve-local", label: "Preserve local behavior", detail: "Keep Forge's existing behavior." }, { id: "accept-remote", label: "Accept remote behavior", detail: "Adopt the behavior from the remote branch." }],
      recommendedChoiceId: "preserve-local",
    };
  });
  h.activityOverrides.set("resolveMergeConflictSupervised", async () => completedResolution());
  h.activityOverrides.set("recordPlannerNote", async (input) => ({ noteId: `planner_note_${input.commandId}`, createdAt: new Date().toISOString() }));
  h.activityOverrides.set("projectIssueState", async (event) => {
    projectedPhases.push(event.state.phase);
    return event.state;
  });
  await h.start();
  try {
    const started = await startConflict(h, "merge-planner-note");
    const decision = await waitFor(h, started.workflowId, (state) => state.phase === "merge_conflict_required" && state.owner === "human");
    expect(decision).toMatchObject({
      owner: "human",
      mergeDecision: { question: "Which behavior should win?", choices: [{ id: "preserve-local" }, { id: "accept-remote" }], recommendedChoiceId: "preserve-local" },
      blocker: { category: "member_decision", actions: expect.arrayContaining([expect.objectContaining({ label: "Choose a behavior" })]) },
    });
    if (!decision.mergeDecision) return;

    mechanical = true;
    const note = "Preserve local behavior";
    await executeIssueCommand(h.config, started.workflowId, "send_planner_note", {
      expectedRevision: decision.revision,
      actorUserId: "issue-admin",
      note,
      commandId: "merge-planner-note-choice",
    });
    await executeIssueCommand(h.config, started.workflowId, "send_planner_note", {
      expectedRevision: decision.revision,
      actorUserId: "issue-admin",
      note,
      commandId: "merge-planner-note-choice",
    });
    await waitFor(h, started.workflowId, () => projectedPhases.includes("delivery_ready"));

    expect(projectedPhases).toContain("delivery_ready");
    expect(planInputs).toHaveLength(2);
    expect(planInputs[1]).toMatchObject({ leadSessionRef: planInputs[0]!.leadSessionRef, operatorNotes: [note] });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(planInputs).toHaveLength(2);
  } finally {
    await h.stop();
  }
});
