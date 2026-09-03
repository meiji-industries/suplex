import { expect, test } from "vitest";

import { at, isBlocked } from "../src/issue-phases.js";

import { buildInitialIssueWorkflowState, type IssueActivities } from "../src/engine/issue-contracts.js";
import { executeIssueCommand } from "../src/engine/service.js";
import { createEngineHarness, engineFixture } from "./helpers/engine-harness.js";

test("a failed automatic merge-conflict resolver stops for a human retry", async () => {
  const phases: string[] = [];
  const activities: Partial<IssueActivities> = {
    projectIssueState: async (event) => {
      phases.push(event.state.step);
      return event.state;
    },
    planMergeConflict: async () => ({
      disposition: "mechanical",
      planId: "conflict-plan",
      planArtifactId: "conflict-plan-artifact",
      evidenceArtifactId: "conflict-evidence",
      leadExecutionId: "integrator-plan",
      leadSessionRef: "lead-session",
      summary: "Resolve the conflict",
    }),
    resolveMergeConflictSupervised: async () => ({
      status: "failed" as const,
      developerExecutionId: "developer-resolution",
      reasonCode: "ownership_lost",
      summary: "Resolver lost merge ownership",
      evidenceArtifactId: null,
    }),
  };
  const h = await createEngineHarness(activities);
  h.seedTask("autochain-no-progress");
  try {
    const workflowId = h.workflowId("autochain-no-progress");
    const continuationState = {
      ...buildInitialIssueWorkflowState({ workflowId, companyId: engineFixture.companyId, projectId: engineFixture.projectId, issueId: "autochain-no-progress", projectRevisionId: engineFixture.projectRevisionId, briefArtifactId: engineFixture.briefArtifactId, briefSha256: engineFixture.sha256, imageArtifactIds: [], requestHash: engineFixture.sha256, roleProfiles: engineFixture.roleProfiles, supplementalReview: false, repairCycleLimit: 2 }),
      ...at("merge_conflict_resolving"),
      revision: 7,
      owner: "lead" as const,
      allowedCommands: ["resolve_merge_conflict" as const, "cancel_issue" as const],
      pendingAction: "The Builder waits for the Planner conflict plan",
      lastEventId: `${workflowId}:7`,
      leadSessionRef: "lead-session",
      leadOutputArtifactId: "lead-plan",
      planRevision: 1,
      developerExecutionId: "developer-original",
      developerSessionRef: "developer-session",
      worktreePath: h.root,
      branchName: "forge/issue/autochain-no-progress",
      targetBaseSha: engineFixture.base,
      forwardMergeId: "forward-merge",
      forwardMergePriorHead: engineFixture.commit,
      forwardMergePriorTree: engineFixture.tree,
      forwardMergeTargetBaseSha: engineFixture.base,
      forwardMergeConflictArtifact: { id: "conflict", kind: "forward-merge-conflict" as const },
      forwardMergeConflictFileCount: 1,
    };
    const started = await h.startContinuation("autochain-no-progress", continuationState);
    let observedHumanState = 0;
    const state = await h.settle(started.workflowId, (next) => isBlocked(next) && next.step === "merge_conflict_resolving" && next.owner === "human" && ++observedHumanState > 50);

    expect(phases).toEqual(expect.arrayContaining(["merge_conflict_resolving"]));
    expect(h.calls.get("resolveMergeConflictSupervised")).toBe(1);
    expect(state).toMatchObject({
      step: "merge_conflict_resolving",
      owner: "human",
      allowedCommands: expect.arrayContaining(["resolve_merge_conflict", "cancel_issue"]),
      pendingAction: "Resolver lost merge ownership",
    });

    const retried = await executeIssueCommand(h.config, started.workflowId, "resolve_merge_conflict", { expectedRevision: state.revision, actorUserId: engineFixture.actorUserId });

    expect(h.calls.get("resolveMergeConflictSupervised")).toBe(2);
    expect(retried).toMatchObject({ step: "merge_conflict_resolving", owner: "human" });
  } finally {
    await h.stop();
  }
});
