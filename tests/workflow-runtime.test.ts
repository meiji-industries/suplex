import { expect, test } from "vitest";

import { buildInitialIssueWorkflowState, type IssueWorkflowState } from "../src/temporal/issue-contracts.js";
import { createAcquireExternalTurn } from "../src/temporal/workflow/runtime.js";

test("simple capacity admission preserves the current pending action", async () => {
  let state: IssueWorkflowState = {
    ...buildInitialIssueWorkflowState({
      workflowId: "workflow-simple-capacity",
      companyId: "company-simple-capacity",
      projectId: "project-simple-capacity",
      issueId: "task-simple-capacity",
      projectRevisionId: "revision-simple-capacity",
      briefArtifactId: "brief-simple-capacity",
      briefSha256: "a".repeat(64),
      imageArtifactIds: [],
      requestHash: "b".repeat(64),
      roleProfiles: {},
      supplementalReview: false,
    }),
    phase: "planning",
    owner: "lead",
    pendingAction: "Lead planning",
  };
  const projected: IssueWorkflowState[] = [];
  const acquireExternalTurn = createAcquireExternalTurn(
    {
      get: () => state,
      set: (next) => {
        state = next;
      },
    },
    {
      patched: (patchId) => patchId === "forge-simple-capacity-v1",
      projectState: async (next) => {
        projected.push(next);
        return next;
      },
      projectCapacityState: async () => state.revision,
      durableCapacityPatch: "forge-durable-capacity-v1",
      capacityFinalizationOwnershipPatch: "forge-capacity-finalization-ownership-v1",
      capacityReadmissionPatch: "forge-capacity-readmission-v1",
    },
  );

  await expect(acquireExternalTurn(
    { operation: "lead_planning", role: "planner" },
    async (capacityRequestId) => capacityRequestId,
    () => undefined,
  )).resolves.toBeUndefined();

  expect(state).toMatchObject({
    revision: 1,
    lastEventId: "workflow-simple-capacity:1",
    pendingAction: "Lead planning",
  });
  expect(projected).toEqual([state]);
});
