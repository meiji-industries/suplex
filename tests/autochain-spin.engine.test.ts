import { expect, test } from "vitest";

import { buildInitialIssueWorkflowState } from "../src/engine/issue-contracts.js";
import { executeIssueCommand } from "../src/engine/service.js";
import { createEngineHarness, engineFixture } from "./helpers/engine-harness.js";

test("a no-progress merge-conflict auto-chain becomes a human action", async () => {
  const h = await createEngineHarness({ projectIssueState: async (event) => event.state });
  h.seedTask("autochain-no-progress");
  try {
    const continuationState = {
      ...buildInitialIssueWorkflowState({ workflowId: h.workflowId("autochain-no-progress"), companyId: engineFixture.companyId, projectId: engineFixture.projectId, issueId: "autochain-no-progress", projectRevisionId: engineFixture.projectRevisionId, briefArtifactId: engineFixture.briefArtifactId, briefSha256: engineFixture.sha256, imageArtifactIds: [], requestHash: engineFixture.sha256, roleProfiles: engineFixture.roleProfiles, supplementalReview: false, repairCycleLimit: 2 }),
      phase: "merge_conflict_required" as const,
      revision: 7,
      owner: "lead" as const,
      allowedCommands: ["resolve_merge_conflict" as const, "cancel_issue" as const],
      pendingAction: "Developer conflict resolution requires the Lead plan",
      lastEventId: `${h.workflowId("autochain-no-progress")}:7`,
    };
    const started = await h.startContinuation("autochain-no-progress", continuationState);
    const state = await h.settle(started.workflowId, (next) => next.owner === "human" && next.revision >= 13 && (next.processedCommandIds?.length ?? 0) >= 2);

    expect(state).toMatchObject({ phase: "merge_conflict_required", owner: "human", lastHandlerError: { command: "resolve_merge_conflict", reason: "Automatic resolve merge conflict made no progress" } });
    const retried = await executeIssueCommand(h.config, started.workflowId, "resolve_merge_conflict", { expectedRevision: state.revision, actorUserId: engineFixture.actorUserId });
    // A human command clears the automatic-chain halt. This task still cannot
    // resolve without an owned Developer execution, so its own handler returns
    // it to the human with a fresh blocker.
    expect(retried).toMatchObject({
      phase: "merge_conflict_required",
      owner: "human",
      lastHandlerError: { command: "resolve_merge_conflict", reason: "An owned Developer execution and forward-merge evidence are required" },
    });
    expect(retried.revision).toBeGreaterThan(state.revision);
  } finally { await h.stop(); }
});
